import { DurableObject } from "cloudflare:workers";

import type { CatalogSystem } from "../catalog";
import { CatalogSystemSchema, stableJson } from "../catalog";
import { runtimeConfig } from "../config";
import type { FeedObservation, Warning } from "../contracts";
import { getGbfsFailureFeedName } from "../gbfs/client";
import { createStationFeedClient } from "../feeds/client";
import { catalogSource } from "../feeds/source";
import type {
  CachedGbfsDocument,
  GbfsFetchFeedName,
  GbfsFetchState,
  GbfsStationBundle,
} from "../gbfs/types";
import { emitMetric, logEvent } from "../observability";
import { beginProbeCycle, StatusCycleSchema, SystemProbeStatusSchema } from "../status";
import type { StatusCycle, SystemProbeStatus } from "../status";
import {
  circuitAfterFailure,
  circuitAfterSuccess,
  classifyProviderError,
} from "./circuit";
import type {
  AvailabilityQuery,
  CircuitRecord,
  PersistedSnapshotMetadata,
  ProbeOptions,
  ProviderErrorClass,
  SnapshotRecord,
  SystemFeedAvailabilityResult,
  SystemFeedFeedHealth,
  SystemFeedHealth,
  SystemFeedProbeDiscoveryMetadata,
  SystemFeedProbeResult,
  SystemFeedSnapshot,
  SystemFeedSourceObservation,
  SystemFeedSourceObservations,
  SystemFeedStationResult,
} from "./types";

const SNAPSHOT_SCHEMA_VERSION = 2;
const DEFAULT_STATUS_TTL_SECONDS = 60;
const MIN_STATUS_TTL_SECONDS = 30;
const MAX_STATUS_TTL_SECONDS = 3_600;
const DEFAULT_MAX_STALENESS_SECONDS = 180;
const MAX_ALLOWED_STALENESS_SECONDS = 86_400;
// The request Worker can fan out to four SystemFeed objects. Keeping each
// serialized snapshot at or below 4 MiB bounds that fan-out to 16 MiB before
// object overhead and response shaping, leaving substantial room below both
// the 128 MiB isolate limit and the PRD's 80 MiB beta gate.
export const MAX_NORMALIZED_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_SNAPSHOT_FANOUT_BYTES =
  MAX_NORMALIZED_SNAPSHOT_BYTES * 4;
const MAX_STATION_RECORDS = 100_000;
const FEED_CACHE_CHUNK_CHARACTERS = 256 * 1024;
const OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_OBSERVATIONS = 512;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RECEIPTS = 512;
// Workers KV accepts at most one write per second to the same key. The status
// coordinator persists all progress in SQLite, but only publishes the initial
// and terminal snapshots to the shared status pointer. Keep a small margin so
// those two writes cannot straddle the provider's exact one-second boundary.
const STATUS_POINTER_MIN_WRITE_INTERVAL_MS = 1_100;

const KNOWN_FEEDS = new Set<GbfsFetchFeedName>([
  "gbfs",
  "manifest",
  "system_information",
  "station_information",
  "station_status",
  "vehicle_types",
  "free_bike_status",
  "vehicle_status",
  "geofencing_zones",
]);

const INITIAL_CIRCUIT: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  openedUntilMs: null,
  lastErrorClass: null,
  lastErrorAtMs: null,
  lastSuccessAtMs: null,
  successes: 0,
  failures: 0,
};

const MIGRATION_ONE = [
  `CREATE TABLE IF NOT EXISTS system_config (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    payload_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    slot TEXT PRIMARY KEY CHECK (slot IN ('current', 'last_good')),
    schema_version INTEGER NOT NULL,
    metadata_json TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    station_count INTEGER NOT NULL,
    status_count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS station_rows (
    slot TEXT NOT NULL CHECK (slot IN ('current', 'last_good')),
    station_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (slot, station_id)
  )`,
  `CREATE TABLE IF NOT EXISTS status_rows (
    slot TEXT NOT NULL CHECK (slot IN ('current', 'last_good')),
    station_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (slot, station_id)
  )`,
  `CREATE TABLE IF NOT EXISTS feed_cache (
    feed_name TEXT PRIMARY KEY,
    metadata_json TEXT NOT NULL,
    url TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS feed_cache_chunks (
    feed_name TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    PRIMARY KEY (feed_name, chunk_index),
    FOREIGN KEY (feed_name) REFERENCES feed_cache(feed_name) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS circuit (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL,
    opened_until_ms INTEGER,
    last_error_class TEXT,
    last_error_at_ms INTEGER,
    last_success_at_ms INTEGER,
    successes INTEGER NOT NULL,
    failures INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_name TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL,
    http_status INTEGER,
    validation_status TEXT NOT NULL,
    ttl_seconds INTEGER,
    content_hash TEXT,
    provider_last_updated TEXT,
    last_error_class TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS probe_receipts (
    idempotency_key TEXT PRIMARY KEY,
    completed_at_ms INTEGER NOT NULL,
    result_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS materialized_status_cycle (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    cycle_id TEXT NOT NULL,
    catalog_version TEXT NOT NULL,
    catalog_published_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    systems_scheduled INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS materialized_probe_results (
    cycle_id TEXT NOT NULL,
    system_id TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    terminal INTEGER NOT NULL,
    PRIMARY KEY (cycle_id, system_id)
  )`,
  "CREATE INDEX IF NOT EXISTS observations_fetched_idx ON observations(fetched_at_ms)",
] as const;

// Migration 1 existed before vehicle types were stored row-wise. Keep this
// repair as a separate version so objects that already recorded v1 are
// upgraded instead of assuming the current v1 definition was re-run.
const MIGRATION_TWO = [
  `CREATE TABLE IF NOT EXISTS vehicle_type_rows (
    slot TEXT NOT NULL CHECK (slot IN ('current', 'last_good')),
    vehicle_type_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (slot, vehicle_type_id)
  )`,
] as const;

const MIGRATION_THREE = [
  `CREATE TABLE IF NOT EXISTS status_pointer_publication (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    published_at_ms INTEGER NOT NULL,
    cycle_json TEXT NOT NULL
  )`,
] as const;

const MIGRATION_FOUR = [
  `CREATE TABLE IF NOT EXISTS refresh_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_at_ms INTEGER NOT NULL,
    succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
  )`,
  "CREATE INDEX IF NOT EXISTS refresh_outcomes_completed_idx ON refresh_outcomes(completed_at_ms)",
] as const;

const MIGRATION_FIVE = [
  `CREATE TABLE IF NOT EXISTS snapshot_chunks (
    slot TEXT NOT NULL CHECK (slot IN ('current', 'last_good')),
    chunk_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (slot, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS map_budget (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    day TEXT NOT NULL, month TEXT NOT NULL,
    daily_count INTEGER NOT NULL, monthly_count INTEGER NOT NULL
  )`,
] as const;

const MIGRATIONS = [
  { version: 1, statements: MIGRATION_ONE },
  { version: 2, statements: MIGRATION_TWO },
  { version: 3, statements: MIGRATION_THREE },
  { version: 4, statements: MIGRATION_FOUR },
  { version: 5, statements: MIGRATION_FIVE },
] as const;

const asIso = (milliseconds: number | null): string | null =>
  milliseconds === null ? null : new Date(milliseconds).toISOString();

const parseMetadata = (json: string): CachedGbfsDocument["metadata"] => {
  const value = JSON.parse(json) as Record<string, unknown>;
  return {
    ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
    ...(typeof value.lastModified === "string"
      ? { lastModified: value.lastModified }
      : {}),
    ...(typeof value.contentHash === "string"
      ? { contentHash: value.contentHash }
      : {}),
  };
};

const bundleSnapshot = (bundle: GbfsStationBundle): SystemFeedSnapshot => {
  const sourceObservations: SystemFeedSourceObservations = {};
  for (const observation of bundle.observations) {
    sourceObservations[observation.feed_name] = {
      fetched_at: observation.fetched_at,
      provider_last_updated: observation.provider_last_updated,
      ttl_seconds: observation.ttl_seconds,
    };
  }
  return {
    discovery: bundle.discovery,
    source_observations: sourceObservations,
    system: bundle.system,
    stations: bundle.stations,
    statuses: bundle.statuses,
    vehicleTypes: bundle.vehicleTypes,
    warnings: bundle.warnings,
  };
};

const statusTtlSeconds = (bundle: GbfsStationBundle): number => {
  const observation = bundle.observations.find(
    (candidate) => candidate.feed_name === "station_status",
  );
  return Math.max(
    MIN_STATUS_TTL_SECONDS,
    Math.min(
      MAX_STATUS_TTL_SECONDS,
      observation?.ttl_seconds ??
        bundle.discovery.ttlSeconds ??
        DEFAULT_STATUS_TTL_SECONDS,
    ),
  );
};

export const normalizedSnapshotByteLength = (snapshot: unknown): number =>
  new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;

export const assertNormalizedSnapshotWithinBudget = (
  snapshot: unknown,
): void => {
  if (normalizedSnapshotByteLength(snapshot) <= MAX_NORMALIZED_SNAPSHOT_BYTES) {
    return;
  }
  const error = new Error("Normalized provider result exceeded storage limits");
  Object.assign(error, { code: "RESPONSE_TOO_LARGE", retryable: false });
  throw error;
};

const fallbackWarning = (systemId: string, stale: boolean): Warning => ({
  code: stale ? "STALE_DATA" : "PROVIDER_UNAVAILABLE",
  message: stale
    ? "The provider refresh failed, so a bounded stale snapshot was used."
    : "The provider refresh failed; the still-valid cached snapshot was used.",
  system_id: systemId,
  retryable: true,
});

export const evaluateStatusSourceFreshness = (
  observation: SystemFeedSourceObservation | undefined,
  fallbackFetchedAtMs: number,
  fallbackTtlSeconds: number,
  nowMs = Date.now(),
): { ageSeconds: number; stale: boolean } => {
  const providerObservedAtMs =
    observation?.provider_last_updated === null ||
    observation?.provider_last_updated === undefined
      ? Number.NaN
      : Date.parse(observation.provider_last_updated);
  const fetchedAtMs =
    observation === undefined ? Number.NaN : Date.parse(observation.fetched_at);
  const observedAtMs = Number.isFinite(providerObservedAtMs)
    ? providerObservedAtMs
    : Number.isFinite(fetchedAtMs)
      ? fetchedAtMs
      : fallbackFetchedAtMs;
  const ttlSeconds =
    Number.isInteger(observation?.ttl_seconds) &&
    (observation?.ttl_seconds ?? -1) >= 0
      ? (observation?.ttl_seconds as number)
      : fallbackTtlSeconds;
  const ageSeconds = Math.max(
    0,
    Math.floor((nowMs - observedAtMs) / 1_000),
  );
  return { ageSeconds, stale: ageSeconds > ttlSeconds };
};

export class SystemFeed extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private refreshPromise: Promise<SnapshotRecord> | null = null;
  private statusMaterializePromise: Promise<StatusCycle> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )`,
    );
    const applied = new Set(
      this.sql
        .exec<{ version: number }>("SELECT version FROM schema_migrations")
        .toArray()
        .map((row) => row.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const statement of migration.statements) this.sql.exec(statement);
        this.sql.exec(
          "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(?, ?)",
          migration.version,
          Date.now(),
        );
      });
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO circuit(
        singleton, state, consecutive_failures, opened_until_ms,
        last_error_class, last_error_at_ms, last_success_at_ms, successes, failures
      ) VALUES(1, 'closed', 0, NULL, NULL, NULL, NULL, 0, 0)`,
    );
  }

  private readConfiguredSystem(): CatalogSystem | null {
    const row = this.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM system_config WHERE singleton = 1",
      )
      .toArray()[0];
    return row === undefined
      ? null
      : CatalogSystemSchema.parse(JSON.parse(row.payload_json));
  }

  private configure(system: CatalogSystem): CatalogSystem {
    const validated = CatalogSystemSchema.parse(system);
    const existing = this.readConfiguredSystem();
    if (existing !== null && existing.system_id !== validated.system_id) {
      throw new Error("A SystemFeed object cannot change system identity");
    }
    if (existing === null || stableJson(existing) !== stableJson(validated)) {
      this.sql.exec(
        `INSERT INTO system_config(singleton, payload_json, updated_at_ms)
         VALUES(1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`,
        stableJson(validated),
        Date.now(),
      );
    }
    return validated;
  }

  private readCircuit(): CircuitRecord {
    const row = this.sql
      .exec<{
        state: string;
        consecutive_failures: number;
        opened_until_ms: number | null;
        last_error_class: string | null;
        last_error_at_ms: number | null;
        last_success_at_ms: number | null;
        successes: number;
        failures: number;
      }>("SELECT * FROM circuit WHERE singleton = 1")
      .one();
    return {
      state:
        row.state === "open" || row.state === "half_open"
          ? row.state
          : "closed",
      consecutiveFailures: row.consecutive_failures,
      openedUntilMs: row.opened_until_ms,
      lastErrorClass: row.last_error_class as ProviderErrorClass | null,
      lastErrorAtMs: row.last_error_at_ms,
      lastSuccessAtMs: row.last_success_at_ms,
      successes: row.successes,
      failures: row.failures,
    };
  }

  private writeCircuit(circuit: CircuitRecord): void {
    this.sql.exec(
      `UPDATE circuit SET state = ?, consecutive_failures = ?,
       opened_until_ms = ?, last_error_class = ?, last_error_at_ms = ?,
       last_success_at_ms = ?, successes = ?, failures = ? WHERE singleton = 1`,
      circuit.state,
      circuit.consecutiveFailures,
      circuit.openedUntilMs,
      circuit.lastErrorClass,
      circuit.lastErrorAtMs,
      circuit.lastSuccessAtMs,
      circuit.successes,
      circuit.failures,
    );
  }

  private readSnapshot(slot: "current" | "last_good"): SnapshotRecord | null {
    const row = this.sql
      .exec<{
        metadata_json: string;
        fetched_at_ms: number;
        expires_at_ms: number;
        content_hash: string;
        station_count: number;
        status_count: number;
      }>("SELECT * FROM snapshots WHERE slot = ?", slot)
      .toArray()[0];
    if (row === undefined) return null;
    const metadata = JSON.parse(row.metadata_json) as PersistedSnapshotMetadata;
    const chunks = this.sql.exec<{ payload_json: string }>(
      "SELECT payload_json FROM snapshot_chunks WHERE slot = ? ORDER BY chunk_index", slot,
    ).toArray();
    const packed = chunks.length ? JSON.parse(chunks.map(chunk => chunk.payload_json).join("")) as Pick<SystemFeedSnapshot, "stations" | "statuses" | "vehicleTypes"> : null;
    const stations = packed?.stations ?? this.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM station_rows WHERE slot = ? ORDER BY station_id",
        slot,
      )
      .toArray()
      .map((record) => JSON.parse(record.payload_json));
    const statuses = packed?.statuses ?? this.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM status_rows WHERE slot = ? ORDER BY station_id",
        slot,
      )
      .toArray()
      .map((record) => JSON.parse(record.payload_json));
    const vehicleTypes = packed?.vehicleTypes ?? this.sql
      .exec<{ payload_json: string }>(
        `SELECT payload_json FROM vehicle_type_rows
         WHERE slot = ? ORDER BY vehicle_type_id`,
        slot,
      )
      .toArray()
      .map((record) => JSON.parse(record.payload_json));
    if (
      stations.length !== row.station_count ||
      statuses.length !== row.status_count
    ) {
      throw new Error("Persisted snapshot row count is inconsistent");
    }
    return {
      slot,
      snapshot: {
        discovery: metadata.discovery,
        ...(metadata.source_observations === undefined
          ? {}
          : { source_observations: metadata.source_observations }),
        system: metadata.system,
        stations,
        statuses,
        vehicleTypes,
        warnings: metadata.warnings,
      },
      fetchedAtMs: row.fetched_at_ms,
      expiresAtMs: row.expires_at_ms,
      contentHash: row.content_hash,
    };
  }

  private loadFetchState(): GbfsFetchState {
    const rows = this.sql
      .exec<{
        feed_name: string;
        metadata_json: string;
        url: string | null;
      }>("SELECT feed_name, metadata_json, url FROM feed_cache")
      .toArray();
    const state: GbfsFetchState = {};
    for (const row of rows) {
      if (!KNOWN_FEEDS.has(row.feed_name as GbfsFetchFeedName)) continue;
      const chunks = this.sql
        .exec<{ chunk_text: string }>(
          `SELECT chunk_text FROM feed_cache_chunks
           WHERE feed_name = ? ORDER BY chunk_index`,
          row.feed_name,
        )
        .toArray();
      if (chunks.length === 0) continue;
      const document = JSON.parse(chunks.map((chunk) => chunk.chunk_text).join(""));
      const cached: CachedGbfsDocument = {
        document,
        metadata: parseMetadata(row.metadata_json),
        ...(row.url === null ? {} : { url: row.url }),
      };
      state[row.feed_name as GbfsFetchFeedName] = cached;
    }
    return state;
  }

  private persistFeedState(state: GbfsFetchState): void {
    this.sql.exec("DELETE FROM feed_cache_chunks");
    this.sql.exec("DELETE FROM feed_cache");
    for (const [feedName, cached] of Object.entries(state)) {
      if (cached === undefined || !KNOWN_FEEDS.has(feedName as GbfsFetchFeedName)) {
        continue;
      }
      this.sql.exec(
        "INSERT INTO feed_cache(feed_name, metadata_json, url) VALUES(?, ?, ?)",
        feedName,
        stableJson(cached.metadata),
        cached.url ?? null,
      );
      const documentJson = JSON.stringify(cached.document);
      for (
        let offset = 0, index = 0;
        offset < documentJson.length;
        offset += FEED_CACHE_CHUNK_CHARACTERS, index += 1
      ) {
        this.sql.exec(
          `INSERT INTO feed_cache_chunks(feed_name, chunk_index, chunk_text)
           VALUES(?, ?, ?)`,
          feedName,
          index,
          documentJson.slice(offset, offset + FEED_CACHE_CHUNK_CHARACTERS),
        );
      }
    }
  }

  private persistObservations(
    observations: readonly FeedObservation[],
    nowMs: number,
  ): void {
    for (const observation of observations) {
      const fetchedAtMs = Date.parse(observation.fetched_at);
      this.sql.exec(
        `INSERT INTO observations(
          feed_name, fetched_at_ms, http_status, validation_status,
          ttl_seconds, content_hash, provider_last_updated, last_error_class
        ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`,
        observation.feed_name,
        Number.isFinite(fetchedAtMs) ? fetchedAtMs : nowMs,
        observation.http_status,
        observation.validation_status,
        observation.ttl_seconds,
        observation.content_hash,
        observation.provider_last_updated,
      );
    }
    this.sql.exec(
      "DELETE FROM observations WHERE fetched_at_ms < ?",
      nowMs - OBSERVATION_RETENTION_MS,
    );
    this.sql.exec(
      `DELETE FROM observations WHERE id NOT IN (
        SELECT id FROM observations ORDER BY id DESC LIMIT ?
      )`,
      MAX_OBSERVATIONS,
    );
  }

  private persistRefreshOutcome(succeeded: boolean, completedAtMs: number): void {
    this.sql.exec(
      "INSERT INTO refresh_outcomes(completed_at_ms, succeeded) VALUES(?, ?)",
      completedAtMs,
      succeeded ? 1 : 0,
    );
    this.sql.exec(
      "DELETE FROM refresh_outcomes WHERE completed_at_ms < ?",
      completedAtMs - OBSERVATION_RETENTION_MS,
    );
    this.sql.exec(
      `DELETE FROM refresh_outcomes WHERE id NOT IN (
        SELECT id FROM refresh_outcomes ORDER BY id DESC LIMIT ?
      )`,
      MAX_OBSERVATIONS,
    );
  }

  private persistSnapshot(
    bundle: GbfsStationBundle,
    fetchedAtMs: number,
    expiresAtMs: number,
    contentHash: string,
  ): SnapshotRecord {
    const snapshot = bundleSnapshot(bundle);
    const metadata: PersistedSnapshotMetadata = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      discovery: snapshot.discovery,
      ...(snapshot.source_observations === undefined
        ? {}
        : { source_observations: snapshot.source_observations }),
      system: snapshot.system,
      warnings: snapshot.warnings,
    };
    // Preserve an existing row-wise snapshot during the first post-upgrade write.
    // Subsequent refreshes copy a handful of bounded chunks, not every station.
    const previous = this.readSnapshot("current");
    this.ctx.storage.transactionSync(() => {
      if (previous) this.writeSnapshotChunks("last_good", previous.snapshot);
      this.sql.exec("DELETE FROM snapshots WHERE slot = 'last_good'");
      this.sql.exec(
        `INSERT INTO snapshots SELECT 'last_good', schema_version, metadata_json,
          fetched_at_ms, expires_at_ms, content_hash, station_count, status_count
          FROM snapshots WHERE slot = 'current'`,
      );
      this.sql.exec("DELETE FROM snapshots WHERE slot = 'current'");
      this.sql.exec(
        `INSERT INTO snapshots(slot, schema_version, metadata_json, fetched_at_ms,
          expires_at_ms, content_hash, station_count, status_count)
         VALUES('current', ?, ?, ?, ?, ?, ?, ?)`,
        SNAPSHOT_SCHEMA_VERSION, stableJson(metadata), fetchedAtMs, expiresAtMs,
        contentHash, snapshot.stations.length, snapshot.statuses.length,
      );
      this.writeSnapshotChunks("current", snapshot);
      // Old storage is removed only after both replacement snapshots are written,
      // in the same transaction. Legacy reads remain supported until then.
      this.sql.exec("DELETE FROM station_rows");
      this.sql.exec("DELETE FROM status_rows");
      this.sql.exec("DELETE FROM vehicle_type_rows");
      this.persistFeedState(bundle.state);
      this.persistObservations(bundle.observations, fetchedAtMs);
      this.persistRefreshOutcome(true, fetchedAtMs);
      this.writeCircuit(circuitAfterSuccess(this.readCircuit(), fetchedAtMs));
    });
    return {
      slot: "current",
      snapshot,
      fetchedAtMs,
      expiresAtMs,
      contentHash,
    };
  }

  private writeSnapshotChunks(slot: "current" | "last_good", snapshot: SystemFeedSnapshot): void {
    const payload = JSON.stringify({ stations: snapshot.stations, statuses: snapshot.statuses,
      vehicleTypes: snapshot.vehicleTypes });
    this.sql.exec("DELETE FROM snapshot_chunks WHERE slot = ?", slot);
    for (let offset = 0, index = 0; offset < payload.length;
      offset += FEED_CACHE_CHUNK_CHARACTERS, index++) {
      this.sql.exec("INSERT INTO snapshot_chunks VALUES(?, ?, ?)", slot, index,
        payload.slice(offset, offset + FEED_CACHE_CHUNK_CHARACTERS));
    }
  }

  // One global counter lends small request batches to Worker isolates. Limits
  // bound expensive map work across regions, not merely per IP or per server.
  async claimMapBudget(amount: number): Promise<boolean> {
    if (!Number.isInteger(amount) || amount < 1 || amount > 128) return false;
    const stamp = new Date().toISOString();
    const day = stamp.slice(0, 10), month = stamp.slice(0, 7);
    return this.ctx.storage.transactionSync(() => {
      const previous = this.sql.exec<{ day: string; month: string; daily_count: number; monthly_count: number }>(
        "SELECT * FROM map_budget WHERE singleton = 1",
      ).toArray()[0];
      const daily = previous?.day === day ? previous.daily_count : 0;
      const monthly = previous?.month === month ? previous.monthly_count : 0;
      if (daily + amount > 25_000 || monthly + amount > 500_000) {
        console.warn(JSON.stringify({ event: "map_budget_exhausted", daily_count: daily, monthly_count: monthly }));
        return false;
      }
      this.sql.exec(`INSERT OR REPLACE INTO map_budget VALUES(1, ?, ?, ?, ?)`,
        day, month, daily + amount, monthly + amount);
      return true;
    });
  }

  private markRefreshFailure(error: unknown, nowMs: number): ProviderErrorClass {
    const failure = classifyProviderError(error);
    const feedName = getGbfsFailureFeedName(error) ?? "gbfs";
    this.ctx.storage.transactionSync(() => {
      this.writeCircuit(circuitAfterFailure(this.readCircuit(), failure, nowMs));
      this.persistRefreshOutcome(false, nowMs);
      this.sql.exec(
        `INSERT INTO observations(
          feed_name, fetched_at_ms, http_status, validation_status,
          ttl_seconds, content_hash, provider_last_updated, last_error_class
        ) VALUES(?, ?, NULL, 'invalid', NULL, NULL, NULL, ?)`,
        feedName,
        nowMs,
        failure.errorClass,
      );
      this.sql.exec(
        "DELETE FROM observations WHERE fetched_at_ms < ?",
        nowMs - OBSERVATION_RETENTION_MS,
      );
      this.sql.exec(
        `DELETE FROM observations WHERE id NOT IN (
          SELECT id FROM observations ORDER BY id DESC LIMIT ?
        )`,
        MAX_OBSERVATIONS,
      );
    });
    return failure.errorClass;
  }

  private async refresh(system: CatalogSystem): Promise<SnapshotRecord> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    this.refreshPromise = this.performRefresh(system).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async performRefresh(system: CatalogSystem): Promise<SnapshotRecord> {
    const startedAt = Date.now();
    const circuit = this.readCircuit();
    if (
      circuit.state === "open" &&
      circuit.openedUntilMs !== null &&
      circuit.openedUntilMs > startedAt
    ) {
      const error = new Error("Provider circuit is temporarily open");
      Object.assign(error, { code: "CIRCUIT_OPEN", retryable: true });
      throw error;
    }
    if (circuit.state === "open") {
      this.sql.exec(
        "UPDATE circuit SET state = 'half_open' WHERE singleton = 1",
      );
    }

    try {
      const client = createStationFeedClient(catalogSource(system), {
        maxBytes: runtimeConfig(this.env).maxFeedBytes,
        timeoutMs: 10_000,
      });
      const bundle = await client.fetchStationBundle(this.loadFetchState());
      if (
        bundle.stations.length > MAX_STATION_RECORDS ||
        bundle.statuses.length > MAX_STATION_RECORDS
      ) {
        const error = new Error("Normalized provider result exceeded record limits");
        Object.assign(error, { code: "RESPONSE_TOO_LARGE", retryable: false });
        throw error;
      }
      const snapshot = bundleSnapshot(bundle);
      assertNormalizedSnapshotWithinBudget(snapshot);
      const fetchedAtMs = Date.now();
      const ttlSeconds = statusTtlSeconds(bundle);
      const contentHash = await crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(stableJson(snapshot)))
        .then((value) =>
          [...new Uint8Array(value)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        );
      const persisted = this.persistSnapshot(
        bundle,
        fetchedAtMs,
        fetchedAtMs + ttlSeconds * 1_000,
        contentHash,
      );
      emitMetric(this.env, {
        index: system.system_id,
        event: "provider_refresh",
        component: "system_feed",
        operation: "refresh",
        outcome: "success",
        durationMs: Date.now() - startedAt,
        resultCount: bundle.stations.length,
        circuitState: "closed",
      });
      return persisted;
    } catch (error) {
      const errorClass = this.markRefreshFailure(error, Date.now());
      const failure = classifyProviderError(error);
      logEvent("warn", "provider_refresh_failed", {
        system_id: system.system_id,
        component: "system_feed",
        operation: "refresh",
        outcome: "failure",
        error_class: errorClass,
        duration_ms: Date.now() - startedAt,
      });
      emitMetric(this.env, {
        index: system.system_id,
        event: "provider_refresh",
        component: "system_feed",
        operation: "refresh",
        outcome: "failure",
        errorClass,
        durationMs: Date.now() - startedAt,
        circuitState: this.readCircuit().state,
      });
      const enrichedError =
        error instanceof Error ? error : new Error("Refresh failed");
      Object.assign(enrichedError, {
        providerErrorClass: errorClass,
        retryable: failure.retryable,
      });
      throw enrichedError;
    }
  }

  private availabilityResult(
    record: SnapshotRecord,
    nowMs: number,
    maxStalenessSeconds: number,
    addStaleWarning: boolean,
  ): SystemFeedAvailabilityResult {
    const ageSeconds = Math.max(
      0,
      Math.floor((nowMs - record.fetchedAtMs) / 1_000),
    );
    if (ageSeconds > maxStalenessSeconds) {
      const error = new Error("No snapshot is within the allowed staleness window");
      Object.assign(error, { code: "STALE_DATA", retryable: true });
      throw error;
    }
    const stale = nowMs > record.expiresAtMs;
    return {
      ...record.snapshot,
      warnings: addStaleWarning
        ? [
            ...record.snapshot.warnings,
            fallbackWarning(record.snapshot.system.system_id, stale),
          ]
        : record.snapshot.warnings,
      fetched_at: new Date(record.fetchedAtMs).toISOString(),
      expires_at: new Date(record.expiresAtMs).toISOString(),
      ttl_seconds: Math.max(
        0,
        Math.round((record.expiresAtMs - record.fetchedAtMs) / 1_000),
      ),
      age_seconds: ageSeconds,
      stale,
      cache_status: stale ? "stale" : "fresh",
      snapshot_slot: record.slot,
    };
  }

  async getAvailability(
    query: AvailabilityQuery = {},
  ): Promise<SystemFeedAvailabilityResult> {
    const system =
      query.catalogSystem === undefined
        ? this.readConfiguredSystem()
        : this.configure(query.catalogSystem);
    if (system === null) {
      throw new Error("SystemFeed has not been configured with a catalog system");
    }
    const nowMs = Date.now();
    const maxStalenessSeconds = Math.max(
      0,
      Math.min(
        query.maxStalenessSeconds ?? DEFAULT_MAX_STALENESS_SECONDS,
        MAX_ALLOWED_STALENESS_SECONDS,
      ),
    );
    const current = this.readSnapshot("current");
    if (query.cacheOnly) {
      const retained = current ?? this.readSnapshot("last_good");
      if (!retained) throw new Error("No retained station snapshot");
      return this.availabilityResult(retained, nowMs, maxStalenessSeconds, nowMs > retained.expiresAtMs);
    }
    if (
      query.forceRefresh !== true &&
      current !== null &&
      nowMs <= current.expiresAtMs
    ) {
      return this.availabilityResult(
        current,
        nowMs,
        maxStalenessSeconds,
        false,
      );
    }
    if (query.staleWhileRevalidate && query.forceRefresh !== true && current &&
        nowMs - current.fetchedAtMs <= maxStalenessSeconds * 1000) {
      this.ctx.waitUntil(this.refresh(system).catch(() => {}));
      return this.availabilityResult(current, nowMs, maxStalenessSeconds, true);
    }
    try {
      const refreshed = await this.refresh(system);
      return this.availabilityResult(
        refreshed,
        Date.now(),
        maxStalenessSeconds,
        false,
      );
    } catch (error) {
      const fallback = current ?? this.readSnapshot("last_good");
      if (fallback === null) throw error;
      return this.availabilityResult(
        fallback,
        Date.now(),
        maxStalenessSeconds,
        true,
      );
    }
  }

  async getStation(
    stationId: string,
    includeStatus = true,
  ): Promise<SystemFeedStationResult | null> {
    const current = this.readSnapshot("current");
    if (current === null) return null;
    const station = current.snapshot.stations.find(row => row.station_id === stationId);
    if (!station) return null;
    const status = includeStatus ? current.snapshot.statuses.find(row => row.station_id === stationId) : undefined;
    return { station, ...(status ? { status } : {}),
      fetched_at: new Date(current.fetchedAtMs).toISOString(), stale: Date.now() > current.expiresAtMs };
  }

  async getHealth(catalogSystem?: CatalogSystem): Promise<SystemFeedHealth> {
    const system =
      catalogSystem === undefined
        ? this.readConfiguredSystem()
        : this.configure(catalogSystem);
    const current = this.readSnapshot("current");
    const circuit = this.readCircuit();
    const nowMs = Date.now();
    const statusSourceFreshness =
      current === null
        ? null
        : evaluateStatusSourceFreshness(
            current.snapshot.source_observations?.station_status,
            current.fetchedAtMs,
            Math.max(
              0,
              Math.round((current.expiresAtMs - current.fetchedAtMs) / 1_000),
            ),
            nowMs,
          );
    const observationCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM observations")
      .one().count;
    const rollingWindowSeconds = 86_400;
    const rollingSinceMs = Date.now() - rollingWindowSeconds * 1_000;
    const rolling = this.sql
      .exec<{ successes: number | null; failures: number | null }>(
        `SELECT
          SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS successes,
          SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failures
         FROM refresh_outcomes
         WHERE completed_at_ms >= ?`,
        rollingSinceMs,
      )
      .one();
    const rollingSuccesses = rolling.successes ?? 0;
    const rollingFailures = rolling.failures ?? 0;
    const rollingTotal = rollingSuccesses + rollingFailures;
    const discoveredFeeds = new Set<string>(["tfl", "gira"].includes(system?.feed_format ?? "") ? [] : ["gbfs"]);
    if (current !== null) {
      for (const feedName of Object.keys(current.snapshot.discovery.feeds)) {
        discoveredFeeds.add(feedName);
      }
    }
    for (const row of this.sql
      .exec<{ feed_name: string }>(
        "SELECT DISTINCT feed_name FROM observations",
      )
      .toArray()) {
      discoveredFeeds.add(row.feed_name);
    }
    const feeds: SystemFeedFeedHealth[] = [...discoveredFeeds]
      .sort()
      .flatMap((feedName) => {
        if (!KNOWN_FEEDS.has(feedName as GbfsFetchFeedName)) return [];
        const latest = this.sql
          .exec<{
            validation_status: string;
            provider_last_updated: string | null;
            ttl_seconds: number | null;
            last_error_class: string | null;
          }>(
            `SELECT validation_status, provider_last_updated, ttl_seconds,
              last_error_class
             FROM observations WHERE feed_name = ? ORDER BY id DESC LIMIT 1`,
            feedName,
          )
          .toArray()[0];
        const lastSuccess = this.sql
          .exec<{ fetched_at_ms: number }>(
            `SELECT fetched_at_ms FROM observations
             WHERE feed_name = ? AND validation_status = 'valid'
             ORDER BY id DESC LIMIT 1`,
            feedName,
          )
          .toArray()[0];
        const present =
          feedName === "gbfs" ||
          current?.snapshot.discovery.feeds[
            feedName as Exclude<GbfsFetchFeedName, "gbfs">
          ] !== undefined;
        const validationStatus: SystemFeedFeedHealth["validation_status"] =
          latest?.validation_status === "valid" ||
          latest?.validation_status === "invalid" ||
          latest?.validation_status === "unsupported"
            ? latest.validation_status
            : present
              ? "unknown"
              : "unsupported";
        return [
          {
            feed_name: feedName as GbfsFetchFeedName,
            present,
            last_successful_fetch: asIso(lastSuccess?.fetched_at_ms ?? null),
            provider_last_updated: latest?.provider_last_updated ?? null,
            ttl_seconds: latest?.ttl_seconds ?? null,
            validation_status: validationStatus,
            last_error_class:
              latest?.last_error_class === null ||
              latest?.last_error_class === undefined
                ? "none"
                : (latest.last_error_class as ProviderErrorClass),
          },
        ];
      });
    const ready = system !== null && current !== null;
    const state = !ready
      ? "uninitialized"
      : circuit.state === "open" &&
          circuit.openedUntilMs !== null &&
          circuit.openedUntilMs > nowMs
        ? "unavailable"
        : current.expiresAtMs < nowMs ||
            statusSourceFreshness?.stale === true ||
            circuit.consecutiveFailures > 0
          ? "degraded"
          : "healthy";
    return {
      system_id: system?.system_id ?? null,
      discovery_url: system?.discovery_url ?? null,
      detected_version: current?.snapshot.system.detected_version ?? null,
      ...(current === null
        ? {}
        : { capabilities: current.snapshot.system.capabilities }),
      ready,
      state,
      circuit_state: circuit.state,
      consecutive_failures: circuit.consecutiveFailures,
      open_until: asIso(circuit.openedUntilMs),
      last_success_at: asIso(circuit.lastSuccessAtMs),
      last_error_at: asIso(circuit.lastErrorAtMs),
      last_error_class: circuit.lastErrorClass,
      snapshot_fetched_at: asIso(current?.fetchedAtMs ?? null),
      snapshot_expires_at: asIso(current?.expiresAtMs ?? null),
      ...(statusSourceFreshness === null
        ? {}
        : { status_source_age_seconds: statusSourceFreshness.ageSeconds }),
      observation_count: observationCount,
      feeds,
      rolling_success_rate:
        rollingTotal === 0 ? null : rollingSuccesses / rollingTotal,
      rolling_window_seconds: rollingWindowSeconds,
      successes: circuit.successes,
      failures: circuit.failures,
    };
  }

  private probeDiscoveryMetadata(
    health: SystemFeedHealth,
  ): SystemFeedProbeDiscoveryMetadata | null {
    const current = this.readSnapshot("current");
    if (current === null) return null;
    return {
      detected_version: current.snapshot.system.detected_version,
      capabilities: current.snapshot.system.capabilities,
      last_successful_probe: health.last_success_at,
    };
  }

  async probe(
    catalogSystem?: CatalogSystem,
    options: ProbeOptions = {},
  ): Promise<SystemFeedProbeResult> {
    const system =
      catalogSystem === undefined
        ? this.readConfiguredSystem()
        : this.configure(catalogSystem);
    if (system === null) {
      const health = await this.getHealth();
      return {
        ok: false,
        retryable: false,
        duplicate: false,
        error_class: "unsupported_version",
        health,
        discovery_metadata: this.probeDiscoveryMetadata(health),
      };
    }
    if (options.idempotencyKey !== undefined) {
      const receipt = this.sql
        .exec<{ result_json: string }>(
          "SELECT result_json FROM probe_receipts WHERE idempotency_key = ?",
          options.idempotencyKey,
        )
        .toArray()[0];
      if (receipt !== undefined) {
        const result = JSON.parse(receipt.result_json) as SystemFeedProbeResult;
        return { ...result, duplicate: true };
      }
    }

    let result: SystemFeedProbeResult;
    try {
      await this.refresh(system);
      const health = await this.getHealth();
      result = {
        ok: true,
        retryable: false,
        duplicate: false,
        error_class: null,
        health,
        discovery_metadata: this.probeDiscoveryMetadata(health),
      };
    } catch (error) {
      const failure = classifyProviderError(error);
      const health = await this.getHealth();
      result = {
        ok: false,
        retryable: failure.retryable,
        duplicate: false,
        error_class: failure.errorClass,
        health,
        discovery_metadata: this.probeDiscoveryMetadata(health),
      };
    }
    if (
      options.idempotencyKey !== undefined &&
      (result.ok || !result.retryable)
    ) {
      const nowMs = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT OR IGNORE INTO probe_receipts(
            idempotency_key, completed_at_ms, result_json
          ) VALUES(?, ?, ?)`,
          options.idempotencyKey,
          nowMs,
          stableJson(result),
        );
        this.sql.exec(
          "DELETE FROM probe_receipts WHERE completed_at_ms < ?",
          nowMs - RECEIPT_RETENTION_MS,
        );
        this.sql.exec(
          `DELETE FROM probe_receipts WHERE idempotency_key NOT IN (
            SELECT idempotency_key FROM probe_receipts
            ORDER BY completed_at_ms DESC LIMIT ?
          )`,
          MAX_RECEIPTS,
        );
      });
    }
    return result;
  }

  private readMaterializedCycle(): StatusCycle {
    const cycle = this.sql
      .exec<{
        cycle_id: string;
        catalog_version: string;
        catalog_published_at: string;
        started_at: string;
        systems_scheduled: number;
      }>("SELECT * FROM materialized_status_cycle WHERE singleton = 1")
      .one();
    const counts = new Map(
      this.sql
        .exec<{ outcome: string; count: number }>(
          `SELECT outcome, COUNT(*) AS count FROM materialized_probe_results
           WHERE cycle_id = ? AND terminal = 1 GROUP BY outcome`,
          cycle.cycle_id,
        )
        .toArray()
        .map((row) => [row.outcome, row.count] as const),
    );
    const healthy = counts.get("healthy") ?? 0;
    const degraded = counts.get("degraded") ?? 0;
    const unavailable = counts.get("unavailable") ?? 0;
    const completed = healthy + degraded + unavailable;
    const lastActivity = this.sql
      .exec<{ checked_at: string | null }>(
        `SELECT MAX(checked_at) AS checked_at FROM materialized_probe_results
         WHERE cycle_id = ?`,
        cycle.cycle_id,
      )
      .one().checked_at;
    return StatusCycleSchema.parse({
      schema_version: 1,
      cycle_id: cycle.cycle_id,
      catalog_version: cycle.catalog_version,
      catalog_published_at: cycle.catalog_published_at,
      started_at: cycle.started_at,
      systems_scheduled: cycle.systems_scheduled,
      systems_completed: completed,
      systems_healthy: healthy,
      systems_degraded: degraded,
      systems_unavailable: unavailable,
      last_probe_activity_at: lastActivity,
      state: completed >= cycle.systems_scheduled ? "complete" : "probing",
    });
  }

  private async publishMaterializedCycle(): Promise<StatusCycle> {
    const cycle = this.readMaterializedCycle();
    const cycleJson = stableJson(cycle);
    const previous = this.sql
      .exec<{ published_at_ms: number; cycle_json: string }>(
        `SELECT published_at_ms, cycle_json FROM status_pointer_publication
         WHERE singleton = 1`,
      )
      .toArray()[0];
    if (previous?.cycle_json === cycleJson) return cycle;

    if (previous !== undefined) {
      const delayMs = Math.max(
        0,
        previous.published_at_ms + STATUS_POINTER_MIN_WRITE_INTERVAL_MS -
          Date.now(),
      );
      if (delayMs > 0) await scheduler.wait(delayMs);
    }
    await beginProbeCycle(this.env, cycle);
    this.sql.exec(
      `INSERT INTO status_pointer_publication(
        singleton, published_at_ms, cycle_json
      ) VALUES(1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        published_at_ms = excluded.published_at_ms,
        cycle_json = excluded.cycle_json`,
      Date.now(),
      cycleJson,
    );
    return cycle;
  }

  private stageMaterializedCycle(cycle: StatusCycle): boolean {
    const current = this.sql
      .exec<{
        cycle_id: string;
        catalog_version: string;
        catalog_published_at: string;
        started_at: string;
        systems_scheduled: number;
      }>(
        `SELECT cycle_id, catalog_version, catalog_published_at, started_at,
                systems_scheduled
         FROM materialized_status_cycle WHERE singleton = 1`,
      )
      .toArray()[0];
    if (current?.cycle_id === cycle.cycle_id) {
      if (
        current.catalog_version !== cycle.catalog_version ||
        current.catalog_published_at !== cycle.catalog_published_at ||
        current.started_at !== cycle.started_at ||
        current.systems_scheduled !== cycle.systems_scheduled
      ) {
        throw new Error("A status cycle cannot change immutable metadata");
      }
      return true;
    }
    if (
      current !== undefined &&
      Date.parse(current.started_at) >= Date.parse(cycle.started_at)
    ) {
      return false;
    }
    this.sql.exec("DELETE FROM materialized_probe_results");
    this.sql.exec("DELETE FROM materialized_status_cycle");
    this.sql.exec(
      `INSERT INTO materialized_status_cycle(
        singleton, cycle_id, catalog_version, catalog_published_at,
        started_at, systems_scheduled
      ) VALUES(1, ?, ?, ?, ?, ?)`,
      cycle.cycle_id,
      cycle.catalog_version,
      cycle.catalog_published_at,
      cycle.started_at,
      cycle.systems_scheduled,
    );
    return true;
  }

  private async queueMaterializedCyclePublication(
    fallback: StatusCycle,
  ): Promise<StatusCycle> {
    const prior = this.statusMaterializePromise ?? Promise.resolve(fallback);
    const pending = prior
      .catch(() => fallback)
      .then(() => this.publishMaterializedCycle());
    this.statusMaterializePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.statusMaterializePromise === pending) {
        this.statusMaterializePromise = null;
      }
    }
  }

  async initializeProbeCycle(rawCycle: StatusCycle): Promise<StatusCycle> {
    const cycle = StatusCycleSchema.parse(rawCycle);
    let accepted = false;
    this.ctx.storage.transactionSync(() => {
      accepted = this.stageMaterializedCycle(cycle);
    });
    if (!accepted) return this.readMaterializedCycle();
    return this.queueMaterializedCyclePublication(cycle);
  }

  async materializeProbeStatus(
    rawCycle: StatusCycle,
    rawStatus: SystemProbeStatus,
  ): Promise<StatusCycle> {
    const cycle = StatusCycleSchema.parse(rawCycle);
    const status = SystemProbeStatusSchema.parse(rawStatus);
    if (
      cycle.cycle_id !== status.cycle_id ||
      cycle.catalog_version !== status.catalog_version
    ) {
      throw new Error("Probe status does not belong to the status cycle");
    }
    let accepted = false;
    this.ctx.storage.transactionSync(() => {
      accepted = this.stageMaterializedCycle(cycle);
      if (!accepted) return;
      this.sql.exec(
        `INSERT INTO materialized_probe_results(
          cycle_id, system_id, checked_at, outcome, terminal
        ) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id, system_id) DO UPDATE SET
          checked_at = excluded.checked_at,
          outcome = excluded.outcome,
          terminal = excluded.terminal
        WHERE excluded.checked_at >= materialized_probe_results.checked_at`,
        status.cycle_id,
        status.system_id,
        status.checked_at,
        status.outcome,
        status.retryable ? 0 : 1,
      );
    });

    if (!accepted) return this.readMaterializedCycle();
    const materialized = this.readMaterializedCycle();
    if (materialized.state !== "complete") return materialized;
    return this.queueMaterializedCyclePublication(materialized);
  }

  /**
   * Closes a probe cycle after the Workflow's bounded delivery window. Any
   * system that has no terminal result (including a last retryable result) is
   * marked unavailable. Existing terminal results are never overwritten, so
   * Workflow retries and at-least-once delivery are safe.
   */
  async reconcileProbeCycle(
    rawCycle: StatusCycle,
    rawSystemIds: string[],
    rawCheckedAt: string,
  ): Promise<StatusCycle> {
    const cycle = StatusCycleSchema.parse(rawCycle);
    const systemIds = [...new Set(rawSystemIds)];
    if (
      systemIds.length !== rawSystemIds.length ||
      systemIds.length !== cycle.systems_scheduled ||
      systemIds.some(
        (systemId) =>
          typeof systemId !== "string" ||
          systemId.length < 1 ||
          systemId.length > 128,
      )
    ) {
      throw new Error("Probe reconciliation systems do not match the cycle");
    }
    const checkedAtMs = Date.parse(rawCheckedAt);
    if (!Number.isFinite(checkedAtMs)) {
      throw new Error("Probe reconciliation timestamp is invalid");
    }
    const checkedAt = new Date(checkedAtMs).toISOString();

    let accepted = false;
    this.ctx.storage.transactionSync(() => {
      accepted = this.stageMaterializedCycle(cycle);
      if (!accepted) return;
      for (const systemId of systemIds) {
        this.sql.exec(
          `INSERT INTO materialized_probe_results(
            cycle_id, system_id, checked_at, outcome, terminal
          ) VALUES(?, ?, ?, 'unavailable', 1)
          ON CONFLICT(cycle_id, system_id) DO UPDATE SET
            checked_at = excluded.checked_at,
            outcome = excluded.outcome,
            terminal = excluded.terminal
          WHERE materialized_probe_results.terminal = 0
            AND excluded.checked_at >= materialized_probe_results.checked_at`,
          cycle.cycle_id,
          systemId,
          checkedAt,
        );
      }
    });

    if (!accepted) return this.readMaterializedCycle();
    const materialized = this.readMaterializedCycle();
    if (materialized.state !== "complete") {
      throw new Error("Probe reconciliation did not complete the cycle");
    }
    return this.queueMaterializedCyclePublication(materialized);
  }
}
