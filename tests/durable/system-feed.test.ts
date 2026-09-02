import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { CatalogSystem } from "../../src/catalog";
import {
  citiLikeDiscoveryV23,
  citiLikeStationInformationV23,
  citiLikeStationStatusV23,
  citiLikeSystemInformationV23,
  citiLikeVehicleTypesV23,
} from "../../fixtures";

import {
  SystemFeed,
  MAX_NORMALIZED_SNAPSHOT_BYTES,
  MAX_REQUEST_SNAPSHOT_FANOUT_BYTES,
  assertNormalizedSnapshotWithinBudget,
  circuitAfterFailure,
  circuitAfterSuccess,
  circuitBackoffSeconds,
  classifyProviderError,
  evaluateStatusSourceFreshness,
} from "../../src/durable";
import type { CircuitRecord } from "../../src/durable";
import { readPublicStatus } from "../../src/status";

const initial: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  openedUntilMs: null,
  lastErrorClass: null,
  lastErrorAtMs: null,
  lastSuccessAtMs: null,
  successes: 0,
  failures: 0,
};

describe("SystemFeed SQLite state", () => {
  it("keeps four concurrent normalized snapshots inside the beta memory budget", () => {
    expect(MAX_NORMALIZED_SNAPSHOT_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_REQUEST_SNAPSHOT_FANOUT_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_REQUEST_SNAPSHOT_FANOUT_BYTES).toBeLessThan(80 * 1024 * 1024);
    expect(() =>
      assertNormalizedSnapshotWithinBudget({
        payload: "x".repeat(MAX_NORMALIZED_SNAPSHOT_BYTES),
      }),
    ).toThrow(/exceeded storage limits/);
  });

  it("ages status from the provider timestamp and falls back only when it is missing", () => {
    const nowMs = Date.parse("2026-09-02T12:02:00.000Z");
    expect(
      evaluateStatusSourceFreshness(
        {
          provider_last_updated: "2026-09-02T12:00:00.000Z",
          fetched_at: "2026-09-02T12:01:59.000Z",
          ttl_seconds: 60,
        },
        Date.parse("2026-09-02T12:01:59.000Z"),
        30,
        nowMs,
      ),
    ).toEqual({ ageSeconds: 120, stale: true });
    expect(
      evaluateStatusSourceFreshness(
        {
          provider_last_updated: null,
          fetched_at: "2026-09-02T12:01:59.000Z",
          ttl_seconds: 60,
        },
        Date.parse("2026-09-02T12:01:58.000Z"),
        30,
        nowMs,
      ),
    ).toEqual({ ageSeconds: 1, stale: false });
  });

  it("applies explicit schema migrations and initializes health state", async () => {
    const stub = env.SYSTEM_FEEDS.getByName(
      `migration-${crypto.randomUUID()}`,
    ) as unknown as DurableObjectStub<SystemFeed>;
    const result = await runInDurableObject(stub, async (instance, state) => ({
      migrations: state.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
        .toArray(),
      vehicleTypeTable: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vehicle_type_rows'",
        )
        .toArray(),
      statusPublicationTable: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'status_pointer_publication'",
        )
        .toArray(),
      refreshOutcomesTable: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_outcomes'",
        )
        .toArray(),
      health: await instance.getHealth(),
    }));
    expect(result.migrations).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(result.vehicleTypeTable).toEqual([{ name: "vehicle_type_rows" }]);
    expect(result.statusPublicationTable).toEqual([
      { name: "status_pointer_publication" },
    ]);
    expect(result.refreshOutcomesTable).toEqual([{ name: "refresh_outcomes" }]);
    expect(result.health).toMatchObject({
      ready: false,
      state: "uninitialized",
      circuit_state: "closed",
      observation_count: 0,
    });
  });

  it("upgrades a v1 object that predates row-wise vehicle type storage", async () => {
    const stub = env.SYSTEM_FEEDS.getByName(
      `migration-upgrade-${crypto.randomUUID()}`,
    ) as unknown as DurableObjectStub<SystemFeed>;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE vehicle_type_rows");
      state.storage.sql.exec("DELETE FROM schema_migrations WHERE version = 2");
      state.storage.sql.exec("DROP TABLE refresh_outcomes");
      state.storage.sql.exec("DELETE FROM schema_migrations WHERE version = 4");
    });
    await evictDurableObject(stub);

    const upgraded = await runInDurableObject(stub, async (instance, state) => ({
      health: await instance.getHealth(),
      migrations: state.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
        .toArray(),
      vehicleTypeTable: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vehicle_type_rows'",
        )
        .toArray(),
      refreshOutcomesTable: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_outcomes'",
        )
        .toArray(),
    }));

    expect(upgraded.health).toMatchObject({ ready: false, state: "uninitialized" });
    expect(upgraded.migrations).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(upgraded.vehicleTypeTable).toEqual([{ name: "vehicle_type_rows" }]);
    expect(upgraded.refreshOutcomesTable).toEqual([{ name: "refresh_outcomes" }]);
  });

  it("persists snapshots across eviction and coalesces concurrent refreshes", async () => {
    const source: CatalogSystem = {
      system_id: "synthetic_nyc",
      source_system_id: "synthetic_nyc",
      name: "Synthetic City Bike",
      operator: "Example Mobility",
      city: "New York City",
      region: "New York",
      country_code: "US",
      timezone: "America/New_York",
      discovery_url:
        "https://gbfs.example.test/gbfs/2.3/nyc/en/gbfs.json",
      detected_version: "2.3",
      languages: ["en"],
      license: {
        id: null,
        name: "Synthetic policy",
        url: "https://example.test/data-policy",
        status: "declared",
      },
      capabilities: {
        docked: true,
        dockless: false,
        ebike: true,
        station_status: true,
      },
      coverage: {
        bounds: { south: 40.6, west: -74.1, north: 40.9, east: -73.8 },
        centroid: { latitude: 40.72, longitude: -74 },
        confidence: "catalog_metadata",
        buffer_meters: 5_000,
      },
      location_hint: "enam",
      reviewed_hosts: ["gbfs.example.test"],
      request_headers: {},
      preferred_languages: ["en"],
      enabled: true,
    };
    const documents = new Map<string, unknown>([
      ["gbfs.json", citiLikeDiscoveryV23],
      ["system_information.json", citiLikeSystemInformationV23],
      ["station_information.json", citiLikeStationInformationV23],
      [
        "station_status.json",
        { ...citiLikeStationStatusV23, last_updated: 1_788_263_160 },
      ],
      ["vehicle_types.json", citiLikeVehicleTypesV23],
    ]);
    const successfulFetch = async (input: RequestInfo | URL) => {
      const filename = new URL(input.toString()).pathname.split("/").at(-1);
      const document = filename === undefined ? undefined : documents.get(filename);
      if (document === undefined) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"synthetic-v1"',
        },
      });
    };
    const fetchMock = vi.fn(successfulFetch);
    vi.stubGlobal("fetch", fetchMock);
    const stub = env.SYSTEM_FEEDS.getByName(
      `snapshot-${crypto.randomUUID()}`,
    ) as unknown as DurableObjectStub<SystemFeed>;
    const first = await runInDurableObject(stub, (instance) =>
      instance.getAvailability({
        catalogSystem: source,
        forceRefresh: true,
        maxStalenessSeconds: 300,
      }),
    );
    expect(first.stations).toHaveLength(2);
    expect(first.discovery.providerLastUpdated).toBe(
      "2026-09-01T11:45:00.000Z",
    );
    expect(first.source_observations?.station_status).toMatchObject({
      provider_last_updated: "2026-09-01T11:46:00.000Z",
      ttl_seconds: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const probe = await runInDurableObject(stub, (instance) =>
      instance.probe(source, { idempotencyKey: "metadata-probe-v1" }),
    );
    expect(probe.discovery_metadata).toMatchObject({
      detected_version: "2.3",
      capabilities: {
        docked: true,
        dockless: true,
        ebike: true,
        station_status: true,
      },
    });
    expect(probe.discovery_metadata?.last_successful_probe).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    fetchMock.mockClear();
    const concurrent = await runInDurableObject(stub, (instance) =>
      Promise.all([
        instance.getAvailability({
          catalogSystem: source,
          forceRefresh: true,
          maxStalenessSeconds: 300,
        }),
        instance.getAvailability({
          catalogSystem: source,
          forceRefresh: true,
          maxStalenessSeconds: 300,
        }),
      ]),
    );
    expect("contentHash" in concurrent[0]).toBe(false);
    expect(concurrent[0].stations).toEqual(concurrent[1].stations);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await evictDurableObject(stub);
    const recovered = await runInDurableObject(stub, (instance) =>
      instance.getHealth(source),
    );
    expect(recovered).toMatchObject({
      ready: true,
      state: "degraded",
      system_id: "synthetic_nyc",
      capabilities: {
        docked: true,
        dockless: true,
        ebike: true,
        station_status: true,
      },
      successes: 3,
      failures: 0,
    });
    expect(recovered.status_source_age_seconds).toBeGreaterThan(5);
    expect(recovered.feeds.find((feed) => feed.feed_name === "station_status"))
      .toMatchObject({ present: true, validation_status: "valid" });
    const recoveredSnapshot = await runInDurableObject(stub, (instance) =>
      instance.getAvailability({
        catalogSystem: source,
        maxStalenessSeconds: 300,
      }),
    );
    expect(recoveredSnapshot.source_observations?.station_status).toMatchObject({
      provider_last_updated: "2026-09-01T11:46:00.000Z",
      ttl_seconds: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    fetchMock.mockImplementation(async (input) => {
      if (new URL(input.toString()).pathname.endsWith("/station_status.json")) {
        return new Response(null, { status: 503 });
      }
      return successfulFetch(input);
    });
    const subfeedFallback = await runInDurableObject(stub, (instance) =>
      instance.getAvailability({
        catalogSystem: source,
        forceRefresh: true,
        maxStalenessSeconds: 300,
      }),
    );
    expect(subfeedFallback.stations).toHaveLength(2);
    const subfeedDegraded = await runInDurableObject(stub, (instance) =>
      instance.getHealth(),
    );
    expect(
      subfeedDegraded.feeds.find(
        (feed) => feed.feed_name === "station_status",
      ),
    ).toMatchObject({
      present: true,
      validation_status: "invalid",
      last_error_class: "http_5xx",
    });
    expect(
      subfeedDegraded.feeds.find((feed) => feed.feed_name === "gbfs"),
    ).toMatchObject({
      present: true,
      validation_status: "valid",
      last_error_class: "none",
    });
    expect(subfeedDegraded.rolling_success_rate).toBe(0.75);

    fetchMock.mockRejectedValue(new Error("synthetic network failure"));
    const fallback = await runInDurableObject(stub, (instance) =>
      instance.getAvailability({
        catalogSystem: source,
        forceRefresh: true,
        maxStalenessSeconds: 300,
      }),
    );
    expect(fallback.stations).toHaveLength(2);
    expect(fallback.warnings).toContainEqual(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }),
    );
    const degraded = await runInDurableObject(stub, (instance) =>
      instance.getHealth(),
    );
    expect(degraded).toMatchObject({
      ready: true,
      state: "degraded",
      successes: 3,
      failures: 2,
      last_error_class: "dns",
      rolling_success_rate: 0.6,
    });
    vi.unstubAllGlobals();
  });

  it("publishes terminal status after an immediate burst and deduplicates delivery", async () => {
    const suffix = crypto.randomUUID();
    const cycle = {
      schema_version: 1 as const,
      cycle_id: `cycle-${suffix}`,
      catalog_version: `catalog-${suffix}`,
      catalog_published_at: "2026-09-02T04:00:00.000Z",
      started_at: "2026-09-02T04:00:00.000Z",
      systems_scheduled: 2,
      systems_completed: 0,
      systems_healthy: 0,
      systems_degraded: 0,
      systems_unavailable: 0,
      last_probe_activity_at: null,
      state: "probing" as const,
    };
    const stub = env.SYSTEM_FEEDS.getByName(
      `status-${suffix}`,
    ) as unknown as DurableObjectStub<SystemFeed>;
    await runInDurableObject(stub, (instance) =>
      instance.initializeProbeCycle(cycle),
    );
    const baseStatus = {
      schema_version: 1 as const,
      cycle_id: cycle.cycle_id,
      catalog_version: cycle.catalog_version,
      cache_status: "fresh" as const,
      circuit_state: "closed" as const,
      age_seconds: 0,
      error_class: null,
    };
    const pending = await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(cycle, {
        ...baseStatus,
        system_id: "one",
        checked_at: "2026-09-02T04:00:01.000Z",
        outcome: "unavailable",
        retryable: true,
      }),
    );
    expect(pending).toMatchObject({ systems_completed: 0, state: "probing" });
    expect((await readPublicStatus(env)).cycle).toMatchObject({
      cycle_id: cycle.cycle_id,
      systems_completed: 0,
      state: "probing",
    });

    const firstTerminal = await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(cycle, {
        ...baseStatus,
        system_id: "one",
        checked_at: "2026-09-02T04:00:02.000Z",
        outcome: "healthy",
        retryable: false,
      }),
    );
    expect(firstTerminal).toMatchObject({
      systems_completed: 1,
      state: "probing",
    });
    expect((await readPublicStatus(env)).cycle).toMatchObject({
      cycle_id: cycle.cycle_id,
      systems_completed: 0,
      state: "probing",
    });
    const complete = await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(cycle, {
        ...baseStatus,
        system_id: "two",
        checked_at: "2026-09-02T04:00:03.000Z",
        outcome: "degraded",
        retryable: false,
      }),
    );
    expect(complete).toMatchObject({
      systems_completed: 2,
      systems_healthy: 1,
      systems_degraded: 1,
      systems_unavailable: 0,
      state: "complete",
      last_probe_activity_at: "2026-09-02T04:00:03.000Z",
    });
    // Initialization and terminal completion happen back-to-back, inside KV's
    // one-second same-key window. The terminal call must wait for its guarded
    // publication and cannot depend on a later probe to make it public.
    expect((await readPublicStatus(env)).cycle).toMatchObject(complete);

    // At-least-once queue delivery may repeat a terminal status. A burst must
    // still create only the initial and final immutable public summaries.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        runInDurableObject(stub, (instance) =>
          instance.materializeProbeStatus(cycle, {
            ...baseStatus,
            system_id: "two",
            checked_at: "2026-09-02T04:00:03.000Z",
            outcome: "degraded",
            retryable: false,
          }),
        ),
      ),
    );
    const summaries = await env.CATALOG_R2.list({
      prefix: `status/v1/${cycle.cycle_id}/summary-`,
    });
    expect(summaries.objects).toHaveLength(2);
  });

  it("idempotently reconciles missing and retryable probes into a terminal cycle", async () => {
    const suffix = crypto.randomUUID();
    const cycle = {
      schema_version: 1 as const,
      cycle_id: `reconcile-${suffix}`,
      catalog_version: `catalog-${suffix}`,
      catalog_published_at: "2026-09-02T04:00:00.000Z",
      started_at: "2026-09-02T04:00:00.000Z",
      systems_scheduled: 3,
      systems_completed: 0,
      systems_healthy: 0,
      systems_degraded: 0,
      systems_unavailable: 0,
      last_probe_activity_at: null,
      state: "probing" as const,
    };
    const stub = env.SYSTEM_FEEDS.getByName(
      `status-reconcile-${suffix}`,
    ) as unknown as DurableObjectStub<SystemFeed>;
    await runInDurableObject(stub, (instance) =>
      instance.initializeProbeCycle(cycle),
    );
    const statusBase = {
      schema_version: 1 as const,
      cycle_id: cycle.cycle_id,
      catalog_version: cycle.catalog_version,
      cache_status: "fresh" as const,
      circuit_state: "closed" as const,
      age_seconds: 0,
      error_class: null,
    };
    await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(cycle, {
        ...statusBase,
        system_id: "healthy",
        checked_at: "2026-09-02T04:00:01.000Z",
        outcome: "healthy",
        retryable: false,
      }),
    );
    await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(cycle, {
        ...statusBase,
        system_id: "retryable",
        checked_at: "2026-09-02T04:00:02.000Z",
        outcome: "degraded",
        retryable: true,
      }),
    );

    const complete = await runInDurableObject(stub, (instance) =>
      instance.reconcileProbeCycle(
        cycle,
        ["healthy", "retryable", "missing"],
        "2026-09-02T04:30:00.000Z",
      ),
    );
    expect(complete).toMatchObject({
      systems_completed: 3,
      systems_healthy: 1,
      systems_degraded: 0,
      systems_unavailable: 2,
      state: "complete",
      last_probe_activity_at: "2026-09-02T04:30:00.000Z",
    });
    expect((await readPublicStatus(env)).cycle).toMatchObject(complete);

    const duplicate = await runInDurableObject(stub, (instance) =>
      instance.reconcileProbeCycle(
        cycle,
        ["healthy", "retryable", "missing"],
        "2026-09-02T04:31:00.000Z",
      ),
    );
    expect(duplicate).toEqual(complete);
    const summaries = await env.CATALOG_R2.list({
      prefix: `status/v1/${cycle.cycle_id}/summary-`,
    });
    expect(summaries.objects).toHaveLength(2);
  });

  it("never lets a delayed older cycle replace a newer status snapshot", async () => {
    const suffix = crypto.randomUUID();
    const cycle = (label: string, startedAt: string) => ({
      schema_version: 1 as const,
      cycle_id: `${label}-${suffix}`,
      catalog_version: `${label}-catalog-${suffix}`,
      catalog_published_at: startedAt,
      started_at: startedAt,
      systems_scheduled: 1,
      systems_completed: 0,
      systems_healthy: 0,
      systems_degraded: 0,
      systems_unavailable: 0,
      last_probe_activity_at: null,
      state: "probing" as const,
    });
    const older = cycle("older", "2026-09-02T04:00:00.000Z");
    const newer = cycle("newer", "2026-09-03T04:00:00.000Z");
    const statusFor = (target: typeof older, checkedAt: string) => ({
      schema_version: 1 as const,
      cycle_id: target.cycle_id,
      catalog_version: target.catalog_version,
      system_id: "one",
      checked_at: checkedAt,
      outcome: "healthy" as const,
      cache_status: "fresh" as const,
      circuit_state: "closed" as const,
      age_seconds: 0,
      retryable: false,
      error_class: null,
    });
    const stub = env.SYSTEM_FEEDS.getByName(
      `status-order-${suffix}`,
    ) as unknown as DurableObjectStub<SystemFeed>;
    await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(
        older,
        statusFor(older, "2026-09-02T04:00:01.000Z"),
      ),
    );
    const initialized = await runInDurableObject(stub, (instance) =>
      instance.initializeProbeCycle(newer),
    );
    expect(initialized).toMatchObject({
      cycle_id: newer.cycle_id,
      catalog_version: newer.catalog_version,
      systems_completed: 0,
      state: "probing",
    });
    const ignored = await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(
        older,
        statusFor(older, "2026-09-04T04:00:00.000Z"),
      ),
    );

    expect(ignored).toMatchObject({
      cycle_id: newer.cycle_id,
      catalog_version: newer.catalog_version,
      systems_completed: 0,
      systems_healthy: 0,
      state: "probing",
    });
    expect((await readPublicStatus(env)).cycle).toMatchObject({
      cycle_id: newer.cycle_id,
      catalog_version: newer.catalog_version,
    });

    await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(
        newer,
        statusFor(newer, "2026-09-03T04:00:01.000Z"),
      ),
    );
    const ignoredAfterCompletion = await runInDurableObject(stub, (instance) =>
      instance.materializeProbeStatus(
        older,
        statusFor(older, "2026-09-05T04:00:00.000Z"),
      ),
    );
    expect(ignoredAfterCompletion).toMatchObject({
      cycle_id: newer.cycle_id,
      systems_completed: 1,
      systems_healthy: 1,
      state: "complete",
    });
  });
});

describe("provider circuit transitions", () => {
  it("opens on the third retryable failure with bounded exponential delay", () => {
    const one = circuitAfterFailure(
      initial,
      { errorClass: "total_timeout", retryable: true },
      1_000,
    );
    const two = circuitAfterFailure(
      one,
      { errorClass: "total_timeout", retryable: true },
      2_000,
    );
    const three = circuitAfterFailure(
      two,
      { errorClass: "total_timeout", retryable: true },
      3_000,
    );
    expect(three).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      openedUntilMs: 33_000,
    });
    expect(circuitBackoffSeconds(20)).toBe(900);
  });

  it("closes and resets after a successful half-open probe", () => {
    const recovered = circuitAfterSuccess(
      { ...initial, state: "half_open", consecutiveFailures: 4, failures: 4 },
      10_000,
    );
    expect(recovered).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      lastSuccessAtMs: 10_000,
      successes: 1,
      failures: 4,
    });
  });

  it("maps detailed failures to a small safe taxonomy", () => {
    expect(
      classifyProviderError({
        code: "UPSTREAM_HTTP_ERROR",
        httpStatus: 503,
        retryable: true,
      }),
    ).toEqual({ errorClass: "http_5xx", retryable: true });
    expect(
      classifyProviderError({ code: "RESPONSE_TOO_LARGE", retryable: false }),
    ).toEqual({ errorClass: "response_too_large", retryable: false });
  });
});
