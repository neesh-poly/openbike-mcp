import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
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
  MAX_NORMALIZED_SNAPSHOT_BYTES,
  SystemFeed,
  normalizedSnapshotByteLength,
} from "../../src/durable";

const CONCURRENCY_LEVELS = [1, 10, 100] as const;
// This produces a normalized snapshot close to, but below, the 4 MiB guard so
// the benchmark exercises the production storage bound instead of a toy body.
const FIXTURE_STATION_COUNT = 6_000;
const EXPECTED_UPSTREAM_REQUESTS_PER_REFRESH = 5;
const MAX_UPSTREAM_OPERATIONS = 4;
const LOCAL_COLD_P95_GATE_MS = 5_000;

interface LatencySummary {
  samples: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

interface ScenarioReport {
  requested_concurrency: number;
  completed_requests: number;
  batch_wall_ms: number;
  request_latency: LatencySummary;
  upstream_requests: number;
  upstream_peak_concurrency: number;
  durable_refresh_successes: number;
  distinct_snapshot_timestamps: number;
  normalized_snapshot_bytes: number;
  gates: {
    all_requests_completed: boolean;
    single_refresh: boolean;
    upstream_operation_bound: boolean;
    snapshot_size_bound: boolean;
    local_cold_p95: boolean;
  };
}

const round = (value: number): number => Math.round(value * 10) / 10;

const percentile = (samples: readonly number[], fraction: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index] ?? 0);
};

const summarize = (samples: readonly number[]): LatencySummary => ({
  samples: samples.length,
  min_ms: round(Math.min(...samples)),
  p50_ms: percentile(samples, 0.5),
  p95_ms: percentile(samples, 0.95),
  max_ms: round(Math.max(...samples)),
});

const source: CatalogSystem = {
  system_id: "platform_fit_nyc",
  source_system_id: "platform_fit_nyc",
  name: "Platform Fit City Bike",
  operator: "OpenBike fixture",
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
    name: "Synthetic test fixture",
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
    confidence: "station_bounds",
    buffer_meters: 5_000,
  },
  location_hint: "enam",
  reviewed_hosts: ["gbfs.example.test"],
  request_headers: {},
  preferred_languages: ["en"],
  enabled: true,
};

const stationInformation = {
  ...citiLikeStationInformationV23,
  data: {
    stations: Array.from({ length: FIXTURE_STATION_COUNT }, (_, index) => ({
      ...citiLikeStationInformationV23.data.stations[0],
      station_id: `platform-${index.toString().padStart(5, "0")}`,
      name: `Recorded fixture station ${index.toString().padStart(5, "0")}`,
      lat: 40.61 + (index % 200) * 0.001,
      lon: -74.09 + (index % 200) * 0.001,
      capacity: 20 + (index % 30),
    })),
  },
};

const stationStatus = {
  ...citiLikeStationStatusV23,
  data: {
    stations: Array.from({ length: FIXTURE_STATION_COUNT }, (_, index) => ({
      ...citiLikeStationStatusV23.data.stations[0],
      station_id: `platform-${index.toString().padStart(5, "0")}`,
      num_bikes_available: index % 20,
      num_docks_available: 20 - (index % 20),
      vehicle_types_available: [
        { vehicle_type_id: "classic", count: index % 12 },
        { vehicle_type_id: "electric", count: index % 8 },
      ],
      last_reported: 1_788_263_090 - (index % 30),
    })),
  },
};

const serializedDocuments = new Map<string, string>([
  ["gbfs.json", JSON.stringify(citiLikeDiscoveryV23)],
  ["system_information.json", JSON.stringify(citiLikeSystemInformationV23)],
  ["station_information.json", JSON.stringify(stationInformation)],
  ["station_status.json", JSON.stringify(stationStatus)],
  ["vehicle_types.json", JSON.stringify(citiLikeVehicleTypesV23)],
]);

const runScenario = async (concurrency: number): Promise<ScenarioReport> => {
  let upstreamRequests = 0;
  let activeUpstreamRequests = 0;
  let upstreamPeakConcurrency = 0;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    upstreamRequests += 1;
    activeUpstreamRequests += 1;
    upstreamPeakConcurrency = Math.max(
      upstreamPeakConcurrency,
      activeUpstreamRequests,
    );
    try {
      // Make overlapping subfeed reads observable without introducing network
      // variance. This timer is the only artificial latency in the fixture.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const filename = url.pathname.split("/").at(-1);
      const document = filename === undefined ? undefined : serializedDocuments.get(filename);
      if (document === undefined) return new Response(null, { status: 404 });
      return new Response(document, {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"platform-fit-v1"',
        },
      });
    } finally {
      activeUpstreamRequests -= 1;
    }
  });

  const stub = env.SYSTEM_FEEDS.getByName(
    `platform-fit-${concurrency}-${crypto.randomUUID()}`,
  ) as unknown as DurableObjectStub<SystemFeed>;

  return runInDurableObject(stub, async (instance) => {
    const batchStartedAt = performance.now();
    const requests = Array.from({ length: concurrency }, async () => {
      const startedAt = performance.now();
      const result = await instance.getAvailability({
        catalogSystem: source,
        forceRefresh: true,
        maxStalenessSeconds: 300,
      });
      return { result, durationMs: performance.now() - startedAt };
    });
    const completed = await Promise.all(requests);
    const batchWallMs = performance.now() - batchStartedAt;
    const health = await instance.getHealth();
    const first = completed[0]?.result;
    if (first === undefined) throw new Error("Benchmark scenario returned no result");

    const snapshotBytes = normalizedSnapshotByteLength({
      discovery: first.discovery,
      system: first.system,
      stations: first.stations,
      statuses: first.statuses,
      vehicleTypes: first.vehicleTypes,
      warnings: first.warnings,
    });
    const timestampCount = new Set(
      completed.map(({ result }) => result.fetched_at),
    ).size;
    const requestLatency = summarize(
      completed.map(({ durationMs }) => durationMs),
    );
    const gates = {
      all_requests_completed: completed.length === concurrency,
      single_refresh:
        upstreamRequests === EXPECTED_UPSTREAM_REQUESTS_PER_REFRESH &&
        health.successes === 1 &&
        timestampCount === 1,
      upstream_operation_bound:
        upstreamPeakConcurrency <= MAX_UPSTREAM_OPERATIONS,
      snapshot_size_bound: snapshotBytes <= MAX_NORMALIZED_SNAPSHOT_BYTES,
      local_cold_p95: requestLatency.p95_ms < LOCAL_COLD_P95_GATE_MS,
    };

    expect(completed).toHaveLength(concurrency);
    expect(completed.every(({ result }) => result.cache_status === "fresh")).toBe(true);
    expect(upstreamRequests).toBe(EXPECTED_UPSTREAM_REQUESTS_PER_REFRESH);
    expect(health.successes).toBe(1);
    expect(timestampCount).toBe(1);
    expect(upstreamPeakConcurrency).toBeLessThanOrEqual(MAX_UPSTREAM_OPERATIONS);
    expect(snapshotBytes).toBeLessThanOrEqual(MAX_NORMALIZED_SNAPSHOT_BYTES);
    expect(requestLatency.p95_ms).toBeLessThan(LOCAL_COLD_P95_GATE_MS);

    return {
      requested_concurrency: concurrency,
      completed_requests: completed.length,
      batch_wall_ms: round(batchWallMs),
      request_latency: requestLatency,
      upstream_requests: upstreamRequests,
      upstream_peak_concurrency: upstreamPeakConcurrency,
      durable_refresh_successes: health.successes,
      distinct_snapshot_timestamps: timestampCount,
      normalized_snapshot_bytes: snapshotBytes,
      gates,
    };
  });
};

describe("recorded-fixture platform fit", () => {
  it(
    "coalesces 1, 10, and 100 simultaneous cold misses within operation and size bounds",
    async () => {
      for (const [name, document] of serializedDocuments) {
        expect(
          new TextEncoder().encode(document).byteLength,
          `${name} must remain within the configured per-feed read bound`,
        ).toBeLessThanOrEqual(4 * 1024 * 1024);
      }

      const scenarios: ScenarioReport[] = [];
      for (const concurrency of CONCURRENCY_LEVELS) {
        scenarios.push(await runScenario(concurrency));
      }
      vi.unstubAllGlobals();

      const report = {
        schema_version: 1,
        runtime: "workerd via @cloudflare/vitest-pool-workers",
        execution_scope:
          "Concurrent SystemFeed calls inside one Durable Object instance via runInDurableObject",
        fixture: {
          profile: "citi-like-v2.3-expanded",
          source_files: [
            "fixtures/citi-like-v2.3.ts",
            "tests/platform-fit/fixture-benchmark.test.ts",
          ],
          station_count: FIXTURE_STATION_COUNT,
          synthetic: true,
          note: "Deterministic amplification of the repository fixture; no live provider or network is used.",
          feed_bytes: Object.fromEntries(
            [...serializedDocuments].map(([name, document]) => [
              name,
              new TextEncoder().encode(document).byteLength,
            ]),
          ),
        },
        configured_bounds: {
          max_upstream_operations: MAX_UPSTREAM_OPERATIONS,
          max_feed_bytes: 4 * 1024 * 1024,
          max_normalized_snapshot_bytes: MAX_NORMALIZED_SNAPSHOT_BYTES,
          local_cold_p95_gate_ms: LOCAL_COLD_P95_GATE_MS,
        },
        scenarios,
        functional_gates_passed: scenarios.every(({ gates }) =>
          Object.values(gates).every(Boolean),
        ),
      };

      console.log(`OPENBIKE_PLATFORM_FIT_RESULT:${JSON.stringify(report)}`);
    },
    120_000,
  );
});
