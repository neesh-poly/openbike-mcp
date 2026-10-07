import { describe, expect, it } from "vitest";
import { createStationFeedClient } from "../../src/feeds/client";
import { GIRA_QUERY_URL } from "../../src/feeds/gira";
import { catalogSource } from "../../src/feeds/source";
import { BUNDLED_CATALOG_SYSTEMS } from "../../src/catalog/seed";
import { liveMapSnapshot } from "../../src/http/map-live";
import { determineAvailabilityConfidence, evaluateFreshness } from "../../src/domain";

const source = catalogSource(BUNDLED_CATALOG_SYSTEMS.find(s => s.system_id === "gira_lisbon")!);
const time = "2026-10-07T20:00:00.000Z";
const station = (id = 1, values: Record<string, unknown> = {}) => ({
  readTime: time,
  document: {
    name: `projects/vaimoorotterdam/databases/(default)/documents/docking-stations/${id}`,
    updateTime: "2026-09-01T00:00:00Z",
    fields: {
      DockingStationId: { integerValue: String(id) }, Name: { stringValue: "Lisboa station" },
      Tenant: { stringValue: "P1/EML/EML/" }, Location: { geoPointValue: { latitude: 38.74, longitude: -9.14 } },
      AvailableBikes: { integerValue: "5" }, FreeDocks: { integerValue: "7" }, DockLimit: { integerValue: "16" },
      IsVirtual: { booleanValue: false }, IsActive: { booleanValue: true },
      ServiceStatus: { stringValue: "AVAILABLE" }, ...values,
    },
  },
});
const client = (data: unknown, now = time) => createStationFeedClient(source, {
  now: () => new Date(now), fetcher: async () => Response.json(data),
});

describe("GIRA public station adapter", () => {
  it("issues one bounded tenant query without credentials and preserves the source snapshot clock", async () => {
    let calls = 0;
    const feed = createStationFeedClient(source, { now: () => new Date("2026-10-07T20:10:00Z"),
      fetcher: async (url, init) => {
        calls++;
        expect(String(url)).toBe(GIRA_QUERY_URL);
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("if-none-match")).toBe(false);
        expect(headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual({ structuredQuery: {
          from: [{ collectionId: "docking-stations" }],
          where: { fieldFilter: { field: { fieldPath: "Tenant" }, op: "EQUAL", value: { stringValue: "P1/EML/EML/" } } },
          limit: 1001,
        } });
        return Response.json([station()]);
      },
    });
    const result = await feed.fetchStationBundle();
    expect(calls).toBe(1);
    expect(result.stations[0]?.capacity).toBe(16);
    expect(result.statuses[0]).toMatchObject({ station_last_reported: null, observed_at: time,
      availability: { bikes_available: 5, docks_available: 7, vehicle_type_counts: {}, confidence: "medium" } });
    expect(result.observations[1]?.provider_last_updated).toBe(time);
    expect(result.warnings.map(w => w.code)).toContain("SOURCE_TIMESTAMP_MISSING");
    expect(result.state.station_status?.document).toEqual([station()]);
    const second = await feed.fetchStationBundle(result.state);
    expect(second.observations[1]?.provider_last_updated).toBe(time);
  });

  it("keeps closed/full/unknown separate and uses FreeDocks rather than capacity minus bikes", async () => {
    const result = await client([
      station(1, { IsActive: { booleanValue: false } }),
      station(2, { ServiceStatus: { stringValue: "UNAVAILABLE_BY_OPERATOR" } }),
      station(3, { ServiceStatus: { stringValue: "UNAVAILABLE_BY_SYSTEM" } }),
      station(4, { FreeDocks: { integerValue: "0" } }),
      station(5, { ServiceStatus: { stringValue: "NEW_UNKNOWN_STATE" } }),
      station(6, { FreeDocks: { integerValue: "-2" } }),
      station(7, { FreeDocks: { integerValue: "17" } }),
      station(8, { IsVirtual: { booleanValue: true } }),
      station(4552, { Name: { stringValue: "999 - Oficina" } }),
    ]).fetchStationBundle();
    expect(result.statuses.map(s => s.availability.is_returning)).toEqual([true, false, false, true, null, true, true]);
    const map = liveMapSnapshot({ ...result, fetched_at: time, expires_at: time, ttl_seconds: 60,
      age_seconds: 0, stale: false, cache_status: "fresh", snapshot_slot: "current",
      source_observations: { station_status: result.observations[1]! },
    }, Date.parse(time));
    expect(map.stations.map(s => s[3])).toEqual([7, 0, 0, 0, null, null, null]);
    expect(map.stations.every(s => s[4] === Date.parse(time) / 1000)).toBe(true);
  });

  it.each([
    [], [{ readTime: time }], { error: "unavailable" },
    [{ ...station(), readTime: undefined }], [{ ...station(), readTime: "2026-10-08T00:00:00Z" }],
    [station(1, { Tenant: { stringValue: "another-operator" } })],
    [{ ...station(), error: { status: "PERMISSION_DENIED" } }],
    [{ ...station(), skippedResults: 1 }],
    Array.from({ length: 1001 }, (_, i) => station(i)),
  ])("rejects incomplete, oversized, wrong-tenant, or undated snapshots (%#)", async data => {
    await expect(client(data).fetchStationBundle()).rejects.toThrow();
  });

  it("ignores malformed and duplicate stations with a warning", async () => {
    const result = await client([station(), station(), station(2, { Location: { geoPointValue: { latitude: 100, longitude: -9 } } })]).fetchStationBundle();
    expect(result.stations).toHaveLength(1);
    expect(result.warnings.map(w => w.code)).toContain("PARTIAL_RESULTS");
  });

  it.each(["medium", "low", "unavailable"] as const)("does not promote source confidence %s for a fresh query", sourceConfidence => {
    expect(determineAvailabilityConfidence({ sourceConfidence, hasUsableStatus: true,
      relevantCountKnown: true, operationalFlagsKnown: true,
      freshness: evaluateFreshness({ providerLastUpdated: time, stationLastReported: null,
        fetchedAt: time, ttlSeconds: 60, maxStalenessSeconds: 180, now: time }),
    })).toBe(sourceConfidence);
  });

  it("never follows a POST redirect or accepts a configurable Firestore destination", async () => {
    let calls = 0;
    await expect(createStationFeedClient(source, { fetcher: async () => {
      calls++;
      return new Response(null, { status: 307, headers: { location: GIRA_QUERY_URL + "/other" } });
    } }).fetchStationBundle()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(() => createStationFeedClient({ ...source, discoveryUrl: GIRA_QUERY_URL + "/other" })).toThrow();
  });
});
