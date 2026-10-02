import { describe, expect, it } from "vitest";
import { BUNDLED_CATALOG, findCatalogSystems } from "../../src/catalog";
import { createStationFeedClient } from "../../src/feeds/client";
import { catalogSource } from "../../src/feeds/source";
import { evaluateFreshness, joinStationsWithStatus } from "../../src/domain";
import { normalizeStationStatuses } from "../../src/gbfs/normalize";
import type { GbfsSystemSource } from "../../src/gbfs/types";

const time = "2026-10-02T12:00:00.000Z";
const epoch = Date.parse(time) / 1000;
const source: GbfsSystemSource = {
  systemId: "test", discoveryUrl: "https://feed.example.test/gbfs.json",
  reviewedHosts: [{ hostname: "feed.example.test" }], name: "Reviewed display name",
};
const gbfsDocuments = (version?: string) => ({
  gbfs: { ...(version ? { version } : {}), lastUpdatedOther: epoch, last_updated: epoch, ttl: 60,
    data: { en: { feeds: ["system_information", "station_information", "station_status"].map(name =>
      ({ name, url: `https://feed.example.test/${name}.json` })) } } },
  system_information: { ...(version ? { version } : {}), lastUpdatedOther: epoch, data: { name: "Upstream internal ID", timezone: "Europe/Paris", language: "en" } },
  station_information: { ...(version ? { version } : {}), lastUpdatedOther: epoch,
    data: { stations: [{ station_id: 123, name: "Test station", lat: 48.85, lon: 2.35, capacity: 20 }] } },
  station_status: { ...(version ? { version } : {}), lastUpdatedOther: epoch, ttl: 60,
    data: { stations: [{ station_id: 123, num_bikes_available: 7, num_docks_available: 11,
      is_installed: 1, is_renting: 1, is_returning: 1, last_reported: epoch - 3600,
      num_bikes_available_types: [{ mechanical: 3 }, { ebike: 4 }] }] } },
});

describe("city configuration and feed adapters", () => {
  it.each(BUNDLED_CATALOG.systems.filter(system => system.enabled))("finds $city by name and geography", system => {
    const city = system.city!.normalize("NFD").replace(/\p{M}/gu, "");
    expect(findCatalogSystems(BUNDLED_CATALOG, { query: city }).map(x => x.system.system_id)).toContain(system.system_id);
    expect(findCatalogSystems(BUNDLED_CATALOG, { ...system.coverage.centroid!, radiusMeters: 1000 })
      .map(x => x.system.system_id)).toContain(system.system_id);
    expect(catalogSource(system).discoveryUrl).toBe(system.discovery_url);
  });

  it("does not let BIXI's placeholder coordinate expand coverage to other continents", () => {
    expect(findCatalogSystems(BUNDLED_CATALOG, { latitude: 0, longitude: 0 })).toEqual([]);
    expect(findCatalogSystems(BUNDLED_CATALOG, { latitude: 40.7128, longitude: -74.006 })
      .map(x => x.system.system_id)).toEqual(["lyft_nyc"]);
  });

  it.each(["1.0", "1.1"])("normalizes the complete GBFS %s path", async version => {
    const docs = gbfsDocuments(version);
    const client = createStationFeedClient(source, { now: () => new Date(time), fetcher: async input => {
      const key = new URL(String(input)).pathname.slice(1).replace(".json", "") as keyof typeof docs;
      return Response.json(docs[key]);
    } });
    const bundle = await client.fetchStationBundle();
    expect(bundle.system.name).toBe(source.name);
    expect(bundle.system.detected_version).toBe(version);
    expect(bundle.system.capabilities.ebike).toBe(true);
    expect(joinStationsWithStatus(bundle.stations, bundle.statuses).warnings).toEqual([]);
    expect(bundle.statuses[0]?.availability).toMatchObject({ bikes_available: 7, docks_available: 11,
      vehicle_type_counts: { bike: 3, ebike: 4 } });
  });

  it("adapts Vélib envelopes without refreshing old station clocks or modifying cached raw documents", async () => {
    const docs = gbfsDocuments();
    let revalidate = false;
    const client = createStationFeedClient({ ...source, format: "velib" }, {
      now: () => new Date(time), fetcher: async (input, init) => {
        if (revalidate) {
          expect(new Headers(init?.headers).get("if-none-match")).toBe('"feed-v1"');
          return new Response(null, { status: 304 });
        }
        const key = new URL(String(input)).pathname.slice(1).replace(".json", "") as keyof typeof docs;
        return Response.json(docs[key], { headers: { etag: '"feed-v1"' } });
      },
    });
    const first = await client.fetchStationBundle();
    expect(first.discovery.version).toBe("1.0");
    expect(first.state.station_status?.document).toEqual(docs.station_status);
    expect(first.observations.find(o => o.feed_name === "station_status")?.provider_last_updated).toBe(time);
    const freshness = evaluateFreshness({ providerLastUpdated: time,
      stationLastReported: first.statuses[0]!.station_last_reported, fetchedAt: time,
      ttlSeconds: 60, maxStalenessSeconds: 180, now: time });
    expect(freshness.freshness.age_seconds).toBe(3600);
    expect(freshness.within_max_staleness).toBe(false);
    revalidate = true;
    const second = await client.fetchStationBundle(first.state);
    expect(second.statuses).toEqual(first.statuses);
    expect(second.state.station_status?.document).toEqual(docs.station_status);
  });

  it("keeps untyped Tokyo availability unknown instead of inventing e-bike counts", () => {
    const result = normalizeStationStatuses({ version: "2.3", last_updated: epoch, data: { stations: [{
      station_id: "tokyo-1", num_bikes_available: 8, num_docks_available: 2,
      is_installed: true, is_renting: true, is_returning: true, last_reported: epoch,
    }] } }, { systemId: "tokyo", discoveryUrl: source.discoveryUrl, detectedVersion: "2.3", fetchedAt: time });
    expect(result.value[0]?.availability).toMatchObject({ bikes_available: 8, vehicle_type_counts: {} });
  });

  it("does not count scooters as bikes in GBFS 3 vehicle totals", () => {
    const result = normalizeStationStatuses({ version: "3.0", last_updated: time, data: { stations: [{
      station_id: "mixed", num_vehicles_available: 10, num_docks_available: 2,
      vehicle_types_available: [{ vehicle_type_id: "b", count: 3 }, { vehicle_type_id: "s", count: 7 }],
      is_installed: true, is_renting: true, is_returning: true, last_reported: time,
    }] } }, { systemId: "mixed", discoveryUrl: source.discoveryUrl, detectedVersion: "3.0", fetchedAt: time,
      vehicleTypes: ["b", "s"].map(id => ({ system_id: "mixed", vehicle_type_id: id,
        category: id === "b" ? "ebike" : "scooter", form_factor: null, propulsion_type: null, max_range_meters: null })) });
    expect(result.value[0]?.availability.bikes_available).toBe(3);
    expect(result.value[0]?.availability.vehicle_type_counts).toEqual({ ebike: 3, scooter: 7 });
  });
});

const tflPoint = (overrides: Record<string, string> = {}) => ({
  id: "BikePoints_1", commonName: "River Street", lat: 51.529163, lon: -0.10997,
  additionalProperties: Object.entries({ Installed: "true", Locked: "false", NbBikes: "9",
    NbDocks: "30", NbEmptyDocks: "17", NbStandardBikes: "6", NbEBikes: "3", ...overrides })
    .map(([key, value]) => ({ key, value, modified: time })),
});

describe("TfL BikePoint adapter", () => {
  const tflSource = { ...source, format: "tfl" as const, discoveryUrl: "https://feed.example.test/BikePoint" };
  it("fetches one bounded resource and retains per-station timestamps through revalidation", async () => {
    let calls = 0;
    const client = createStationFeedClient(tflSource, { now: () => new Date("2026-10-02T12:10:00Z"),
      fetcher: async (_input, init) => {
        calls++;
        if (calls === 1) return Response.json([tflPoint()], { headers: { etag: '"tfl"' } });
        expect(new Headers(init?.headers).get("if-none-match")).toBe('"tfl"');
        return new Response(null, { status: 304 });
      } });
    const bundle = await client.fetchStationBundle();
    expect(calls).toBe(1);
    expect(bundle.system.detected_version).toBe("TfL-BikePoint");
    expect(bundle.stations[0]?.capacity).toBe(30);
    expect(bundle.statuses[0]).toMatchObject({ station_last_reported: time,
      availability: { bikes_available: 9, docks_available: 17, vehicle_type_counts: { bike: 6, ebike: 3 },
        is_installed: true, is_renting: true, is_returning: true } });
    expect((await client.fetchStationBundle(bundle.state)).statuses).toEqual(bundle.statuses);
    expect(calls).toBe(2);
  });

  it("preserves unknown counts, disabled stations, and malformed-record warnings", async () => {
    const bundle = await createStationFeedClient(tflSource, { fetcher: async () => Response.json([
      tflPoint({ NbBikes: "", NbEBikes: "-1", NbEmptyDocks: "unknown", Locked: "true" }),
      { id: "bad", lat: 999 },
    ]) }).fetchStationBundle();
    expect(bundle.stations).toHaveLength(1);
    expect(bundle.statuses[0]?.availability).toMatchObject({ bikes_available: null, docks_available: null,
      vehicle_type_counts: { bike: 6 }, is_renting: false, is_returning: false });
    expect(bundle.statuses[0]?.availability.vehicle_type_counts.ebike).toBeUndefined();
    expect(bundle.warnings.map(w => w.code)).toContain("PARTIAL_RESULTS");
  });

  it("rejects invalid responses and redirects to unreviewed hosts", async () => {
    await expect(createStationFeedClient(tflSource, { fetcher: async () => Response.json({ error: "unavailable" }) })
      .fetchStationBundle()).rejects.toThrow("BikePoint list");
    await expect(createStationFeedClient(tflSource, { fetcher: async () => new Response(null, {
      status: 302, headers: { location: "https://unreviewed.example.test/data" },
    }) }).fetchStationBundle()).rejects.toThrow();
  });
});
