import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import {
  applyCatalogOverrides,
  BUNDLED_CATALOG,
  loadCatalog,
  loadCatalogOverrides,
  normalizeMobilityDataCatalogRows,
  normalizeMobilityDataSystemId,
  parseMobilityDataSystemsCsv,
  parseMobilityDataCatalogMode,
  publishCatalog,
  sha256Hex,
  validateCatalogSnapshot,
} from "../catalog";
import type {
  CatalogPointer,
  CatalogSnapshot,
  MobilityDataAdmissionStats,
  MobilityDataCatalogMode,
  MobilityDataSystemRow,
} from "../catalog";
import type { SystemFeed } from "../durable";
import type { ProbeMessage } from "../queues/types";
import type { StatusCycle } from "../status";

const MAX_CATALOG_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_BATCH_SIZE = 100;
const MIN_ELIGIBLE_CATALOG_ROWS = 100;
const PROBE_RECONCILIATION_DELAY = "30 minutes";

export interface CatalogRefreshParams {
  reason?: string;
}

interface CatalogFetchResult {
  csv: string;
  etag: string | null;
  sourceHash: string;
}

interface PublicationStepResult {
  pointer: CatalogPointer;
  published: boolean;
  admission: MobilityDataAdmissionStats;
}

interface EnqueueStepResult {
  cycleId: string;
  systemCount: number;
}

const probeCycle = (
  cycleId: string,
  catalogVersion: string,
  catalogPublishedAt: string,
  startedAt: string,
  systemsScheduled: number,
): StatusCycle => ({
  schema_version: 1,
  cycle_id: cycleId,
  catalog_version: catalogVersion,
  catalog_published_at: catalogPublishedAt,
  started_at: startedAt,
  systems_scheduled: systemsScheduled,
  systems_completed: 0,
  systems_healthy: 0,
  systems_degraded: 0,
  systems_unavailable: 0,
  last_probe_activity_at: null,
  state: systemsScheduled === 0 ? "complete" : "probing",
});

export const reconcileCatalogProbeCycle = async (
  env: Pick<Env, "SYSTEM_FEEDS">,
  catalog: CatalogSnapshot,
  cycle: StatusCycle,
  checkedAt: Date,
): Promise<StatusCycle> => {
  const enabledSystemIds = catalog.systems
    .filter((system) => system.enabled)
    .map((system) => system.system_id);
  const coordinator = env.SYSTEM_FEEDS.getByName("__openbike_status__", {
    locationHint: "enam",
  }) as unknown as Pick<SystemFeed, "reconcileProbeCycle">;
  return coordinator.reconcileProbeCycle(
    cycle,
    enabledSystemIds,
    checkedAt.toISOString(),
  );
};

const readBoundedText = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new Error("Catalog source exceeded the response-size limit");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Catalog source exceeded response-size limit");
        throw new Error("Catalog source exceeded the response-size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
};

const validateCatalogSourceUrl = (rawUrl: string): URL => {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "raw.githubusercontent.com" ||
    !/^\/MobilityData\/gbfs\/(?:master|main)\/systems\.csv$/.test(
      url.pathname,
    ) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    throw new Error("Catalog source URL is not on the reviewed allowlist");
  }
  return url;
};

export const fetchCatalogSource = async (
  sourceUrl: string,
): Promise<CatalogFetchResult> => {
  const url = validateCatalogSourceUrl(sourceUrl);
  const response = await fetch(url, {
    // Workerd currently rejects `redirect: "error"` before issuing the
    // request. Keep redirect handling explicit so an allowlisted source
    // cannot move the catalog fetch to an unreviewed destination.
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "text/csv" },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Catalog source redirected unexpectedly");
  }
  if (!response.ok) {
    throw new Error(`Catalog source returned HTTP ${response.status}`);
  }
  const csv = await readBoundedText(response, MAX_CATALOG_SOURCE_BYTES);
  return {
    csv,
    etag: response.headers.get("etag"),
    sourceHash: await sha256Hex(csv),
  };
};

export const validateMobilityDataRows = (
  rows: readonly MobilityDataSystemRow[],
  minimumRows = 100,
): void => {
  if (rows.length < minimumRows) {
    throw new Error("Catalog source contains too few systems");
  }
};

const workflowVersion = (timestamp: Date, sourceHash: string): string =>
  `md-${timestamp.toISOString().replace(/[-:.]/g, "")}-${sourceHash.slice(0, 16)}`;

export const buildCatalogCandidate = (
  rows: readonly MobilityDataSystemRow[],
  generatedAt: Date,
  sourceHash: string,
  sourceEtag: string | null,
  options: {
    mode?: MobilityDataCatalogMode;
    minimumEligibleRows?: number;
  } = {},
): CatalogSnapshot => {
  const rowGroups = new Map<string, MobilityDataSystemRow[]>();
  for (const row of rows) {
    const normalizedId = normalizeMobilityDataSystemId(row.system_id);
    if (normalizedId === null) continue;
    const group = rowGroups.get(normalizedId) ?? [];
    group.push(row);
    rowGroups.set(normalizedId, group);
  }
  const reviewedSystems = BUNDLED_CATALOG.systems.map((system) => {
    const sourceId =
      normalizeMobilityDataSystemId(system.source_system_id) ?? system.system_id;
    const group = rowGroups.get(sourceId);
    // Ambiguous upstream metadata never mutates a manually reviewed entry.
    const upstream = group?.length === 1 ? group[0] : undefined;
    if (upstream === undefined) return system;
    const upstreamName = upstream.name.trim();
    return {
      ...system,
      name:
        upstreamName.length > 0 && upstreamName.length <= 500
          ? upstreamName
          : system.name,
      country_code:
        /^[A-Z]{2}$/.test(upstream.country_code) && upstream.country_code !== ""
          ? upstream.country_code
          : system.country_code,
    };
  });
  const admission = normalizeMobilityDataCatalogRows(rows, reviewedSystems);
  if (
    (options.mode ?? "reviewed") === "candidates" &&
    admission.stats.eligible_rows <
      (options.minimumEligibleRows ?? MIN_ELIGIBLE_CATALOG_ROWS)
  ) {
    throw new Error("Catalog source contains too few eligible public systems");
  }
  const systems = [
    ...reviewedSystems,
    ...((options.mode ?? "reviewed") === "candidates"
      ? admission.systems
      : []),
  ];
  return validateCatalogSnapshot({
    schema_version: 1,
    version: workflowVersion(generatedAt, sourceHash),
    generated_at: generatedAt.toISOString(),
    source_url: BUNDLED_CATALOG.source_url,
    source_etag: sourceEtag,
    systems,
  });
};

export const probeMessage = (
  catalogVersion: string,
  cycleId: string,
  systemId: string,
  enqueuedAt: Date,
  catalogPublishedAt: string,
  systemsScheduled: number,
): ProbeMessage => ({
  schema_version: 1,
  cycle_id: cycleId,
  catalog_version: catalogVersion,
  catalog_published_at: catalogPublishedAt,
  system_id: systemId,
  idempotency_key: `${catalogVersion}:${systemId}`,
  enqueued_at: enqueuedAt.toISOString(),
  systems_scheduled: systemsScheduled,
});

export const enqueueCatalogProbes = async (
  queue: Queue<ProbeMessage>,
  catalog: CatalogSnapshot,
  cycleId: string,
  enqueuedAt: Date,
  catalogPublishedAt: string,
): Promise<number> => {
  const enabled = catalog.systems.filter((system) => system.enabled);
  for (let offset = 0; offset < enabled.length; offset += MAX_QUEUE_BATCH_SIZE) {
    const messages = enabled
      .slice(offset, offset + MAX_QUEUE_BATCH_SIZE)
      .map((system) => ({
        body: probeMessage(
          catalog.version,
          cycleId,
          system.system_id,
          enqueuedAt,
          catalogPublishedAt,
          enabled.length,
        ),
        contentType: "json" as const,
      }));
    await queue.sendBatch(messages);
  }
  return enabled.length;
};

export class CatalogRefreshWorkflow extends WorkflowEntrypoint<
  Env,
  CatalogRefreshParams
> {
  override async run(
    event: Readonly<WorkflowEvent<CatalogRefreshParams>>,
    step: WorkflowStep,
  ): Promise<{ catalogVersion: string; systemsScheduled: number }> {
    const publication = await step.do<PublicationStepResult>(
      "validate-and-publish-catalog",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
      async () => {
        const source = await fetchCatalogSource(this.env.CATALOG_SOURCE_URL);
        const rows = parseMobilityDataSystemsCsv(source.csv);
        validateMobilityDataRows(rows);
        const mode = parseMobilityDataCatalogMode(
          this.env.MOBILITYDATA_CATALOG_MODE,
        );
        const base = buildCatalogCandidate(
          rows,
          event.timestamp,
          source.sourceHash,
          source.etag,
          { mode },
        );
        const admission = normalizeMobilityDataCatalogRows(
          rows,
          BUNDLED_CATALOG.systems,
        ).stats;
        console.info(
          JSON.stringify({
            event: "mobilitydata_catalog_admission",
            mode,
            ...admission,
          }),
        );
        const overrides = await loadCatalogOverrides(this.env);
        const candidate = validateCatalogSnapshot(
          applyCatalogOverrides(base, overrides),
        );
        const result = await publishCatalog(this.env, candidate, event.timestamp);
        return {
          pointer: result.pointer,
          published: result.published,
          admission,
        };
      },
    );

    const cycleId = `catalog-${publication.pointer.version}`;
    await step.do(
      "initialize-public-status",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const catalog = await loadCatalog(this.env, {
          version: publication.pointer.version,
          allowBundledFallback: false,
        });
        const systemsScheduled = catalog.systems.filter(
          (system) => system.enabled,
        ).length;
        const coordinator = this.env.SYSTEM_FEEDS.getByName(
          "__openbike_status__",
          { locationHint: "enam" },
        ) as unknown as Pick<SystemFeed, "initializeProbeCycle">;
        return coordinator.initializeProbeCycle(
          probeCycle(
            cycleId,
            publication.pointer.version,
            publication.pointer.published_at,
            event.timestamp.toISOString(),
            systemsScheduled,
          ),
        );
      },
    );

    const enqueueResult = await step.do<EnqueueStepResult>(
      "enqueue-system-probes",
      { retries: { limit: 4, delay: "30 seconds", backoff: "exponential" } },
      async () => {
        const catalog = await loadCatalog(this.env, {
          version: publication.pointer.version,
          allowBundledFallback: false,
        });
        const systemCount = await enqueueCatalogProbes(
          this.env.PROBE_QUEUE,
          catalog,
          cycleId,
          event.timestamp,
          publication.pointer.published_at,
        );
        return { cycleId, systemCount };
      },
    );

    if (enqueueResult.systemCount > 0) {
      await step.sleep("wait-for-system-probes", PROBE_RECONCILIATION_DELAY);
    }

    await step.do(
      "reconcile-system-probes",
      { retries: { limit: 4, delay: "30 seconds", backoff: "exponential" } },
      async () => {
        const catalog = await loadCatalog(this.env, {
          version: publication.pointer.version,
          allowBundledFallback: false,
        });
        return reconcileCatalogProbeCycle(
          this.env,
          catalog,
          probeCycle(
            cycleId,
            publication.pointer.version,
            publication.pointer.published_at,
            event.timestamp.toISOString(),
            enqueueResult.systemCount,
          ),
          new Date(),
        );
      },
    );

    return {
      catalogVersion: publication.pointer.version,
      systemsScheduled: enqueueResult.systemCount,
    };
  }
}
