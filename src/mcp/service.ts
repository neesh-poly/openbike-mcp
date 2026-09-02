import {
  findCatalogSystems,
  getCatalogSystem,
  getSystemFeedStub,
  loadCatalog,
} from "../catalog";
import type {
  CatalogCandidate,
  CatalogSnapshot,
  CatalogSystem,
} from "../catalog";
import { runtimeConfig, SERVICE_VERSION } from "../config";
import {
  FeedHealthSchema,
  FindStationsInputSchema,
  FindStationsOutputSchema,
  FindSystemsInputSchema,
  FindSystemsOutputSchema,
  GetNearbyAvailabilityInputSchema,
  GetNearbyAvailabilityOutputSchema,
  GetStationInputSchema,
  GetStationOutputSchema,
  GetSystemHealthInputSchema,
  GetSystemHealthOutputSchema,
  type ErrorCode,
  type FindStationsInput,
  type FindStationsOutput,
  type FindSystemsInput,
  type FindSystemsOutput,
  type Freshness,
  type GetNearbyAvailabilityInput,
  type GetNearbyAvailabilityOutput,
  type GetStationInput,
  type GetStationOutput,
  type GetSystemHealthInput,
  type GetSystemHealthOutput,
  type SourceAttribution,
  type Station,
  type System,
  type SystemSummary,
  type Warning,
  DomainError,
  decodeCursor,
  encodeCursor,
  fingerprintQuery,
} from "../contracts";
import {
  determineAvailabilityConfidence,
  distanceToStationMeters,
  evaluateFreshness,
  filterStationSearchCandidates,
  joinStationsWithStatus,
  relevantAvailabilityCount,
  sanitizeProviderText,
  selectNearbyCandidates,
  type AvailabilityCandidate,
  type NearbySelectionOptions,
  type StationSearchCandidate,
} from "../domain";
import type {
  AvailabilityQuery,
  SystemFeedAvailabilityResult,
  SystemFeedHealth,
} from "../durable";
import { readProbeDiscoveryMetadata } from "../status";
import type { ProbeDiscoveryMetadata } from "../status";

const DEFAULT_REQUEST_DEADLINE_MS = 15_000;
const DEFAULT_LIVE_STALENESS_SECONDS = 300;
const MAX_WARNINGS = 100;

export interface SystemFeedClient {
  getAvailability(
    query?: AvailabilityQuery,
  ): Promise<SystemFeedAvailabilityResult>;
  getHealth(catalogSystem?: CatalogSystem): Promise<SystemFeedHealth>;
}

export interface OpenBikeServiceDependencies {
  loadCatalog(): Promise<CatalogSnapshot>;
  loadProbeDiscoveryMetadata?(
    catalogVersion: string,
    systemIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProbeDiscoveryMetadata>>;
  feedForSystem(system: CatalogSystem): SystemFeedClient;
  requestId: string;
  workerVersion: string;
  maxCandidateSystems: number;
  now?: () => Date;
  requestDeadlineMs?: number;
}

interface SnapshotSuccess {
  candidate: CatalogCandidate;
  snapshot: SystemFeedAvailabilityResult;
}

interface SnapshotFailure {
  candidate: CatalogCandidate;
  code: ErrorCode;
  retryable: boolean;
}

interface SnapshotBatch {
  successes: SnapshotSuccess[];
  failures: SnapshotFailure[];
}

interface CandidateContext {
  catalogSystem: CatalogSystem;
  snapshot: SystemFeedAvailabilityResult;
}

const candidateKey = (systemId: string, stationId: string): string =>
  `${systemId}\u0000${stationId}`;

const publicText = (value: string | null): string | null =>
  value === null ? null : sanitizeProviderText(value);

const publicSystemSummary = (
  system: Pick<
    CatalogSystem,
    | "system_id"
    | "name"
    | "operator"
    | "city"
    | "region"
    | "country_code"
    | "capabilities"
  >,
): SystemSummary => ({
  system_id: system.system_id,
  name: sanitizeProviderText(system.name),
  operator: publicText(system.operator),
  city: publicText(system.city),
  region: publicText(system.region),
  country_code: system.country_code,
  capabilities: system.capabilities,
});

const publicSystemSummaryWithSnapshot = (
  catalogSystem: CatalogSystem,
  snapshot?: SystemFeedAvailabilityResult,
): SystemSummary =>
  publicSystemSummary(
    snapshot === undefined
      ? catalogSystem
      : {
          ...catalogSystem,
          capabilities: snapshot.system.capabilities,
        },
  );

const publicSystemsConsidered = (
  candidates: readonly CatalogCandidate[],
  batch: SnapshotBatch,
): SystemSummary[] => {
  const snapshots = new Map(
    batch.successes.map(({ candidate, snapshot }) => [
      candidate.system.system_id,
      snapshot,
    ]),
  );
  return candidates.map(({ system }) =>
    publicSystemSummaryWithSnapshot(system, snapshots.get(system.system_id)),
  );
};

const publicStation = (station: Station): Station => ({
  ...station,
  name: sanitizeProviderText(station.name),
  station_type: publicText(station.station_type),
  region_id: publicText(station.region_id),
  rental_methods: station.rental_methods.map((method) =>
    sanitizeProviderText(method, 128),
  ),
});

const catalogSystemToContract = (system: CatalogSystem): System => ({
  system_id: system.system_id,
  name: sanitizeProviderText(system.name),
  operator: publicText(system.operator),
  city: publicText(system.city),
  region: publicText(system.region),
  country_code: system.country_code,
  timezone: publicText(system.timezone),
  discovery_url: system.discovery_url,
  detected_version: publicText(system.detected_version),
  languages: system.languages.map((language) =>
    sanitizeProviderText(language, 64),
  ),
  license: publicText(
    system.license.url ?? system.license.name ?? system.license.id,
  ),
  capabilities: system.capabilities,
});

const failureDetails = (
  error: unknown,
): Pick<SnapshotFailure, "code" | "retryable"> => {
  if (error instanceof DomainError) {
    return { code: error.code, retryable: error.retryable };
  }
  const record =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  if (record.code === "STALE_DATA") {
    return { code: "STALE_DATA", retryable: true };
  }
  if (record.code === "UNSUPPORTED_FEED") {
    return { code: "UNSUPPORTED_FEED", retryable: false };
  }
  if (record.code === "RATE_LIMITED") {
    return { code: "RATE_LIMITED", retryable: true };
  }
  return {
    code: "SYSTEM_UNAVAILABLE",
    retryable: record.retryable !== false,
  };
};

const deduplicateWarnings = (warnings: readonly Warning[]): Warning[] => {
  const seen = new Set<string>();
  const output: Warning[] = [];
  for (const warning of warnings) {
    const key = [
      warning.code,
      warning.system_id ?? "",
      warning.station_id ?? "",
      warning.message,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    if (output.length === MAX_WARNINGS) break;
    output.push(warning);
  }
  return output;
};

const providerFailureWarning = (failure: SnapshotFailure): Warning => ({
  code:
    failure.code === "STALE_DATA" ? "STALE_DATA" : "PROVIDER_UNAVAILABLE",
  message:
    failure.code === "STALE_DATA"
      ? "The provider had no observation within the requested freshness window."
      : "A candidate provider could not be used for this request.",
  system_id: failure.candidate.system.system_id,
  retryable: failure.retryable,
});

const staleObservationWarning = (
  systemId: string,
  stationId: string,
): Warning => ({
  code: "STALE_DATA",
  message:
    "The provider observation is older than its published TTL but remains within the requested maximum staleness.",
  system_id: systemId,
  station_id: stationId,
  retryable: true,
});

const expiredObservationWarning = (
  systemId: string,
  stationId: string,
): Warning => ({
  code: "STALE_DATA",
  message:
    "The provider observation exceeded the service maximum staleness and was omitted.",
  system_id: systemId,
  station_id: stationId,
  retryable: true,
});

const sourceAttribution = (
  catalogSystem: CatalogSystem,
  snapshot: SystemFeedAvailabilityResult,
  includeUrls: boolean,
  includeStatus: boolean,
): SourceAttribution[] => {
  const output: SourceAttribution[] = [];
  const add = (
    feedName: SourceAttribution["feed_name"],
    url: string | undefined,
  ): void => {
    if (url === undefined) return;
    const observation = snapshot.source_observations?.[feedName];
    output.push({
      system_id: catalogSystem.system_id,
      feed_name: feedName,
      ...(includeUrls ? { url } : {}),
      // Older persisted snapshots did not retain per-feed observations. Keep
      // their previous discovery-level fallback until the next refresh, while
      // preserving an explicit null from current station-status feeds.
      provider_last_updated:
        observation === undefined
          ? snapshot.discovery.providerLastUpdated
          : observation.provider_last_updated,
      fetched_at: observation?.fetched_at ?? snapshot.fetched_at,
    });
  };

  add("station_information", snapshot.discovery.feeds.station_information);
  if (includeStatus) {
    add("station_status", snapshot.discovery.feeds.station_status);
  }
  if (output.length === 0) {
    add("gbfs", catalogSystem.discovery_url);
  }
  return output;
};

const freshnessFor = (
  snapshot: SystemFeedAvailabilityResult,
  stationLastReported: string | null,
  maxStalenessSeconds: number,
  now: Date,
) =>
  evaluateFreshness({
    providerLastUpdated:
      snapshot.source_observations?.station_status === undefined
        ? snapshot.discovery.providerLastUpdated
        : snapshot.source_observations.station_status.provider_last_updated,
    stationLastReported,
    fetchedAt:
      snapshot.source_observations?.station_status?.fetched_at ??
      snapshot.fetched_at,
    ttlSeconds:
      snapshot.source_observations?.station_status?.ttl_seconds ??
      snapshot.ttl_seconds,
    maxStalenessSeconds,
    now,
  });

const timeout = async <T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T> => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new DomainError(
      "SYSTEM_UNAVAILABLE",
      "The provider request exceeded the service deadline.",
      true,
    );
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new DomainError(
                "SYSTEM_UNAVAILABLE",
                "The provider request exceeded the service deadline.",
                true,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const sortStationSearch = (
  left: StationSearchCandidate,
  right: StationSearchCandidate,
): number =>
  left.distance_meters - right.distance_meters ||
  (left.station.system_id < right.station.system_id
    ? -1
    : left.station.system_id > right.station.system_id
      ? 1
      : left.station.station_id < right.station.station_id
        ? -1
        : left.station.station_id > right.station.station_id
          ? 1
          : 0);

const contractProviderErrorClass = (
  value: SystemFeedHealth["feeds"][number]["last_error_class"],
) => (value === "tls" ? "unknown" : value);

export class OpenBikeMcpService {
  private readonly now: () => Date;
  private readonly requestDeadlineMs: number;

  constructor(private readonly dependencies: OpenBikeServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.requestDeadlineMs =
      dependencies.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  }

  private metadata(catalogVersion: string) {
    return {
      request_id: this.dependencies.requestId,
      catalog_version: catalogVersion,
      generated_at: this.now().toISOString(),
      worker_version: this.dependencies.workerVersion,
    };
  }

  private candidateLimit(requested: number): number {
    return Math.min(
      requested,
      4,
      Math.max(1, this.dependencies.maxCandidateSystems),
    );
  }

  private async probeDiscoveryMetadata(
    catalogVersion: string,
    systemIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProbeDiscoveryMetadata>> {
    if (this.dependencies.loadProbeDiscoveryMetadata === undefined) {
      return new Map();
    }
    try {
      return await this.dependencies.loadProbeDiscoveryMetadata(
        catalogVersion,
        systemIds,
      );
    } catch {
      // Probe metadata is a derived overlay; the reviewed immutable catalog is
      // the safe fallback when the status store is temporarily unavailable.
      return new Map();
    }
  }

  private async snapshots(
    candidates: readonly CatalogCandidate[],
    maxStalenessSeconds: number,
  ): Promise<SnapshotBatch> {
    const deadlineAt = Date.now() + this.requestDeadlineMs;
    const outcomes = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const snapshot = await timeout(
            this.dependencies.feedForSystem(candidate.system).getAvailability({
              catalogSystem: candidate.system,
              maxStalenessSeconds,
            }),
            deadlineAt,
          );
          return { ok: true as const, candidate, snapshot };
        } catch (error) {
          return {
            ok: false as const,
            candidate,
            ...failureDetails(error),
          };
        }
      }),
    );

    return {
      successes: outcomes.filter(
        (outcome): outcome is SnapshotSuccess & { ok: true } => outcome.ok,
      ),
      failures: outcomes.filter(
        (outcome): outcome is SnapshotFailure & { ok: false } => !outcome.ok,
      ),
    };
  }

  async getNearbyAvailability(
    rawInput: GetNearbyAvailabilityInput,
  ): Promise<GetNearbyAvailabilityOutput> {
    const input = GetNearbyAvailabilityInputSchema.parse(rawInput);
    const catalog = await this.dependencies.loadCatalog();
    const candidates = findCatalogSystems(catalog, {
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radius_meters,
      ...(input.system_ids === undefined
        ? {}
        : { systemIds: input.system_ids }),
      limit: this.candidateLimit(input.system_ids?.length ?? 4),
    });
    if (candidates.length === 0) {
      throw new DomainError(
        "NO_SYSTEM_COVERAGE",
        "No indexed bikeshare system plausibly covers this coordinate.",
      );
    }

    const batch = await this.snapshots(candidates, input.max_staleness_seconds);
    if (batch.successes.length === 0) {
      const staleOnly = batch.failures.every(
        (failure) => failure.code === "STALE_DATA",
      );
      throw new DomainError(
        staleOnly ? "STALE_DATA" : "SYSTEM_UNAVAILABLE",
        staleOnly
          ? "No provider observation was within the requested freshness window."
          : "No candidate provider could answer this request.",
        true,
      );
    }

    const now = this.now();
    const contexts = new Map<string, CandidateContext>();
    const warnings: Warning[] = batch.failures.map(providerFailureWarning);
    if (batch.failures.length > 0) {
      warnings.push({
        code: "PARTIAL_RESULTS",
        message: "At least one candidate provider failed; successful systems are still included.",
        retryable: true,
      });
    }

    const availabilityCandidates: AvailabilityCandidate[] = [];
    for (const { candidate, snapshot } of batch.successes) {
      warnings.push(...snapshot.warnings);
      const joined = joinStationsWithStatus(snapshot.stations, snapshot.statuses);
      warnings.push(...joined.warnings);
      for (const item of joined.stations) {
        if (item.status === undefined) continue;
        const freshness = freshnessFor(
          snapshot,
          item.status.station_last_reported,
          input.max_staleness_seconds,
          now,
        );
        if (!freshness.source_timestamp_present) {
          warnings.push({
            code: "SOURCE_TIMESTAMP_MISSING",
            message: "The provider did not publish a source observation timestamp.",
            system_id: candidate.system.system_id,
            station_id: item.station.station_id,
            retryable: false,
          });
        }
        if (freshness.freshness.is_stale) {
          warnings.push(
            staleObservationWarning(
              candidate.system.system_id,
              item.station.station_id,
            ),
          );
        }
        const relevantCount = relevantAvailabilityCount(
          item.status.availability,
          input.mode,
          input.vehicle_types,
        );
        const semanticsAmbiguous =
          input.mode === "return" && (input.vehicle_types?.length ?? 0) > 0;
        if (semanticsAmbiguous) {
          warnings.push({
            code: "VEHICLE_TYPE_AMBIGUOUS",
            message: "The provider does not identify whether each open dock accepts the requested vehicle type.",
            system_id: candidate.system.system_id,
            station_id: item.station.station_id,
            retryable: false,
          });
        } else if (
          input.mode !== "return" &&
          (input.vehicle_types?.length ?? 0) > 0 &&
          relevantCount === null
        ) {
          warnings.push({
            code: "VEHICLE_TYPE_AMBIGUOUS",
            message: "The provider did not report a complete requested vehicle-type breakdown.",
            system_id: candidate.system.system_id,
            station_id: item.station.station_id,
            retryable: false,
          });
        }

        const status = {
          ...item.status,
          availability: {
            ...item.status.availability,
            confidence: determineAvailabilityConfidence({
              hasUsableStatus: true,
              relevantCountKnown: relevantCount !== null,
              operationalFlagsKnown:
                item.status.availability.is_installed !== null &&
                item.status.availability.is_renting !== null &&
                item.status.availability.is_returning !== null,
              freshness,
              semanticsAmbiguous,
            }),
          },
        };
        const normalizedStation = publicStation(item.station);
        const key = candidateKey(
          normalizedStation.system_id,
          normalizedStation.station_id,
        );
        contexts.set(key, {
          catalogSystem: candidate.system,
          snapshot,
        });
        availabilityCandidates.push({
          station: normalizedStation,
          status,
          freshness: freshness.freshness,
          distance_meters: Math.round(
            distanceToStationMeters(input, normalizedStation),
          ),
        });
      }
    }

    const selectionOptions: NearbySelectionOptions = {
      mode: input.mode,
      radiusMeters: input.radius_meters,
      minimumAvailable: input.minimum_available,
      maxStalenessSeconds: input.max_staleness_seconds,
      includeUnavailable: input.include_unavailable,
      ...(input.vehicle_types === undefined
        ? {}
        : { vehicleTypes: input.vehicle_types }),
      ...(input.system_ids === undefined ? {} : { systemIds: input.system_ids }),
    };
    const selected = selectNearbyCandidates(
      availabilityCandidates,
      selectionOptions,
      input.limit,
    );
    if (selected.length === 0) {
      const excludedOnlyByStaleness =
        selectNearbyCandidates(
          availabilityCandidates,
          {
            ...selectionOptions,
            maxStalenessSeconds: Number.MAX_SAFE_INTEGER,
          },
          1,
        ).length > 0;
      throw new DomainError(
        excludedOnlyByStaleness ? "STALE_DATA" : "NO_RESULTS",
        excludedOnlyByStaleness
          ? "Matching stations were found, but their observations exceeded the requested freshness window."
          : "Systems were found, but no station matched the requested filters.",
        excludedOnlyByStaleness || batch.failures.length > 0,
      );
    }

    return GetNearbyAvailabilityOutputSchema.parse({
      query: {
        ...input,
        system_ids: input.system_ids ?? [],
        vehicle_types: input.vehicle_types ?? [],
      },
      systems_considered: publicSystemsConsidered(candidates, batch),
      systems_failed: batch.failures.map((failure) => ({
        system_id: failure.candidate.system.system_id,
        code: failure.code,
        retryable: failure.retryable,
      })),
      results: selected.map((candidate) => {
        const context = contexts.get(
          candidateKey(
            candidate.station.system_id,
            candidate.station.station_id,
          ),
        );
        if (context === undefined) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "The bounded station result lost its provider context.",
            true,
          );
        }
        return {
          system: publicSystemSummaryWithSnapshot(
            context.catalogSystem,
            context.snapshot,
          ),
          station: candidate.station,
          distance_meters: candidate.distance_meters,
          availability: candidate.status.availability,
          freshness: candidate.freshness,
          sources: sourceAttribution(
            context.catalogSystem,
            context.snapshot,
            true,
            true,
          ),
        };
      }),
      warnings: deduplicateWarnings(warnings),
      metadata: this.metadata(catalog.version),
    });
  }

  async findStations(rawInput: FindStationsInput): Promise<FindStationsOutput> {
    const input = FindStationsInputSchema.parse(rawInput);
    const catalog = await this.dependencies.loadCatalog();
    const candidates = findCatalogSystems(catalog, {
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radius_meters,
      ...(input.system_ids === undefined
        ? {}
        : { systemIds: input.system_ids }),
      limit: this.candidateLimit(input.system_ids?.length ?? 4),
    });
    if (candidates.length === 0) {
      throw new DomainError(
        "NO_SYSTEM_COVERAGE",
        "No indexed bikeshare system plausibly covers this coordinate.",
      );
    }

    const batch = await this.snapshots(
      candidates,
      DEFAULT_LIVE_STALENESS_SECONDS,
    );
    if (batch.successes.length === 0) {
      throw new DomainError(
        "SYSTEM_UNAVAILABLE",
        "No candidate provider could answer this request.",
        true,
      );
    }

    const now = this.now();
    const warnings: Warning[] = batch.failures.map(providerFailureWarning);
    if (batch.failures.length > 0) {
      warnings.push({
        code: "PARTIAL_RESULTS",
        message: "At least one candidate provider failed; successful systems are still included.",
        retryable: true,
      });
    }
    const contexts = new Map<string, CandidateContext>();
    const stationCandidates: StationSearchCandidate[] = [];
    for (const { candidate, snapshot } of batch.successes) {
      warnings.push(...snapshot.warnings);
      const joined = joinStationsWithStatus(snapshot.stations, snapshot.statuses);
      warnings.push(...joined.warnings);
      for (const item of joined.stations) {
        const normalizedStation = publicStation(item.station);
        let usableStatus = item.status;
        if (
          usableStatus !== undefined &&
          (input.include_status || input.operational_only)
        ) {
          const evaluation = freshnessFor(
            snapshot,
            usableStatus.station_last_reported,
            DEFAULT_LIVE_STALENESS_SECONDS,
            now,
          );
          if (!evaluation.within_max_staleness) {
            warnings.push(
              expiredObservationWarning(
                candidate.system.system_id,
                normalizedStation.station_id,
              ),
            );
            usableStatus = undefined;
          }
        }
        contexts.set(
          candidateKey(
            normalizedStation.system_id,
            normalizedStation.station_id,
          ),
          { catalogSystem: candidate.system, snapshot },
        );
        stationCandidates.push({
          station: normalizedStation,
          ...(usableStatus === undefined ? {} : { status: usableStatus }),
          distance_meters: Math.round(
            distanceToStationMeters(input, normalizedStation),
          ),
        });
      }
    }

    const filtered = filterStationSearchCandidates(stationCandidates, {
      radiusMeters: input.radius_meters,
      operationalOnly: input.operational_only,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.system_ids === undefined ? {} : { systemIds: input.system_ids }),
    }).sort(sortStationSearch);

    const { cursor: _cursor, ...cursorQuery } = input;
    const queryFingerprint = fingerprintQuery(cursorQuery);
    const offset =
      input.cursor === undefined
        ? 0
        : decodeCursor(input.cursor, {
            catalogVersion: catalog.version,
            queryFingerprint,
          }).offset;
    if (offset > filtered.length) {
      throw new DomainError("INVALID_ARGUMENT", "Invalid pagination cursor");
    }
    const page = filtered.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < filtered.length
        ? encodeCursor({
            version: 1,
            catalog_version: catalog.version,
            query_fingerprint: queryFingerprint,
            offset: nextOffset,
          })
        : null;

    return FindStationsOutputSchema.parse({
      results: page.map((candidate) => {
        const context = contexts.get(
          candidateKey(
            candidate.station.system_id,
            candidate.station.station_id,
          ),
        );
        if (context === undefined) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "The bounded station result lost its provider context.",
            true,
          );
        }
        if (!input.include_status || candidate.status === undefined) {
          return {
            system: publicSystemSummaryWithSnapshot(
              context.catalogSystem,
              context.snapshot,
            ),
            station: candidate.station,
            distance_meters: candidate.distance_meters,
            sources: sourceAttribution(
              context.catalogSystem,
              context.snapshot,
              true,
              false,
            ),
          };
        }
        const freshness = freshnessFor(
          context.snapshot,
          candidate.status.station_last_reported,
          DEFAULT_LIVE_STALENESS_SECONDS,
          now,
        ).freshness;
        if (freshness.is_stale) {
          warnings.push(
            staleObservationWarning(
              context.catalogSystem.system_id,
              candidate.station.station_id,
            ),
          );
        }
        return {
          system: publicSystemSummaryWithSnapshot(
            context.catalogSystem,
            context.snapshot,
          ),
          station: candidate.station,
          distance_meters: candidate.distance_meters,
          availability: candidate.status.availability,
          freshness,
          sources: sourceAttribution(
            context.catalogSystem,
            context.snapshot,
            true,
            true,
          ),
        };
      }),
      next_cursor: nextCursor,
      systems_considered: publicSystemsConsidered(candidates, batch),
      systems_failed: batch.failures.map((failure) => ({
        system_id: failure.candidate.system.system_id,
        code: failure.code,
        retryable: failure.retryable,
      })),
      warnings: deduplicateWarnings(warnings),
      metadata: this.metadata(catalog.version),
    });
  }

  async getStation(rawInput: GetStationInput): Promise<GetStationOutput> {
    const input = GetStationInputSchema.parse(rawInput);
    const catalog = await this.dependencies.loadCatalog();
    const catalogSystem = getCatalogSystem(catalog, input.system_id);
    if (catalogSystem === undefined || !catalogSystem.enabled) {
      throw new DomainError("NOT_FOUND", "The requested system was not found.");
    }

    let snapshot: SystemFeedAvailabilityResult;
    try {
      snapshot = await timeout(
        this.dependencies.feedForSystem(catalogSystem).getAvailability({
          catalogSystem,
          maxStalenessSeconds: DEFAULT_LIVE_STALENESS_SECONDS,
        }),
        Date.now() + this.requestDeadlineMs,
      );
    } catch (error) {
      const failure = failureDetails(error);
      throw new DomainError(
        failure.code,
        "The requested system is currently unavailable.",
        failure.retryable,
      );
    }

    const station = snapshot.stations.find(
      (candidate) => candidate.station_id === input.station_id,
    );
    if (station === undefined) {
      throw new DomainError("NOT_FOUND", "The requested station was not found.");
    }
    const rawStatus = input.include_status
      ? snapshot.statuses.find(
          (candidate) => candidate.station_id === input.station_id,
        )
      : undefined;
    let status = rawStatus;
    let freshness: Freshness | undefined;
    const warnings = [...snapshot.warnings];
    if (status !== undefined) {
      const evaluation = freshnessFor(
        snapshot,
        status.station_last_reported,
        DEFAULT_LIVE_STALENESS_SECONDS,
        this.now(),
      );
      if (evaluation.within_max_staleness) {
        freshness = evaluation.freshness;
      } else {
        warnings.push(
          expiredObservationWarning(
            catalogSystem.system_id,
            station.station_id,
          ),
        );
        status = undefined;
      }
    }
    const sources = sourceAttribution(
      catalogSystem,
      snapshot,
      input.include_raw_links,
      status !== undefined,
    );
    if (input.include_status && rawStatus === undefined) {
      warnings.push({
        code: "MISSING_STATION_STATUS",
        message: "The station has no matching live status record.",
        system_id: catalogSystem.system_id,
        station_id: station.station_id,
        retryable: true,
      });
    }

    if (freshness?.is_stale === true) {
      warnings.push(
        staleObservationWarning(catalogSystem.system_id, station.station_id),
      );
    }
    return GetStationOutputSchema.parse({
      system: publicSystemSummaryWithSnapshot(catalogSystem, snapshot),
      station: publicStation(station),
      ...(status === undefined
        ? {}
        : { availability: status.availability, freshness }),
      sources,
      warnings: deduplicateWarnings(warnings),
      metadata: this.metadata(catalog.version),
    });
  }

  async findSystems(rawInput: FindSystemsInput): Promise<FindSystemsOutput> {
    const input = FindSystemsInputSchema.parse(rawInput);
    const catalog = await this.dependencies.loadCatalog();
    const baseCandidates = findCatalogSystems(catalog, {
      ...(input.latitude === undefined
        ? {}
        : {
            latitude: input.latitude,
            longitude: input.longitude as number,
            radiusMeters: input.radius_km * 1_000,
          }),
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.country_code === undefined
        ? {}
        : { countryCode: input.country_code }),
      // Probe metadata is loaded only for the bounded discovery index. Filter
      // by observed capability after applying the overlay, then enforce the
      // caller's requested result limit.
      limit: 100,
    });
    const probeMetadata = await this.probeDiscoveryMetadata(
      catalog.version,
      baseCandidates.map((candidate) => candidate.system.system_id),
    );
    const candidates = baseCandidates
      .map((candidate) => {
        const metadata = probeMetadata.get(candidate.system.system_id);
        return metadata === undefined
          ? candidate
          : {
              ...candidate,
              system: {
                ...candidate.system,
                detected_version:
                  metadata.detected_version ??
                  candidate.system.detected_version,
                capabilities:
                  metadata.capabilities ?? candidate.system.capabilities,
              },
            };
      })
      .filter(
        ({ system }) =>
          input.capability === undefined ||
          system.capabilities[input.capability] === true,
      )
      .slice(0, input.limit);

    if (candidates.length === 0 && input.latitude !== undefined) {
      throw new DomainError(
        "NO_SYSTEM_COVERAGE",
        "No indexed bikeshare system plausibly covers this coordinate.",
      );
    }
    if (candidates.length === 0) {
      throw new DomainError(
        "NO_RESULTS",
        "No bikeshare system matched the requested filters.",
      );
    }

    return FindSystemsOutputSchema.parse({
      results: candidates.map(({ system, distance_meters: distanceMeters }) => {
        const metadata = probeMetadata.get(system.system_id);
        return {
          ...catalogSystemToContract(system),
          distance_meters: distanceMeters,
          coverage_confidence: system.coverage.confidence,
          last_successful_probe: metadata?.last_successful_probe ?? null,
        };
      }),
      warnings: [],
      metadata: this.metadata(catalog.version),
    });
  }

  async getSystemHealth(
    rawInput: GetSystemHealthInput,
  ): Promise<GetSystemHealthOutput> {
    const input = GetSystemHealthInputSchema.parse(rawInput);
    const catalog = await this.dependencies.loadCatalog();
    const catalogSystem = getCatalogSystem(catalog, input.system_id);
    if (catalogSystem === undefined || !catalogSystem.enabled) {
      throw new DomainError("NOT_FOUND", "The requested system was not found.");
    }

    const feed = this.dependencies.feedForSystem(catalogSystem);
    const deadlineAt = Date.now() + this.requestDeadlineMs;
    let health: SystemFeedHealth;
    try {
      health = await timeout(feed.getHealth(catalogSystem), deadlineAt);
    } catch (error) {
      const failure = failureDetails(error);
      throw new DomainError(
        failure.code,
        "Health diagnostics for the requested system are currently unavailable.",
        failure.retryable,
      );
    }

    const feeds = health.feeds.flatMap((feedHealth) => {
      const parsed = FeedHealthSchema.safeParse({
        ...feedHealth,
        // TLS failures stay intentionally coarsened because the public contract
        // does not expose provider-specific transport details.
        last_error_class: contractProviderErrorClass(
          feedHealth.last_error_class,
        ),
      });
      return parsed.success ? [parsed.data] : [];
    });
    const warnings: Warning[] = [];
    if (health.state === "degraded" || health.state === "unavailable") {
      warnings.push({
        code: "PROVIDER_UNAVAILABLE",
        message:
          health.state === "unavailable"
            ? "The provider is currently unavailable."
            : "The provider is responding in a degraded state.",
        system_id: catalogSystem.system_id,
        retryable: true,
      });
    }

    return GetSystemHealthOutputSchema.parse({
      system_id: health.system_id ?? catalogSystem.system_id,
      discovery_url: health.discovery_url ?? catalogSystem.discovery_url,
      detected_version:
        health.detected_version ?? catalogSystem.detected_version,
      feeds,
      rolling_success_rate: health.rolling_success_rate,
      rolling_window_seconds: health.rolling_window_seconds,
      capabilities: health.capabilities ?? catalogSystem.capabilities,
      degradation_state:
        health.state === "uninitialized" ? "unknown" : health.state,
      last_successful_probe: health.last_success_at,
      warnings: deduplicateWarnings(warnings),
      metadata: this.metadata(catalog.version),
    });
  }
}

export const createOpenBikeMcpService = (
  env: Env,
  requestContext: { requestId: string },
): OpenBikeMcpService => {
  const config = runtimeConfig(env);
  return new OpenBikeMcpService({
    loadCatalog: () => loadCatalog(env, { allowBundledFallback: true }),
    loadProbeDiscoveryMetadata: (catalogVersion, systemIds) =>
      readProbeDiscoveryMetadata(env, catalogVersion, systemIds),
    feedForSystem: (system) =>
      getSystemFeedStub(env, system) as unknown as SystemFeedClient,
    requestId: requestContext.requestId,
    workerVersion: SERVICE_VERSION,
    maxCandidateSystems: config.maxCandidateSystems,
  });
};
