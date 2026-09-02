import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import type { CatalogSnapshot, CatalogSystem } from "../../src/catalog";
import {
  DomainError,
  type Availability,
  type Station,
  type StationStatus,
  type System,
} from "../../src/contracts";
import type {
  SystemFeedAvailabilityResult,
  SystemFeedHealth,
} from "../../src/durable";
import { failureResult, successResult } from "../../src/mcp/results";
import { createOpenBikeMcpServer } from "../../src/mcp/server";
import {
  OpenBikeMcpService,
  type SystemFeedClient,
} from "../../src/mcp/service";

const NOW = new Date("2026-09-02T16:00:00.000Z");
const FETCHED_AT = "2026-09-02T15:59:55.000Z";
const OBSERVED_AT = "2026-09-02T15:59:50.000Z";

const capabilities = {
  docked: true,
  dockless: false,
  ebike: true,
  station_status: true,
} as const;

const catalogSystem = (
  systemId: string,
  overrides: Partial<CatalogSystem> = {},
): CatalogSystem => ({
  system_id: systemId,
  source_system_id: systemId,
  name: `System ${systemId}`,
  operator: "Example Operator",
  city: "Test City",
  region: "Test Region",
  country_code: "US",
  timezone: "America/New_York",
  discovery_url: `https://${systemId}.example.com/gbfs.json`,
  detected_version: "2.3",
  languages: ["en"],
  license: {
    id: "CC0-1.0",
    name: "CC0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    status: "declared",
  },
  capabilities,
  coverage: {
    bounds: {
      south: 40.6,
      west: -74.1,
      north: 40.8,
      east: -73.9,
    },
    centroid: { latitude: 40.7, longitude: -74 },
    confidence: "station_bounds",
    buffer_meters: 0,
  },
  location_hint: "enam",
  reviewed_hosts: [`${systemId}.example.com`],
  request_headers: {},
  preferred_languages: ["en"],
  enabled: true,
  ...overrides,
});

const contractSystem = (system: CatalogSystem): System => ({
  system_id: system.system_id,
  name: system.name,
  operator: system.operator,
  city: system.city,
  region: system.region,
  country_code: system.country_code,
  timezone: system.timezone,
  discovery_url: system.discovery_url,
  detected_version: system.detected_version,
  languages: system.languages,
  license: system.license.url,
  capabilities: system.capabilities,
});

const station = (
  systemId: string,
  stationId: string,
  latitude: number,
  overrides: Partial<Station> = {},
): Station => ({
  system_id: systemId,
  station_id: stationId,
  name: `Station ${stationId}`,
  latitude,
  longitude: -74,
  capacity: 20,
  station_type: "classic",
  region_id: null,
  rental_methods: ["CREDITCARD"],
  rental_uris: { web: "https://example.com/rent" },
  ...overrides,
});

const availability = (
  bikesAvailable: number,
  overrides: Partial<Availability> = {},
): Availability => ({
  bikes_available: bikesAvailable,
  docks_available: 10,
  vehicle_type_counts: { bike: bikesAvailable },
  is_renting: true,
  is_returning: true,
  is_installed: true,
  confidence: "high",
  ...overrides,
});

const status = (
  systemId: string,
  stationId: string,
  bikesAvailable: number,
): StationStatus => ({
  system_id: systemId,
  station_id: stationId,
  observed_at: OBSERVED_AT,
  station_last_reported: OBSERVED_AT,
  availability: availability(bikesAvailable),
});

const snapshot = (
  system: CatalogSystem,
  stations: Station[],
  statuses: StationStatus[],
): SystemFeedAvailabilityResult => ({
  discovery: {
    version: system.detected_version ?? "2.3",
    languages: system.languages,
    feeds: {
      station_information: `https://${system.system_id}.example.com/station_information.json`,
      station_status: `https://${system.system_id}.example.com/station_status.json`,
    },
    providerLastUpdated: OBSERVED_AT,
    ttlSeconds: 30,
  },
  system: contractSystem(system),
  stations,
  statuses,
  vehicleTypes: [],
  warnings: [],
  fetched_at: FETCHED_AT,
  expires_at: "2026-09-02T16:00:25.000Z",
  ttl_seconds: 30,
  age_seconds: 5,
  stale: false,
  cache_status: "fresh",
  snapshot_slot: "current",
});

const health = (system: CatalogSystem): SystemFeedHealth => ({
  system_id: system.system_id,
  discovery_url: system.discovery_url,
  detected_version: system.detected_version,
  ready: true,
  state: "healthy",
  circuit_state: "closed",
  consecutive_failures: 0,
  open_until: null,
  last_success_at: FETCHED_AT,
  last_error_at: null,
  last_error_class: null,
  snapshot_fetched_at: FETCHED_AT,
  snapshot_expires_at: "2026-09-02T16:00:25.000Z",
  observation_count: 10,
  feeds: [],
  rolling_success_rate: 1,
  rolling_window_seconds: 86_400,
  successes: 10,
  failures: 0,
});

const catalog = (systems: CatalogSystem[]): CatalogSnapshot => ({
  schema_version: 1,
  version: "catalog-test-v1",
  generated_at: "2026-09-02T15:00:00.000Z",
  source_url: "https://example.com/systems.csv",
  source_etag: null,
  systems,
});

const service = (
  systems: CatalogSystem[],
  feedForSystem: (system: CatalogSystem) => SystemFeedClient,
  maxCandidateSystems = 4,
) =>
  new OpenBikeMcpService({
    loadCatalog: async () => catalog(systems),
    feedForSystem,
    requestId: "request-test-1",
    workerVersion: "0.1.0-test",
    maxCandidateSystems,
    now: () => NOW,
    requestDeadlineMs: 1_000,
  });

describe("OpenBikeMcpService", () => {
  it("bounds fan-out at four systems, ranks live results, and preserves partial success", async () => {
    const systems = ["sys-a", "sys-b", "sys-c", "sys-d", "sys-e"].map(
      (systemId) => catalogSystem(systemId),
    );
    const bikeCounts: Record<string, number> = {
      "sys-a": 2,
      "sys-c": 9,
      "sys-d": 5,
      "sys-e": 100,
    };
    const availabilityCalls: string[] = [];
    const feeds = new Map<string, SystemFeedClient>();
    for (const system of systems) {
      feeds.set(system.system_id, {
        getAvailability: vi.fn(async (query) => {
          availabilityCalls.push(system.system_id);
          expect(query?.catalogSystem).toBe(system);
          expect(query?.maxStalenessSeconds).toBe(300);
          if (system.system_id === "sys-b") {
            throw new DomainError(
              "SYSTEM_UNAVAILABLE",
              "provider detail must not escape",
              true,
            );
          }
          const stationRecord = station(
            system.system_id,
            `${system.system_id}-station`,
            40.7001,
          );
          return snapshot(system, [stationRecord], [
            status(
              system.system_id,
              stationRecord.station_id,
              bikeCounts[system.system_id] ?? 1,
            ),
          ]);
        }),
        getHealth: vi.fn(async () => health(system)),
      });
    }

    const output = await service(
      systems,
      (system) => feeds.get(system.system_id) as SystemFeedClient,
    ).getNearbyAvailability({
      latitude: 40.7,
      longitude: -74,
      mode: "take",
      radius_meters: 800,
      limit: 5,
      minimum_available: 1,
      include_unavailable: false,
      max_staleness_seconds: 300,
    });

    expect(availabilityCalls).toEqual(["sys-a", "sys-b", "sys-c", "sys-d"]);
    expect(output.systems_considered.map(({ system_id }) => system_id)).toEqual([
      "sys-a",
      "sys-b",
      "sys-c",
      "sys-d",
    ]);
    expect(output.systems_failed).toEqual([
      {
        system_id: "sys-b",
        code: "SYSTEM_UNAVAILABLE",
        retryable: true,
      },
    ]);
    expect(output.results.map(({ system }) => system.system_id)).toEqual([
      "sys-c",
      "sys-d",
      "sys-a",
    ]);
    expect(output.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["PROVIDER_UNAVAILABLE", "PARTIAL_RESULTS"]),
    );
    expect(JSON.stringify(output)).not.toContain("provider detail must not escape");
  });

  it("labels TTL-stale observations and rejects data beyond the caller's threshold", async () => {
    const system = catalogSystem("stale-system");
    const item = station(system.system_id, "stale-station", 40.7001);
    const staleStatus = status(system.system_id, item.station_id, 4);
    staleStatus.observed_at = "2026-09-02T15:58:00.000Z";
    staleStatus.station_last_reported = "2026-09-02T15:58:00.000Z";
    const staleSnapshot = snapshot(system, [item], [staleStatus]);
    staleSnapshot.discovery.providerLastUpdated =
      "2026-09-02T15:58:00.000Z";
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => staleSnapshot),
      getHealth: vi.fn(async () => health(system)),
    };
    const subject = service([system], () => feed);
    const baseInput = {
      latitude: 40.7,
      longitude: -74,
      mode: "take" as const,
      radius_meters: 800,
      limit: 5,
      minimum_available: 1,
      include_unavailable: false,
    };

    const output = await subject.getNearbyAvailability({
      ...baseInput,
      max_staleness_seconds: 300,
    });
    expect(output.results[0]?.freshness).toMatchObject({
      age_seconds: 120,
      ttl_seconds: 30,
      is_stale: true,
    });
    expect(output.results[0]?.availability.confidence).toBe("low");
    expect(output.warnings).toEqual([
      expect.objectContaining({
        code: "STALE_DATA",
        station_id: item.station_id,
      }),
    ]);

    await expect(
      subject.getNearbyAvailability({
        ...baseInput,
        max_staleness_seconds: 30,
      }),
    ).rejects.toMatchObject({ code: "STALE_DATA", retryable: true });
  });

  it("marks warning truncation when more than one hundred unique warnings exist", async () => {
    const system = catalogSystem("warning-cap-system");
    const item = station(system.system_id, "warning-cap-station", 40.7001);
    const current = snapshot(system, [item], [
      status(system.system_id, item.station_id, 4),
    ]);
    current.warnings = Array.from({ length: 101 }, (_, index) => ({
      code: "AMBIGUOUS_CAPACITY" as const,
      message: "The provider supplied an ambiguous station capacity.",
      system_id: system.system_id,
      station_id: `warning-${index}`,
      retryable: false,
    }));
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => current),
      getHealth: vi.fn(async () => health(system)),
    };

    const output = await service([system], () => feed).getNearbyAvailability({
      latitude: 40.7,
      longitude: -74,
      mode: "take",
      radius_meters: 800,
      limit: 5,
      minimum_available: 1,
      include_unavailable: false,
      max_staleness_seconds: 300,
    });

    expect(output.warnings).toHaveLength(100);
    expect(output.warnings.at(-1)).toEqual({
      code: "WARNINGS_TRUNCATED",
      message: "Additional warnings were omitted from this response.",
      retryable: false,
    });
  });

  it("uses station-status envelope metadata instead of the discovery timestamp", async () => {
    const system = catalogSystem("per-feed-time-system");
    const item = station(system.system_id, "per-feed-time-station", 40.7001);
    const liveStatus = status(system.system_id, item.station_id, 4);
    liveStatus.station_last_reported = null;
    liveStatus.observed_at = "2026-09-02T15:59:40.000Z";
    const current = snapshot(system, [item], [liveStatus]);
    current.discovery.providerLastUpdated = "2026-09-02T15:40:00.000Z";
    current.source_observations = {
      station_information: {
        provider_last_updated: "2026-09-02T15:30:00.000Z",
        fetched_at: "2026-09-02T15:59:54.000Z",
        ttl_seconds: 300,
      },
      station_status: {
        provider_last_updated: "2026-09-02T15:59:40.000Z",
        fetched_at: "2026-09-02T15:59:55.000Z",
        ttl_seconds: 5,
      },
    };
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => current),
      getHealth: vi.fn(async () => health(system)),
    };

    const output = await service([system], () => feed).getStation({
      system_id: system.system_id,
      station_id: item.station_id,
      include_status: true,
      include_raw_links: true,
    });

    expect(output.freshness).toMatchObject({
      provider_last_updated: "2026-09-02T15:59:40.000Z",
      station_last_reported: null,
      fetched_at: "2026-09-02T15:59:55.000Z",
      age_seconds: 20,
      ttl_seconds: 5,
      is_stale: true,
    });
    expect(output.sources).toEqual([
      expect.objectContaining({
        feed_name: "station_information",
        provider_last_updated: "2026-09-02T15:30:00.000Z",
        fetched_at: "2026-09-02T15:59:54.000Z",
      }),
      expect.objectContaining({
        feed_name: "station_status",
        provider_last_updated: "2026-09-02T15:59:40.000Z",
        fetched_at: "2026-09-02T15:59:55.000Z",
      }),
    ]);
  });

  it("preserves a missing station-status source timestamp", async () => {
    const system = catalogSystem("missing-source-time-system");
    const item = station(system.system_id, "missing-source-time-station", 40.7001);
    const liveStatus = status(system.system_id, item.station_id, 4);
    liveStatus.station_last_reported = null;
    liveStatus.observed_at = FETCHED_AT;
    const current = snapshot(system, [item], [liveStatus]);
    current.discovery.providerLastUpdated = "2026-09-02T15:59:59.000Z";
    current.source_observations = {
      station_information: {
        provider_last_updated: "2026-09-02T15:55:00.000Z",
        fetched_at: FETCHED_AT,
      },
      station_status: {
        provider_last_updated: null,
        fetched_at: FETCHED_AT,
        ttl_seconds: 30,
      },
    };
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => current),
      getHealth: vi.fn(async () => health(system)),
    };

    const output = await service([system], () => feed).getNearbyAvailability({
      latitude: 40.7,
      longitude: -74,
      mode: "take",
      radius_meters: 800,
      limit: 5,
      minimum_available: 1,
      include_unavailable: false,
      max_staleness_seconds: 300,
    });

    expect(output.results[0]?.freshness).toMatchObject({
      provider_last_updated: null,
      station_last_reported: null,
      fetched_at: FETCHED_AT,
      age_seconds: 5,
    });
    expect(output.results[0]?.availability.confidence).toBe("medium");
    expect(
      output.results[0]?.sources.find(
        ({ feed_name }) => feed_name === "station_status",
      ),
    ).toMatchObject({ provider_last_updated: null, fetched_at: FETCHED_AT });
    expect(output.warnings).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_TIMESTAMP_MISSING",
        station_id: item.station_id,
      }),
    );
  });

  it("preserves a zero station-status TTL independently of cache policy", async () => {
    const system = catalogSystem("zero-ttl-system");
    const item = station(system.system_id, "zero-ttl-station", 40.7001);
    const liveStatus = status(system.system_id, item.station_id, 4);
    liveStatus.station_last_reported = null;
    const current = snapshot(system, [item], [liveStatus]);
    current.source_observations = {
      station_status: {
        provider_last_updated: "2026-09-02T15:59:59.000Z",
        fetched_at: FETCHED_AT,
        ttl_seconds: 0,
      },
    };
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => current),
      getHealth: vi.fn(async () => health(system)),
    };

    const output = await service([system], () => feed).getStation({
      system_id: system.system_id,
      station_id: item.station_id,
      include_status: true,
      include_raw_links: false,
    });
    expect(output.freshness).toMatchObject({
      provider_last_updated: "2026-09-02T15:59:59.000Z",
      ttl_seconds: 0,
      age_seconds: 1,
      is_stale: true,
    });
  });

  it("uses current snapshot capabilities throughout station-tool responses", async () => {
    const system = catalogSystem("live-capability-system", {
      capabilities: {
        docked: true,
        dockless: false,
        ebike: true,
        station_status: true,
      },
    });
    const item = station(system.system_id, "live-capability-station", 40.7001);
    const current = snapshot(system, [item], [
      status(system.system_id, item.station_id, 4),
    ]);
    current.system.capabilities = {
      docked: false,
      dockless: true,
      ebike: false,
      station_status: true,
    };
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => current),
      getHealth: vi.fn(async () => health(system)),
    };
    const subject = service([system], () => feed);
    const expected = current.system.capabilities;

    const nearby = await subject.getNearbyAvailability({
      latitude: 40.7,
      longitude: -74,
      mode: "take",
      radius_meters: 800,
      limit: 5,
      minimum_available: 1,
      include_unavailable: false,
      max_staleness_seconds: 300,
    });
    expect(nearby.systems_considered[0]?.capabilities).toEqual(expected);
    expect(nearby.results[0]?.system.capabilities).toEqual(expected);

    const found = await subject.findStations({
      latitude: 40.7,
      longitude: -74,
      radius_meters: 800,
      include_status: true,
      operational_only: true,
      limit: 50,
    });
    expect(found.systems_considered[0]?.capabilities).toEqual(expected);
    expect(found.results[0]?.system.capabilities).toEqual(expected);

    const single = await subject.getStation({
      system_id: system.system_id,
      station_id: item.station_id,
      include_status: true,
      include_raw_links: false,
    });
    expect(single.system.capabilities).toEqual(expected);
  });

  it("paginates deterministic station results and binds cursors to the query", async () => {
    const system = catalogSystem("cursor-system");
    const stations = [
      station(system.system_id, "near", 40.7001, { name: "École Dock" }),
      station(system.system_id, "middle", 40.701),
      station(system.system_id, "far", 40.702),
    ];
    const statuses = stations.map((item) =>
      status(system.system_id, item.station_id, 3),
    );
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => snapshot(system, stations, statuses)),
      getHealth: vi.fn(async () => health(system)),
    };
    const subject = service([system], () => feed);

    const first = await subject.findStations({
      latitude: 40.7,
      longitude: -74,
      radius_meters: 5_000,
      include_status: true,
      operational_only: true,
      limit: 2,
    });
    expect(first.results.map(({ station }) => station.station_id)).toEqual([
      "near",
      "middle",
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await subject.findStations({
      latitude: 40.7,
      longitude: -74,
      radius_meters: 5_000,
      include_status: true,
      operational_only: true,
      limit: 2,
      cursor: first.next_cursor as string,
    });
    expect(second.results.map(({ station }) => station.station_id)).toEqual([
      "far",
    ]);
    expect(second.next_cursor).toBeNull();

    await expect(
      subject.findStations({
        latitude: 40.7,
        longitude: -74,
        radius_meters: 4_000,
        include_status: true,
        operational_only: true,
        limit: 2,
        cursor: first.next_cursor as string,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const cursor = first.next_cursor as string;
    await expect(
      subject.findStations({
        latitude: 40.7,
        longitude: -74,
        radius_meters: 5_000,
        include_status: true,
        operational_only: true,
        limit: 2,
        cursor: `A${cursor.slice(1)}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const folded = await subject.findStations({
      latitude: 40.7,
      longitude: -74,
      radius_meters: 5_000,
      query: "ecole",
      include_status: true,
      operational_only: true,
      limit: 50,
    });
    expect(folded.results.map(({ station }) => station.station_id)).toEqual([
      "near",
    ]);
  });

  it("omits provider status beyond the station-tool staleness limit", async () => {
    const system = catalogSystem("expired-status-system");
    const item = station(system.system_id, "expired", 40.7001);
    const expiredStatus = status(system.system_id, item.station_id, 4);
    expiredStatus.observed_at = "2026-09-02T15:50:00.000Z";
    expiredStatus.station_last_reported = "2026-09-02T15:50:00.000Z";
    const expiredSnapshot = snapshot(system, [item], [expiredStatus]);
    expiredSnapshot.discovery.providerLastUpdated =
      "2026-09-02T15:50:00.000Z";
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () => expiredSnapshot),
      getHealth: vi.fn(async () => health(system)),
    };
    const subject = service([system], () => feed);

    const metadataOnly = await subject.findStations({
      latitude: 40.7,
      longitude: -74,
      radius_meters: 5_000,
      include_status: true,
      operational_only: false,
      limit: 50,
    });
    expect(metadataOnly.results).toHaveLength(1);
    expect(metadataOnly.results[0]?.availability).toBeUndefined();
    expect(metadataOnly.results[0]?.freshness).toBeUndefined();
    expect(metadataOnly.warnings).toContainEqual(
      expect.objectContaining({
        code: "STALE_DATA",
        station_id: item.station_id,
      }),
    );

    const operational = await subject.findStations({
      latitude: 40.7,
      longitude: -74,
      radius_meters: 5_000,
      include_status: false,
      operational_only: true,
      limit: 50,
    });
    expect(operational.results).toEqual([]);

    const stationOutput = await subject.getStation({
      system_id: system.system_id,
      station_id: item.station_id,
      include_status: true,
      include_raw_links: true,
    });
    expect(stationOutput.station.station_id).toBe(item.station_id);
    expect(stationOutput.availability).toBeUndefined();
    expect(stationOutput.freshness).toBeUndefined();
    expect(stationOutput.sources.map(({ feed_name }) => feed_name)).toEqual([
      "station_information",
    ]);
    expect(stationOutput.warnings).toContainEqual(
      expect.objectContaining({
        code: "STALE_DATA",
        station_id: item.station_id,
      }),
    );
  });

  it("keeps raw feed links optional, sanitizes provider text, and distinguishes missing stations", async () => {
    const system = catalogSystem("station-system");
    const item = station(system.system_id, "one", 40.7, {
      name: "Safe\u202E Name\u0007",
    });
    const feed: SystemFeedClient = {
      getAvailability: vi.fn(async () =>
        snapshot(system, [item], [status(system.system_id, item.station_id, 2)]),
      ),
      getHealth: vi.fn(async () => health(system)),
    };
    const subject = service([system], () => feed);

    const output = await subject.getStation({
      system_id: system.system_id,
      station_id: item.station_id,
      include_status: false,
      include_raw_links: false,
    });
    expect(output.station.name).toBe("Safe Name");
    expect(output.availability).toBeUndefined();
    expect(output.freshness).toBeUndefined();
    expect(output.sources.length).toBeGreaterThan(0);
    expect(output.sources.every((source) => source.url === undefined)).toBe(
      true,
    );

    await expect(
      subject.getStation({
        system_id: system.system_id,
        station_id: "missing",
        include_status: true,
        include_raw_links: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  it("honors find_systems limits above the former sixteen-system platform cap", async () => {
    const systems = Array.from({ length: 30 }, (_, index) =>
      catalogSystem(`system-${index.toString().padStart(2, "0")}`),
    );
    const output = await service(systems, () => {
      throw new Error("find_systems must not fan out to provider feeds");
    }).findSystems({
      country_code: "us",
      capability: "ebike",
      radius_km: 50,
      limit: 25,
    });

    expect(output.results).toHaveLength(25);
    expect(output.results[0]?.system_id).toBe("system-00");
    expect(output.results[24]?.system_id).toBe("system-24");
    expect(output.results.every((result) => result.country_code === "US")).toBe(
      true,
    );
  });

  it("filters and reports systems with current probe-derived discovery metadata", async () => {
    const systems = [catalogSystem("system-a"), catalogSystem("system-b")];
    const loadProbeDiscoveryMetadata = vi.fn(async () =>
      new Map([
        [
          "system-a",
          {
            cycle_id: "cycle-current",
            catalog_version: "catalog-test-v1",
            system_id: "system-a",
            checked_at: "2026-09-02T15:59:56.000Z",
            detected_version: "3.0",
            capabilities: {
              docked: false,
              dockless: true,
              ebike: false,
              station_status: true,
            },
            last_successful_probe: FETCHED_AT,
          },
        ],
      ]),
    );
    const subject = new OpenBikeMcpService({
      loadCatalog: async () => catalog(systems),
      loadProbeDiscoveryMetadata,
      feedForSystem: () => {
        throw new Error("find_systems must not fan out to provider feeds");
      },
      requestId: "request-test-probe-overlay",
      workerVersion: "0.1.0-test",
      maxCandidateSystems: 4,
      now: () => NOW,
      requestDeadlineMs: 1_000,
    });

    const dockless = await subject.findSystems({
      capability: "dockless",
      radius_km: 50,
      limit: 20,
    });
    expect(dockless.results).toEqual([
      expect.objectContaining({
        system_id: "system-a",
        detected_version: "3.0",
        capabilities: expect.objectContaining({ dockless: true, ebike: false }),
        last_successful_probe: FETCHED_AT,
      }),
    ]);

    const ebike = await subject.findSystems({
      capability: "ebike",
      radius_km: 50,
      limit: 20,
    });
    expect(ebike.results.map((result) => result.system_id)).toEqual(["system-b"]);
    expect(ebike.results[0]?.last_successful_probe).toBeNull();
    expect(loadProbeDiscoveryMetadata).toHaveBeenCalledWith(
      "catalog-test-v1",
      ["system-a", "system-b"],
    );
  });

  it("maps one named system's rich durable health without forcing a refresh", async () => {
    const system = catalogSystem("health-system");
    const getAvailability = vi.fn(async () => {
      throw new Error("health must not force a provider refresh");
    });
    const getHealth = vi.fn(
      async (configuredSystem?: CatalogSystem): Promise<SystemFeedHealth> => ({
        ...health(system),
        system_id: configuredSystem?.system_id ?? null,
        discovery_url: configuredSystem?.discovery_url ?? null,
        detected_version: "3.0",
        capabilities: {
          docked: false,
          dockless: true,
          ebike: false,
          station_status: true,
        },
        state: "degraded",
        circuit_state: "half_open",
        consecutive_failures: 1,
        last_error_at: "2026-09-02T15:59:58.000Z",
        last_error_class: "tls",
        observation_count: 40,
        rolling_success_rate: 0.75,
        rolling_window_seconds: 86_400,
        successes: 30,
        failures: 10,
        feeds: [
          {
            feed_name: "station_status",
            present: true,
            last_successful_fetch: FETCHED_AT,
            provider_last_updated: OBSERVED_AT,
            ttl_seconds: 30,
            validation_status: "invalid",
            last_error_class: "tls",
          },
          {
            feed_name: "station_information",
            present: true,
            last_successful_fetch: FETCHED_AT,
            provider_last_updated: OBSERVED_AT,
            ttl_seconds: 300,
            validation_status: "valid",
            last_error_class: "none",
          },
        ],
      }),
    );
    const subject = service([system], () => ({ getAvailability, getHealth }));

    const output = await subject.getSystemHealth({
      system_id: system.system_id,
    });

    expect(getAvailability).not.toHaveBeenCalled();
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(getHealth).toHaveBeenCalledWith(system);
    expect(output).toMatchObject({
      system_id: system.system_id,
      discovery_url: system.discovery_url,
      detected_version: "3.0",
      capabilities: {
        docked: false,
        dockless: true,
        ebike: false,
        station_status: true,
      },
      rolling_success_rate: 0.75,
      rolling_window_seconds: 86_400,
      degradation_state: "degraded",
      last_successful_probe: FETCHED_AT,
    });
    expect(output.feeds).toHaveLength(2);
    expect(output.feeds[0]).toMatchObject({
      feed_name: "station_status",
      validation_status: "invalid",
      last_error_class: "unknown",
    });
    expect(output.warnings).toEqual([
      expect.objectContaining({
        code: "PROVIDER_UNAVAILABLE",
        system_id: system.system_id,
      }),
    ]);
  });
});

describe("MCP result and registration boundaries", () => {
  it("enforces response byte caps and never serializes unexpected error details", () => {
    expect(() => successResult({ payload: "too large" }, 1)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR" }),
    );

    const result = failureResult(
      new Error("secret-token=should-never-leak"),
      "request-safe-1",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"code":"INTERNAL_ERROR"');
    expect(result.content[0]?.text).toContain('"request_id":"request-safe-1"');
    expect(result.content[0]?.text).not.toContain("secret-token");
  });

  it("creates a fresh server and lists all five representable schemas over MCP", async () => {
    const env = {
      ENVIRONMENT: "test",
      PUBLIC_BASE_URL: "https://mcp.example.com",
      CONTACT_EMAIL: "test@example.com",
      MAX_CANDIDATE_SYSTEMS: "4",
      MAX_FEED_BYTES: "4194304",
      MAX_MCP_RESPONSE_BYTES: "1048576",
    } as unknown as Env;
    const first = createOpenBikeMcpServer(env, { requestId: "request-a" });
    const second = createOpenBikeMcpServer(env, { requestId: "request-b" });

    expect(first).not.toBe(second);
    const requiredNames = [
      "get_nearby_availability",
      "find_stations",
      "get_station",
      "find_systems",
      "get_system_health",
    ] as const;
    for (const toolName of requiredNames) {
      expect(first.toolInputSchemaJson(toolName)).toMatchObject({
        type: "object",
      });
    }
    expect(first.toolInputSchemaJson("get_system_health")).toMatchObject({
      required: ["system_id"],
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "openbike-unit-client",
      version: "0.1.0",
    });
    try {
      await first.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name).sort()).toEqual(
        [...requiredNames].sort(),
      );
      for (const tool of listed.tools) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
        expect(tool.outputSchema).toMatchObject({ type: "object" });
      }
    } finally {
      await client.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
    }
  });
});
