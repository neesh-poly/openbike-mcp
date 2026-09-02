import {
  FeedObservationSchema,
  SystemIdSchema,
  type FeedObservation,
  type VehicleType,
  type Warning,
} from "../contracts";
import { DomainError } from "../contracts/errors";
import {
  fetchBoundedJson,
  type FetchBoundedJsonOptions,
  type ResponseMetadata,
} from "../security/fetch-json";
import {
  OutboundRequestError,
  toDomainError as outboundToDomainError,
} from "../security/errors";
import { createReviewedHostPolicy } from "../security/url-policy";
import {
  GbfsNormalizationError,
  normalizeDiscovery,
  normalizeStations,
  normalizeStationStatuses,
  normalizeSystemInformation,
  normalizeVehicleTypes,
  readGbfsEnvelopeMetadata,
} from "./normalize";
import type {
  CachedGbfsDocument,
  GbfsClientOptions,
  GbfsDataFeedName,
  GbfsFetchFeedName,
  GbfsFetchState,
  GbfsNormalizationContext,
  GbfsStationBundle,
  GbfsSystemSource,
} from "./types";

interface LoadedDocument {
  document: unknown;
  observation: FeedObservation;
  cached: CachedGbfsDocument;
}

/** Adds safe feed identity without exposing a provider URL or response body. */
export class GbfsFeedError extends Error {
  readonly feedName: GbfsFetchFeedName;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  readonly httpStatus: number | undefined;

  constructor(feedName: GbfsFetchFeedName, cause: unknown) {
    const safeCause =
      cause instanceof OutboundRequestError ||
      cause instanceof GbfsNormalizationError;
    super(
      safeCause
        ? cause.message
        : "The upstream GBFS feed could not be processed.",
      { cause },
    );
    const details =
      cause !== null && typeof cause === "object"
        ? (cause as Record<string, unknown>)
        : {};
    this.name = "GbfsFeedError";
    this.feedName = feedName;
    this.code = typeof details.code === "string" ? details.code : undefined;
    this.retryable =
      typeof details.retryable === "boolean" ? details.retryable : undefined;
    this.httpStatus =
      typeof details.httpStatus === "number" ? details.httpStatus : undefined;
  }
}

const withGbfsFeedError = async <T>(
  feedName: GbfsFetchFeedName,
  operation: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GbfsFeedError) throw error;
    throw new GbfsFeedError(feedName, error);
  }
};

export const getGbfsFailureFeedName = (
  error: unknown,
): GbfsFetchFeedName | undefined =>
  error instanceof GbfsFeedError ? error.feedName : undefined;

const mergedMetadata = (
  previous: ResponseMetadata,
  current: ResponseMetadata,
): ResponseMetadata => ({
  ...(previous.etag === undefined ? {} : { etag: previous.etag }),
  ...(previous.lastModified === undefined
    ? {}
    : { lastModified: previous.lastModified }),
  ...(previous.contentHash === undefined
    ? {}
    : { contentHash: previous.contentHash }),
  ...current,
});

const requiredFeedUrl = (
  feeds: Partial<Record<GbfsDataFeedName, string>>,
  feedName: GbfsDataFeedName,
): string => {
  const url = feeds[feedName];
  if (url === undefined) {
    throw new GbfsNormalizationError(
      "MISSING_REQUIRED_FEED",
      `The GBFS discovery document did not advertise ${feedName}.`,
    );
  }
  return url;
};

const unavailableVehicleTypesWarning = (systemId: string): Warning => ({
  code: "PROVIDER_UNAVAILABLE",
  message:
    "Vehicle-type metadata was unavailable; aggregate station availability remains usable.",
  system_id: systemId,
  retryable: true,
});

export const toGbfsDomainError = (error: unknown): DomainError => {
  if (error instanceof GbfsFeedError) {
    return toGbfsDomainError(error.cause);
  }
  if (!(error instanceof GbfsNormalizationError)) {
    return outboundToDomainError(error);
  }
  return new DomainError(
    "UNSUPPORTED_FEED",
    error.message,
    error.retryable,
  );
};

export class GbfsClient {
  readonly source: GbfsSystemSource;

  private readonly options: GbfsClientOptions;
  private readonly policy: ReturnType<typeof createReviewedHostPolicy>;

  constructor(source: GbfsSystemSource, options: GbfsClientOptions = {}) {
    const systemId = SystemIdSchema.parse(source.systemId);
    this.source = { ...source, systemId };
    this.options = options;
    this.policy = createReviewedHostPolicy(
      source.reviewedHosts.map((rule) => {
        const headers = {
          ...(source.requestHeaders ?? {}),
          ...(rule.headers ?? {}),
        };
        return {
          ...rule,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        };
      }),
    );
  }

  private async loadDocument(
    feedName: GbfsFetchFeedName,
    url: string,
    previous: CachedGbfsDocument | undefined,
  ): Promise<LoadedDocument> {
    return withGbfsFeedError(feedName, async () => {
      const mayReusePrevious = previous?.url === undefined || previous.url === url;
      const conditional = mayReusePrevious ? previous?.metadata : undefined;
      const fetchOptions: FetchBoundedJsonOptions = {
        policy: this.policy,
        ...(this.options.fetcher === undefined
          ? {}
          : { fetcher: this.options.fetcher }),
        ...(this.options.maxBytes === undefined
          ? {}
          : { maxBytes: this.options.maxBytes }),
        ...(this.options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.timeoutMs }),
        ...(this.options.maxRedirects === undefined
          ? {}
          : { maxRedirects: this.options.maxRedirects }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
        ...(conditional === undefined ? {} : { conditional }),
      };
      const result = await fetchBoundedJson(url, fetchOptions);

      let document: unknown;
      let metadata: ResponseMetadata;
      if (result.kind === "not_modified") {
        if (previous === undefined || !mayReusePrevious) {
          throw new GbfsNormalizationError(
            "INVALID_DOCUMENT",
            "The upstream feed returned not-modified without a reusable document.",
            true,
          );
        }
        document = previous.document;
        metadata = mergedMetadata(previous.metadata, result.metadata);
      } else {
        document = result.document;
        metadata = result.metadata;
      }

      const envelope = readGbfsEnvelopeMetadata(document);
      const observation = FeedObservationSchema.parse({
        system_id: this.source.systemId,
        feed_name: feedName,
        fetched_at: result.fetchedAt,
        http_status: result.status,
        etag: metadata.etag ?? null,
        last_modified: metadata.lastModified ?? null,
        provider_last_updated: envelope.providerLastUpdated,
        ttl_seconds: envelope.ttlSeconds,
        validation_status: "valid",
        content_hash: metadata.contentHash ?? null,
      });
      return {
        document,
        observation,
        cached: { document, metadata, url },
      };
    });
  }

  async fetchStationBundle(
    previousState: GbfsFetchState = {},
  ): Promise<GbfsStationBundle> {
    const discoveryDocument = await this.loadDocument(
      "gbfs",
      this.source.discoveryUrl,
      previousState.gbfs,
    );
    const discoveryResult = await withGbfsFeedError("gbfs", () =>
      normalizeDiscovery(discoveryDocument.document, {
        systemId: this.source.systemId,
        ...(this.source.preferredLanguages === undefined
          ? {}
          : { preferredLanguages: this.source.preferredLanguages }),
      }),
    );
    const discovery = discoveryResult.value;

    const systemInformationUrl = await withGbfsFeedError(
      "system_information",
      () => requiredFeedUrl(discovery.feeds, "system_information"),
    );
    const stationInformationUrl = await withGbfsFeedError(
      "station_information",
      () => requiredFeedUrl(discovery.feeds, "station_information"),
    );
    const stationStatusUrl = await withGbfsFeedError("station_status", () =>
      requiredFeedUrl(discovery.feeds, "station_status"),
    );
    const vehicleTypesUrl = discovery.feeds.vehicle_types;

    const [systemDocument, stationDocument, statusDocument, vehicleDocumentResult] =
      await Promise.all([
        this.loadDocument(
          "system_information",
          systemInformationUrl,
          previousState.system_information,
        ),
        this.loadDocument(
          "station_information",
          stationInformationUrl,
          previousState.station_information,
        ),
        this.loadDocument(
          "station_status",
          stationStatusUrl,
          previousState.station_status,
        ),
        vehicleTypesUrl === undefined
          ? Promise.resolve(undefined)
          : this.loadDocument(
              "vehicle_types",
              vehicleTypesUrl,
              previousState.vehicle_types,
            ).catch(() => undefined),
      ]);

    const baseContext: GbfsNormalizationContext = {
      systemId: this.source.systemId,
      discoveryUrl: this.source.discoveryUrl,
      detectedVersion: discovery.version,
      fetchedAt: statusDocument.observation.fetched_at,
      languages: discovery.languages,
      ...(this.source.preferredLanguages === undefined
        ? {}
        : { preferredLanguages: this.source.preferredLanguages }),
      ...(this.source.city === undefined ? {} : { city: this.source.city }),
      ...(this.source.region === undefined ? {} : { region: this.source.region }),
      ...(this.source.countryCode === undefined
        ? {}
        : { countryCode: this.source.countryCode }),
      ...(this.source.licenseOverride === undefined
        ? {}
        : { licenseOverride: this.source.licenseOverride }),
    };

    let vehicleTypes: VehicleType[] = [];
    const vehicleWarnings: Warning[] = [];
    let vehicleDocument: LoadedDocument | undefined;
    if (vehicleTypesUrl !== undefined) {
      if (vehicleDocumentResult === undefined) {
        vehicleWarnings.push(
          unavailableVehicleTypesWarning(this.source.systemId),
        );
      } else {
        try {
          const normalized = normalizeVehicleTypes(
            vehicleDocumentResult.document,
            baseContext,
          );
          vehicleTypes = normalized.value;
          vehicleWarnings.push(...normalized.warnings);
          vehicleDocument = vehicleDocumentResult;
        } catch {
          vehicleWarnings.push(
            unavailableVehicleTypesWarning(this.source.systemId),
          );
        }
      }
    }

    const capabilities = {
      docked: discovery.feeds.station_information !== undefined,
      dockless:
        discovery.feeds.free_bike_status !== undefined ||
        discovery.feeds.vehicle_status !== undefined,
      ebike: vehicleTypes.some(
        (type) => type.category === "ebike" || type.category === "cargo_bike",
      ),
      station_status: discovery.feeds.station_status !== undefined,
    };
    const fullContext: GbfsNormalizationContext = {
      ...baseContext,
      capabilities,
      vehicleTypes,
    };
    const systemResult = await withGbfsFeedError("system_information", () =>
      normalizeSystemInformation(systemDocument.document, fullContext),
    );
    const stationResult = await withGbfsFeedError("station_information", () =>
      normalizeStations(stationDocument.document, fullContext),
    );
    const statusResult = await withGbfsFeedError("station_status", () =>
      normalizeStationStatuses(statusDocument.document, fullContext),
    );

    const observations = [
      discoveryDocument.observation,
      systemDocument.observation,
      stationDocument.observation,
      statusDocument.observation,
      ...(vehicleDocument === undefined ? [] : [vehicleDocument.observation]),
    ];
    const state: GbfsFetchState = {
      gbfs: discoveryDocument.cached,
      system_information: systemDocument.cached,
      station_information: stationDocument.cached,
      station_status: statusDocument.cached,
      ...(vehicleDocument === undefined
        ? {}
        : { vehicle_types: vehicleDocument.cached }),
    };

    return {
      discovery,
      system: systemResult.value,
      stations: stationResult.value,
      statuses: statusResult.value,
      vehicleTypes,
      warnings: [
        ...discoveryResult.warnings,
        ...systemResult.warnings,
        ...stationResult.warnings,
        ...statusResult.warnings,
        ...vehicleWarnings,
      ],
      observations,
      state,
    };
  }
}

export const fetchGbfsStationBundle = (
  source: GbfsSystemSource,
  options: GbfsClientOptions = {},
  previousState: GbfsFetchState = {},
): Promise<GbfsStationBundle> =>
  new GbfsClient(source, options).fetchStationBundle(previousState);
