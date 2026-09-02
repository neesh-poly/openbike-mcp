import { describe, expect, it } from "vitest";

import {
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
  type Availability,
  type Freshness,
  type Station,
  type StationStatus,
  decodeCursor,
  encodeCursor,
  fingerprintQuery,
} from "../../src/contracts";
import {
  determineAvailabilityConfidence,
  evaluateFreshness,
  filterStationSearchCandidates,
  foldSearchText,
  haversineDistanceMeters,
  joinStationsWithStatus,
  matchesSearchText,
  redactTelemetryValue,
  sanitizeProviderText,
  selectNearbyCandidates,
} from "../../src/domain";

const now = "2026-09-02T16:00:00Z";

const station = (
  stationId: string,
  overrides: Partial<Station> = {},
): Station => ({
  system_id: "us-ny-citi-bike",
  station_id: stationId,
  name: `Station ${stationId}`,
  latitude: 40.72,
  longitude: -74,
  capacity: 20,
  station_type: "classic",
  region_id: null,
  rental_methods: ["KEY", "CREDITCARD"],
  rental_uris: null,
  ...overrides,
});

const availability = (
  overrides: Partial<Availability> = {},
): Availability => ({
  bikes_available: 4,
  docks_available: 6,
  vehicle_type_counts: { bike: 3, ebike: 1 },
  is_renting: true,
  is_returning: true,
  is_installed: true,
  confidence: "high",
  ...overrides,
});

const status = (
  stationId: string,
  overrides: Partial<StationStatus> = {},
): StationStatus => ({
  system_id: "us-ny-citi-bike",
  station_id: stationId,
  observed_at: "2026-09-02T15:59:50Z",
  station_last_reported: "2026-09-02T15:59:45Z",
  availability: availability(),
  ...overrides,
});

const freshness = (overrides: Partial<Freshness> = {}): Freshness => ({
  provider_last_updated: "2026-09-02T15:59:45Z",
  station_last_reported: "2026-09-02T15:59:45Z",
  fetched_at: "2026-09-02T15:59:50Z",
  age_seconds: 15,
  ttl_seconds: 30,
  is_stale: false,
  ...overrides,
});

const system = {
  system_id: "us-ny-citi-bike",
  name: "Citi Bike",
  operator: "Lyft",
  city: "New York",
  region: "NY",
  country_code: "US",
  timezone: "America/New_York",
  discovery_url: "https://gbfs.citibikenyc.com/gbfs/gbfs.json",
  detected_version: "2.3",
  languages: ["en"],
  license: null,
  capabilities: {
    docked: true,
    dockless: false,
    ebike: true,
    station_status: true,
  },
} as const;

const systemSummary = {
  system_id: system.system_id,
  name: system.name,
  operator: system.operator,
  city: system.city,
  region: system.region,
  country_code: system.country_code,
  capabilities: system.capabilities,
};

const metadata = {
  request_id: "req_123",
  catalog_version: "catalog-2026-09-02",
  generated_at: now,
  worker_version: "0.1.0",
};

describe("tool input contracts", () => {
  it("applies nearby defaults and canonicalizes set-like filters", () => {
    const parsed = GetNearbyAvailabilityInputSchema.parse({
      latitude: 40.72,
      longitude: -74,
      mode: "take",
      system_ids: ["us-ny-citi-bike", "us-ny-citi-bike"],
      vehicle_types: ["ebike", "bike", "ebike"],
    });

    expect(parsed).toMatchObject({
      radius_meters: 800,
      limit: 5,
      system_ids: ["us-ny-citi-bike"],
      vehicle_types: ["bike", "ebike"],
      minimum_available: 1,
      include_unavailable: false,
      max_staleness_seconds: 300,
    });
    expect(
      GetNearbyAvailabilityInputSchema.safeParse({
        latitude: 91,
        longitude: 0,
        mode: "take",
      }).success,
    ).toBe(false);
  });

  it("validates station search and station lookup defaults", () => {
    expect(
      FindStationsInputSchema.parse({ latitude: 0, longitude: 0 }),
    ).toMatchObject({
      radius_meters: 1_000,
      include_status: true,
      operational_only: true,
      limit: 50,
    });
    expect(
      GetStationInputSchema.parse({
        system_id: "us-ny-citi-bike",
        station_id: "abc",
      }),
    ).toMatchObject({ include_status: true, include_raw_links: true });
  });

  it("requires paired system-search coordinates and normalizes country", () => {
    expect(
      FindSystemsInputSchema.safeParse({ latitude: 40.7 }).success,
    ).toBe(false);
    expect(FindSystemsInputSchema.parse({ country_code: "us" })).toMatchObject({
      country_code: "US",
      radius_km: 50,
      limit: 20,
    });
  });

  it("requires a normalized system ID for health", () => {
    expect(GetSystemHealthInputSchema.safeParse({}).success).toBe(false);
    expect(
      GetSystemHealthInputSchema.parse({ system_id: "us-ny-citi-bike" }),
    ).toEqual({ system_id: "us-ny-citi-bike" });
  });
});

describe("tool output contracts", () => {
  const source = {
    system_id: system.system_id,
    feed_name: "station_status" as const,
    url: "https://gbfs.citibikenyc.com/gbfs/station_status.json",
    provider_last_updated: "2026-09-02T15:59:45Z",
    fetched_at: "2026-09-02T15:59:50Z",
  };

  it("validates all five stable structured outputs", () => {
    const nearbyResult = {
      system: systemSummary,
      station: station("a"),
      distance_meters: 42,
      availability: availability(),
      freshness: freshness(),
      sources: [source],
    };

    expect(
      GetNearbyAvailabilityOutputSchema.safeParse({
        query: {
          latitude: 40.72,
          longitude: -74,
          mode: "take",
          radius_meters: 800,
          limit: 5,
          system_ids: [],
          vehicle_types: [],
          minimum_available: 1,
          include_unavailable: false,
          max_staleness_seconds: 300,
        },
        systems_considered: [systemSummary],
        systems_failed: [],
        results: [nearbyResult],
        warnings: [],
        metadata,
      }).success,
    ).toBe(true);

    expect(
      FindStationsOutputSchema.safeParse({
        results: [nearbyResult],
        next_cursor: null,
        systems_considered: [systemSummary],
        systems_failed: [],
        warnings: [],
        metadata,
      }).success,
    ).toBe(true);

    expect(
      GetStationOutputSchema.safeParse({
        system: systemSummary,
        station: station("a"),
        availability: availability(),
        freshness: freshness(),
        sources: [source],
        warnings: [],
        metadata,
      }).success,
    ).toBe(true);

    expect(
      FindSystemsOutputSchema.safeParse({
        results: [
          {
            ...system,
            distance_meters: 100,
            coverage_confidence: "station_bounds",
            last_successful_probe: now,
          },
        ],
        warnings: [],
        metadata,
      }).success,
    ).toBe(true);

    expect(
      GetSystemHealthOutputSchema.safeParse({
        system_id: system.system_id,
        discovery_url: system.discovery_url,
        detected_version: "2.3",
        feeds: [
          {
            feed_name: "station_status",
            present: true,
            last_successful_fetch: now,
            provider_last_updated: "2026-09-02T15:59:45Z",
            ttl_seconds: 30,
            validation_status: "valid",
            last_error_class: "none",
          },
        ],
        rolling_success_rate: 1,
        rolling_window_seconds: 86_400,
        capabilities: system.capabilities,
        degradation_state: "healthy",
        last_successful_probe: now,
        warnings: [],
        metadata,
      }).success,
    ).toBe(true);
  });

  it("rejects mismatched availability and freshness", () => {
    expect(
      GetStationOutputSchema.safeParse({
        system: systemSummary,
        station: station("a"),
        availability: availability(),
        sources: [source],
        warnings: [],
        metadata,
      }).success,
    ).toBe(false);
  });
});

describe("opaque cursor helpers", () => {
  it("fingerprints canonical JSON independent of object key order", () => {
    expect(fingerprintQuery({ b: 2, a: 1 })).toBe(
      fingerprintQuery({ a: 1, b: 2 }),
    );
    expect(fingerprintQuery({ a: 1 })).not.toBe(fingerprintQuery({ a: 2 }));
  });

  it("round-trips deterministic cursors and rejects context mismatch", () => {
    const queryFingerprint = fingerprintQuery({ query: "canal", limit: 20 });
    const payload = {
      version: 1 as const,
      catalog_version: "catalog-v1",
      query_fingerprint: queryFingerprint,
      offset: 20,
    };
    const first = encodeCursor(payload);
    expect(encodeCursor(payload)).toBe(first);
    expect(
      decodeCursor(first, {
        catalogVersion: "catalog-v1",
        queryFingerprint,
      }),
    ).toEqual(payload);
    expect(() =>
      decodeCursor(first, {
        catalogVersion: "catalog-v1",
        queryFingerprint: fingerprintQuery({ limit: 5 }),
      }),
    ).toThrow("Invalid pagination cursor");
    expect(() =>
      decodeCursor("not-a-valid-cursor", {
        catalogVersion: "catalog-v1",
        queryFingerprint,
      }),
    ).toThrow("Invalid pagination cursor");
  });
});

describe("distance and search", () => {
  it("computes great-circle distance and validates coordinates", () => {
    expect(
      haversineDistanceMeters(
        { latitude: 40.7128, longitude: -74.006 },
        { latitude: 40.73061, longitude: -73.935242 },
      ),
    ).toBeCloseTo(6_283, -1);
    expect(() =>
      haversineDistanceMeters(
        { latitude: 100, longitude: 0 },
        { latitude: 0, longitude: 0 },
      ),
    ).toThrow("Invalid WGS84 coordinate");
  });

  it("matches names without case or diacritics", () => {
    expect(foldSearchText("  Hôtel  de  Ville ")).toBe("hotel de ville");
    expect(matchesSearchText("São Bento", "sao")).toBe(true);
    expect(matchesSearchText("København H", "oben")).toBe(false);
  });
});

describe("station join", () => {
  it("keeps namespaces isolated and reports missing/orphan status", () => {
    const result = joinStationsWithStatus(
      [station("same"), station("missing")],
      [
        status("same"),
        status("orphan"),
        status("same", {
          system_id: "us-il-divvy",
          observed_at: "2026-09-02T16:00:00Z",
        }),
      ],
    );

    expect(result.stations[0]?.status?.system_id).toBe("us-ny-citi-bike");
    expect(result.stations[1]?.status).toBeUndefined();
    expect(result.warnings.map(({ code }) => code)).toEqual([
      "ORPHAN_STATION_STATUS",
      "ORPHAN_STATION_STATUS",
      "MISSING_STATION_STATUS",
    ]);
  });

  it("uses the newest duplicate observation deterministically", () => {
    const older = status("a", { observed_at: "2026-09-02T15:00:00Z" });
    const newer = status("a", {
      observed_at: "2026-09-02T16:00:00Z",
      availability: availability({ bikes_available: 9 }),
    });
    const result = joinStationsWithStatus([station("a")], [older, newer]);
    expect(result.stations[0]?.status?.availability.bikes_available).toBe(9);
    expect(result.warnings[0]?.code).toBe("DUPLICATE_STATION_STATUS");
  });
});

describe("freshness and confidence", () => {
  it("prefers station timestamps, marks TTL staleness, and enforces max age", () => {
    const evaluation = evaluateFreshness({
      providerLastUpdated: "2026-09-02T15:59:55Z",
      stationLastReported: "2026-09-02T15:58:00Z",
      fetchedAt: "2026-09-02T15:59:58Z",
      ttlSeconds: 30,
      maxStalenessSeconds: 300,
      now,
    });

    expect(evaluation.freshness.age_seconds).toBe(120);
    expect(evaluation.freshness.is_stale).toBe(true);
    expect(evaluation.within_max_staleness).toBe(true);
    expect(
      determineAvailabilityConfidence({
        hasUsableStatus: true,
        relevantCountKnown: true,
        operationalFlagsKnown: true,
        freshness: evaluation,
      }),
    ).toBe("low");
  });

  it("does not allow a future provider timestamp to create negative age", () => {
    const evaluation = evaluateFreshness({
      providerLastUpdated: "2026-09-02T16:00:30Z",
      stationLastReported: null,
      fetchedAt: now,
      ttlSeconds: 30,
      maxStalenessSeconds: 300,
      now,
    });
    expect(evaluation.freshness.age_seconds).toBe(0);
  });
});

describe("nearby filtering and ranking", () => {
  const options = {
    mode: "take" as const,
    radiusMeters: 800,
    minimumAvailable: 1,
    maxStalenessSeconds: 300,
    includeUnavailable: false,
    vehicleTypes: ["ebike" as const],
  };

  it("ranks compatible availability before distance and excludes unknown/disabled", () => {
    const selected = selectNearbyCandidates(
      [
        {
          station: station("near"),
          status: status("near", {
            availability: availability({
              bikes_available: 10,
              vehicle_type_counts: { bike: 10 },
            }),
          }),
          freshness: freshness(),
          distance_meters: 25,
        },
        {
          station: station("far-more-ebikes"),
          status: status("far-more-ebikes", {
            availability: availability({
              bikes_available: 8,
              vehicle_type_counts: { bike: 3, ebike: 5 },
            }),
          }),
          freshness: freshness(),
          distance_meters: 200,
        },
        {
          station: station("close-fewer-ebikes"),
          status: status("close-fewer-ebikes", {
            availability: availability({
              bikes_available: 2,
              vehicle_type_counts: { bike: 1, ebike: 1 },
            }),
          }),
          freshness: freshness(),
          distance_meters: 10,
        },
        {
          station: station("disabled"),
          status: status("disabled", {
            availability: availability({ is_renting: false }),
          }),
          freshness: freshness(),
          distance_meters: 1,
        },
      ],
      options,
      10,
    );

    expect(selected.map(({ station: item }) => item.station_id)).toEqual([
      "far-more-ebikes",
      "close-fewer-ebikes",
    ]);
  });

  it("keeps unavailable entries below viable ones when explicitly requested", () => {
    const selected = selectNearbyCandidates(
      [
        {
          station: station("zero"),
          status: status("zero", {
            availability: availability({
              bikes_available: 0,
              vehicle_type_counts: { ebike: 0 },
            }),
          }),
          freshness: freshness(),
          distance_meters: 1,
        },
        {
          station: station("available"),
          status: status("available", {
            availability: availability({
              bikes_available: 1,
              vehicle_type_counts: { ebike: 1 },
            }),
          }),
          freshness: freshness(),
          distance_meters: 100,
        },
      ],
      { ...options, includeUnavailable: true },
      10,
    );
    expect(selected.map(({ station: item }) => item.station_id)).toEqual([
      "available",
      "zero",
    ]);
  });

  it("orders either-mode primarily by distance", () => {
    const selected = selectNearbyCandidates(
      [
        {
          station: station("far"),
          status: status("far", {
            availability: availability({ bikes_available: 20 }),
          }),
          freshness: freshness(),
          distance_meters: 200,
        },
        {
          station: station("near"),
          status: status("near", {
            availability: availability({ bikes_available: 1 }),
          }),
          freshness: freshness(),
          distance_meters: 20,
        },
      ],
      { ...options, mode: "either", vehicleTypes: [] },
      10,
    );
    expect(selected.map(({ station: item }) => item.station_id)).toEqual([
      "near",
      "far",
    ]);
  });

  it("pairs either-mode counts with the matching operational direction", () => {
    const selected = selectNearbyCandidates(
      [
        {
          station: station("crossed-signals"),
          status: status("crossed-signals", {
            availability: availability({
              bikes_available: 5,
              docks_available: 0,
              is_renting: false,
              is_returning: true,
            }),
          }),
          freshness: freshness(),
          distance_meters: 5,
        },
        {
          station: station("can-return"),
          status: status("can-return", {
            availability: availability({
              bikes_available: 5,
              docks_available: 2,
              is_renting: false,
              is_returning: true,
            }),
          }),
          freshness: freshness(),
          distance_meters: 20,
        },
      ],
      {
        ...options,
        mode: "either",
        vehicleTypes: [],
      },
      10,
    );

    expect(selected.map(({ station: item }) => item.station_id)).toEqual([
      "can-return",
    ]);
  });

  it("filters station metadata by radius, operations, system, and folded name", () => {
    const candidates = [
      {
        station: station("a", { name: "Hôtel de Ville" }),
        status: status("a"),
        distance_meters: 20,
      },
      {
        station: station("b", { name: "Hotel Central" }),
        status: status("b", {
          availability: availability({ is_installed: false }),
        }),
        distance_meters: 10,
      },
    ];
    expect(
      filterStationSearchCandidates(candidates, {
        radiusMeters: 500,
        operationalOnly: true,
        query: "hotel de ville",
        systemIds: ["us-ny-citi-bike"],
      }).map(({ station: item }) => item.station_id),
    ).toEqual(["a"]);
  });
});

describe("provider sanitization and telemetry redaction", () => {
  it("removes controls and bidi overrides, normalizes whitespace, and truncates", () => {
    expect(sanitizeProviderText("  Name\u0000 \u202E text  ", 8)).toBe(
      "Name te…",
    );
  });

  it("redacts sensitive fields and bounds nested provider data", () => {
    expect(
      redactTelemetryValue({
        latitude: 40.72,
        nested: {
          authorization: "Bearer secret",
          station_id: "abc",
        },
        values: [1, 2, 3],
      }, { maxArrayLength: 2 }),
    ).toEqual({
      latitude: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        station_id: "abc",
      },
      values: [1, 2, "[Truncated]"],
    });
  });
});
