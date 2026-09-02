import { describe, expect, it } from "vitest";

import {
  applyCatalogOverrides,
  BUNDLED_CATALOG,
  CATALOG_POINTER_KEY,
  loadCatalog,
  loadCatalogPointer,
  publishCatalog,
  rollbackCatalog,
} from "../../src/catalog";
import type { CatalogBindings, CatalogSnapshot } from "../../src/catalog";
import {
  beginProbeCycle,
  readProbeDiscoveryMetadata,
  recordProbeStatus,
} from "../../src/status";

const memoryBindings = (): {
  env: CatalogBindings;
  kv: Map<string, string>;
  r2: Map<string, string>;
} => {
  const kv = new Map<string, string>();
  const r2 = new Map<string, string>();
  const env = {
    CATALOG_KV: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key) ?? null;
        return type === "json" && value !== null ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
    CATALOG_R2: {
      head: async (key: string) => (r2.has(key) ? {} : null),
      get: async (key: string) => {
        const value = r2.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      put: async (key: string, value: string | ReadableStream | ArrayBuffer) => {
        if (typeof value !== "string") throw new Error("Unexpected test value");
        r2.set(key, value);
        return {};
      },
    },
  } as unknown as CatalogBindings;
  return { env, kv, r2 };
};

const versioned = (version: string, generatedAt: string): CatalogSnapshot => ({
  ...BUNDLED_CATALOG,
  version,
  generated_at: generatedAt,
});

describe("catalog publication", () => {
  it("falls back to the bundled catalog before first publication", async () => {
    const { env } = memoryBindings();
    expect((await loadCatalog(env)).version).toBe(BUNDLED_CATALOG.version);
  });

  it("publishes immutable R2 data before changing the pointer", async () => {
    const { env, kv, r2 } = memoryBindings();
    const result = await publishCatalog(
      env,
      versioned("v1", "2026-09-02T01:00:00.000Z"),
      new Date("2026-09-02T01:00:01.000Z"),
    );
    expect(r2.get(result.pointer.r2_key)).toBeDefined();
    expect(result.pointer.enabled_system_count).toBe(
      result.catalog.systems.filter((system) => system.enabled).length,
    );
    expect(kv.get(CATALOG_POINTER_KEY)).toContain('"version":"v1"');
    expect((await loadCatalog(env)).version).toBe("v1");
  });

  it("preserves version history for a validated rollback", async () => {
    const { env } = memoryBindings();
    await publishCatalog(
      env,
      versioned("v1", "2026-09-02T01:00:00.000Z"),
    );
    await publishCatalog(
      env,
      versioned("v2", "2026-09-03T01:00:00.000Z"),
    );
    const pointer = await rollbackCatalog(
      env,
      "v1",
      new Date("2026-09-04T01:00:00.000Z"),
    );
    expect(pointer.version).toBe("v1");
    expect(pointer.previous_version).toBe("v2");
    expect((await loadCatalogPointer(env))?.version).toBe("v1");
  });

  it("never rebinds a published version to different content", async () => {
    const { env } = memoryBindings();
    await publishCatalog(
      env,
      versioned("v1", "2026-09-02T01:00:00.000Z"),
    );
    await expect(
      publishCatalog(
        env,
        versioned("v1", "2026-09-03T01:00:00.000Z"),
      ),
    ).rejects.toThrow(/immutable content/);
  });

  it("requires an explicit host review before enabling an inert candidate", () => {
    const candidate = {
      ...BUNDLED_CATALOG.systems[0]!,
      system_id: "candidate-system",
      source_system_id: "candidate-system",
      discovery_url: "https://feeds.example.com/gbfs.json",
      reviewed_hosts: ["feeds.example.com"],
      detected_version: null,
      capabilities: {
        docked: false,
        dockless: false,
        ebike: false,
        station_status: false,
      },
      coverage: {
        bounds: null,
        centroid: null,
        confidence: "unknown" as const,
        buffer_meters: 0,
      },
      enabled: false,
    };
    const catalog = { ...BUNDLED_CATALOG, systems: [candidate] };
    expect(() =>
      applyCatalogOverrides(catalog, {
        "candidate-system": { enabled: true },
      }),
    ).toThrow(/explicit reviewed-host override/);
    expect(
      applyCatalogOverrides(catalog, {
        "candidate-system": {
          enabled: true,
          reviewed_hosts: ["feeds.example.com"],
        },
      }).systems[0]?.enabled,
    ).toBe(true);
  });
});

describe("probe-derived discovery metadata", () => {
  it("loads only validated metadata from the current catalog status cycle", async () => {
    const { env, r2 } = memoryBindings();
    const cycle = {
      schema_version: 1 as const,
      cycle_id: "cycle-v2",
      catalog_version: "catalog-v2",
      catalog_published_at: "2026-09-02T10:00:00.000Z",
      started_at: "2026-09-02T10:00:01.000Z",
      systems_scheduled: 1,
      systems_completed: 0,
      systems_healthy: 0,
      systems_degraded: 0,
      systems_unavailable: 0,
      last_probe_activity_at: null,
      state: "probing" as const,
    };
    await beginProbeCycle(env, cycle);
    await recordProbeStatus(env, {
      schema_version: 1,
      cycle_id: cycle.cycle_id,
      catalog_version: cycle.catalog_version,
      system_id: "lyft_nyc",
      checked_at: "2026-09-02T10:00:02.000Z",
      outcome: "healthy",
      cache_status: "fresh",
      circuit_state: "closed",
      age_seconds: 0,
      retryable: false,
      error_class: null,
      detected_version: "3.0",
      capabilities: {
        docked: false,
        dockless: true,
        ebike: false,
        station_status: true,
      },
      last_successful_probe: "2026-09-02T10:00:01.500Z",
    });

    const current = await readProbeDiscoveryMetadata(
      env,
      cycle.catalog_version,
      ["lyft_nyc", "missing"],
    );
    expect(current.get("lyft_nyc")).toMatchObject({
      cycle_id: cycle.cycle_id,
      catalog_version: cycle.catalog_version,
      detected_version: "3.0",
      capabilities: { docked: false, dockless: true, ebike: false },
      last_successful_probe: "2026-09-02T10:00:01.500Z",
    });
    expect(current.has("missing")).toBe(false);
    expect(
      await readProbeDiscoveryMetadata(env, "another-catalog", ["lyft_nyc"]),
    ).toEqual(new Map());

    const reference = JSON.parse(
      (await env.CATALOG_KV.get(
        `status:cycle:${cycle.cycle_id}:system:lyft_nyc`,
      )) as string,
    ) as { key: string };
    r2.set(reference.key, '{"tampered":true}');
    expect(
      await readProbeDiscoveryMetadata(env, cycle.catalog_version, ["lyft_nyc"]),
    ).toEqual(new Map());
  });

  it("keeps status records written by older Worker versions readable", async () => {
    const { env } = memoryBindings();
    const cycle = {
      schema_version: 1 as const,
      cycle_id: "cycle-v1",
      catalog_version: "catalog-v1",
      catalog_published_at: "2026-09-01T10:00:00.000Z",
      started_at: "2026-09-01T10:00:01.000Z",
      systems_scheduled: 1,
      systems_completed: 0,
      systems_healthy: 0,
      systems_degraded: 0,
      systems_unavailable: 0,
      last_probe_activity_at: null,
      state: "probing" as const,
    };
    await beginProbeCycle(env, cycle);
    await recordProbeStatus(env, {
      schema_version: 1,
      cycle_id: cycle.cycle_id,
      catalog_version: cycle.catalog_version,
      system_id: "legacy",
      checked_at: "2026-09-01T10:00:02.000Z",
      outcome: "healthy",
      cache_status: "fresh",
      circuit_state: "closed",
      age_seconds: 0,
      retryable: false,
      error_class: null,
    });

    expect(
      await readProbeDiscoveryMetadata(env, cycle.catalog_version, ["legacy"]),
    ).toEqual(new Map());
  });
});
