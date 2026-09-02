import { describe, expect, it, vi } from "vitest";

import {
  citiLikeDiscoveryV23,
  citiLikeStationInformationV23,
  citiLikeStationStatusV23,
  citiLikeSystemInformationV23,
  citiLikeVehicleTypesV23,
  legacyDiscoveryV11,
  legacyStationInformationV11,
  legacyStationStatusV11,
  malformedDiscovery,
  malformedNonObject,
  malformedStationInformation,
  osloLikeDiscoveryV3,
  osloLikeStationInformationV3,
  osloLikeStationStatusV3,
  osloLikeSystemInformationV3,
  osloLikeVehicleTypesV3,
  partialStationInformationV23,
  partialStationStatusV23,
} from "../../fixtures";
import {
  GbfsClient,
  GbfsFeedError,
  GbfsNormalizationError,
  getGbfsFailureFeedName,
  normalizeDiscovery,
  normalizeStations,
  normalizeStationStatuses,
  normalizeSystemInformation,
  normalizeVehicleTypes,
  type GbfsNormalizationContext,
  type GbfsSystemSource,
} from "../../src/gbfs";
import type { FetchLike } from "../../src/security";

const v23Context: GbfsNormalizationContext = {
  systemId: "synthetic_nyc",
  discoveryUrl: "https://gbfs.example.test/gbfs/2.3/gbfs.json",
  detectedVersion: "2.3",
  fetchedAt: "2026-09-02T14:30:01Z",
  languages: ["en"],
  preferredLanguages: ["en"],
  city: "New York City",
  countryCode: "US",
};

const v3Context: GbfsNormalizationContext = {
  systemId: "synthetic_oslo",
  discoveryUrl: "https://api.example.test/mobility/oslo/gbfs",
  detectedVersion: "3.0",
  fetchedAt: "2026-09-02T14:30:01Z",
  preferredLanguages: ["nb", "en"],
  city: "Oslo",
  countryCode: "NO",
};

describe("GBFS normalization", () => {
  it.each(["2.1", "2.2", "2.3"])(
    "accepts the supported v%s discovery envelope",
    (version) => {
      const document = { ...citiLikeDiscoveryV23, version };
      expect(
        normalizeDiscovery(document, { systemId: "synthetic_nyc" }).value
          .version,
      ).toBe(version);
    },
  );

  it("normalizes a localized v2.3 discovery document", () => {
    const result = normalizeDiscovery(citiLikeDiscoveryV23, {
      systemId: "synthetic_nyc",
      preferredLanguages: ["en"],
    });

    expect(result.value.version).toBe("2.3");
    expect(result.value.languages).toEqual(["en"]);
    expect(result.value.feeds.station_status).toContain("station_status.json");
    expect(result.value.feeds.free_bike_status).toContain(
      "free_bike_status.json",
    );
  });

  it("normalizes v2.3 station, status, system, and vehicle-type feeds", () => {
    const vehicleTypes = normalizeVehicleTypes(
      citiLikeVehicleTypesV23,
      v23Context,
    ).value;
    const system = normalizeSystemInformation(citiLikeSystemInformationV23, {
      ...v23Context,
      vehicleTypes,
      capabilities: {
        docked: true,
        dockless: true,
        ebike: true,
        station_status: true,
      },
    }).value;
    const stations = normalizeStations(
      citiLikeStationInformationV23,
      v23Context,
    ).value;
    const statuses = normalizeStationStatuses(citiLikeStationStatusV23, {
      ...v23Context,
      vehicleTypes,
    }).value;

    expect(system).toMatchObject({
      system_id: "synthetic_nyc",
      name: "Synthetic City Bike",
      city: "New York City",
      country_code: "US",
    });
    expect(stations).toHaveLength(2);
    expect(stations[1]?.station_type).toBe("virtual");
    expect(vehicleTypes.map((type) => type.category)).toEqual([
      "bike",
      "ebike",
    ]);
    expect(statuses[0]?.availability).toMatchObject({
      bikes_available: 9,
      docks_available: 21,
      vehicle_type_counts: { bike: 6, ebike: 3 },
      confidence: "high",
    });
  });

  it("normalizes v3 localized strings and RFC 3339 status times", () => {
    const discovery = normalizeDiscovery(osloLikeDiscoveryV3, {
      systemId: "synthetic_oslo",
      preferredLanguages: ["nb", "en"],
    }).value;
    const vehicleTypes = normalizeVehicleTypes(
      osloLikeVehicleTypesV3,
      v3Context,
    ).value;
    const system = normalizeSystemInformation(osloLikeSystemInformationV3, {
      ...v3Context,
      vehicleTypes,
    }).value;
    const stations = normalizeStations(
      osloLikeStationInformationV3,
      v3Context,
    ).value;
    const statuses = normalizeStationStatuses(osloLikeStationStatusV3, {
      ...v3Context,
      vehicleTypes,
    }).value;

    expect(discovery.version).toBe("3.0");
    expect(system.name).toBe("Eksempel bysykkel");
    expect(stations[0]?.name).toBe("Eksempelplassen");
    expect(statuses[0]?.station_last_reported).toBe(
      "2026-09-02T14:29:55.000Z",
    );
    expect(statuses[0]?.availability.vehicle_type_counts).toEqual({
      bike: 5,
      ebike: 2,
    });
  });

  it("fails closed on legacy discovery but tolerates documented v1.1 station edges", () => {
    expect(() =>
      normalizeDiscovery(legacyDiscoveryV11, { systemId: "legacy" }),
    ).toThrowError(GbfsNormalizationError);

    const legacyContext: GbfsNormalizationContext = {
      ...v23Context,
      systemId: "legacy",
      detectedVersion: "1.1",
    };
    const stationResult = normalizeStations(
      legacyStationInformationV11,
      legacyContext,
    );
    const statusResult = normalizeStationStatuses(
      legacyStationStatusV11,
      legacyContext,
    );

    expect(stationResult.value[0]).toMatchObject({
      capacity: null,
      station_type: "KIOSK",
    });
    expect(stationResult.warnings.map((warning) => warning.code)).toContain(
      "AMBIGUOUS_CAPACITY",
    );
    expect(statusResult.value[0]?.availability.vehicle_type_counts).toEqual({
      bike: 3,
      other: 1,
    });
    expect(statusResult.warnings.map((warning) => warning.code)).toContain(
      "VEHICLE_TYPE_AMBIGUOUS",
    );
  });

  it("rejects malformed envelopes and aggregates partial-record warnings", () => {
    expect(() =>
      normalizeDiscovery(malformedNonObject, { systemId: "synthetic" }),
    ).toThrowError(GbfsNormalizationError);
    expect(() =>
      normalizeDiscovery(malformedDiscovery, { systemId: "synthetic" }),
    ).toThrowError(GbfsNormalizationError);
    expect(() =>
      normalizeStations(malformedStationInformation, v23Context),
    ).toThrowError(GbfsNormalizationError);

    const stations = normalizeStations(
      partialStationInformationV23,
      v23Context,
    );
    const statuses = normalizeStationStatuses(
      partialStationStatusV23,
      v23Context,
    );
    expect(stations.value).toHaveLength(1);
    expect(stations.value[0]?.rental_uris).toEqual({
      web: "https://example.test/station/partial-good",
    });
    expect(stations.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["PARTIAL_RESULTS", "AMBIGUOUS_CAPACITY"]),
    );
    expect(statuses.value).toHaveLength(2);
    expect(statuses.value[0]?.station_last_reported).toBeNull();
    expect(statuses.value[1]?.availability.confidence).toBe("low");
  });
});

describe("GbfsClient", () => {
  const source: GbfsSystemSource = {
    systemId: "synthetic_nyc",
    discoveryUrl: "https://gbfs.example.test/gbfs/2.3/gbfs.json",
    city: "New York City",
    countryCode: "US",
    preferredLanguages: ["en"],
    reviewedHosts: [
      { hostname: "gbfs.example.test", pathPrefixes: ["/gbfs/"] },
    ],
  };

  const documentsBySuffix = new Map<string, unknown>([
    ["/gbfs/2.3/gbfs.json", citiLikeDiscoveryV23],
    ["/system_information.json", citiLikeSystemInformationV23],
    ["/station_information.json", citiLikeStationInformationV23],
    ["/station_status.json", citiLikeStationStatusV23],
    ["/vehicle_types.json", citiLikeVehicleTypesV23],
  ]);

  it("fetches only station-bundle feeds and reuses conditional cache entries", async () => {
    const requestedPaths: string[] = [];
    let conditionalRound = false;
    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(input.toString());
      requestedPaths.push(url.pathname);
      expect(url.pathname).not.toContain("free_bike_status");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      if (conditionalRound) {
        expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      const matching = [...documentsBySuffix].find(([suffix]) =>
        url.pathname.endsWith(suffix),
      );
      if (matching === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(matching[1]), {
        headers: { "content-type": "application/json", etag: '"v1"' },
      });
    };
    const client = new GbfsClient(source, {
      fetcher,
      now: () => new Date("2026-09-02T14:30:01Z"),
    });

    const first = await client.fetchStationBundle();
    expect(first.stations).toHaveLength(2);
    expect(first.statuses).toHaveLength(2);
    expect(first.vehicleTypes).toHaveLength(2);
    expect(first.system.capabilities).toMatchObject({
      docked: true,
      dockless: true,
      ebike: true,
    });
    expect(requestedPaths).toHaveLength(5);

    conditionalRound = true;
    const second = await client.fetchStationBundle(first.state);
    expect(second.stations).toEqual(first.stations);
    expect(second.observations).toHaveLength(5);
    expect(second.observations.every(({ http_status }) => http_status === 304)).toBe(
      true,
    );
    expect(requestedPaths).toHaveLength(10);
  });

  it("applies a provider-required request header and avoids v3 vehicle status", async () => {
    const v3Documents = new Map<string, unknown>([
      ["/mobility/oslo/gbfs", osloLikeDiscoveryV3],
      ["/mobility/oslo/system_information", osloLikeSystemInformationV3],
      ["/mobility/oslo/station_information", osloLikeStationInformationV3],
      ["/mobility/oslo/station_status", osloLikeStationStatusV3],
      ["/mobility/oslo/vehicle_types", osloLikeVehicleTypesV3],
    ]);
    const requestedPaths: string[] = [];
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      const url = new URL(input.toString());
      requestedPaths.push(url.pathname);
      expect(new Headers(init?.headers).get("et-client-name")).toBe(
        "openbike-mcp",
      );
      const document = v3Documents.get(url.pathname);
      return document === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(document), {
            headers: { "content-type": "application/json" },
          });
    });
    const client = new GbfsClient(
      {
        systemId: "synthetic_oslo",
        discoveryUrl: "https://api.example.test/mobility/oslo/gbfs",
        preferredLanguages: ["nb", "en"],
        reviewedHosts: [
          { hostname: "api.example.test", pathPrefixes: ["/mobility/oslo/"] },
        ],
        requestHeaders: { "ET-Client-Name": "openbike-mcp" },
      },
      { fetcher },
    );

    const bundle = await client.fetchStationBundle();
    expect(bundle.system.name).toBe("Eksempel bysykkel");
    expect(requestedPaths).not.toContain("/mobility/oslo/vehicle_status");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("preserves the identity and safe classification of a failing subfeed", async () => {
    const fetcher: FetchLike = async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/station_status.json")) {
        return new Response("provider secret", { status: 503 });
      }
      const matching = [...documentsBySuffix].find(([suffix]) =>
        url.pathname.endsWith(suffix),
      );
      return matching === undefined
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(matching[1]), {
            headers: { "content-type": "application/json" },
          });
    };
    const error = await new GbfsClient(source, { fetcher })
      .fetchStationBundle()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GbfsFeedError);
    expect(error).toMatchObject({
      feedName: "station_status",
      code: "UPSTREAM_HTTP_ERROR",
      httpStatus: 503,
      retryable: true,
    });
    expect(getGbfsFailureFeedName(error)).toBe("station_status");
    expect((error as Error).message).not.toContain("provider secret");
  });
});
