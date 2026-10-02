import { describe, expect, it } from "vitest";
import {
  citiLikeStationInformationV23,
  citiLikeStationStatusV23,
  citiLikeSystemInformationV23,
  citiLikeVehicleTypesV23,
} from "../../fixtures";
import { BUNDLED_CATALOG, findCatalogSystems } from "../../src/catalog";
import { compatibleBikesAvailable, joinStationsWithStatus } from "../../src/domain";
import { GbfsClient, INITIAL_GBFS_SYSTEMS } from "../../src/gbfs";

// Synthetic fixtures modeled on the public GBFS 2.3 feeds reviewed 2026-10-02.
// Policy/source evidence: docs/operations/2026-10-city-expansion.md.
const cities = [
  { id: "lyft_bay", code: "bay", city: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { id: "bluebikes", code: "bos", city: "Boston", latitude: 42.3601, longitude: -71.0589 },
  { id: "lyft_chi", code: "chi", city: "Chicago", latitude: 41.8781, longitude: -87.6298 },
];

describe("reviewed US city feeds", () => {
  it.each(cities)("discovers $city by name and location", ({ id, city, latitude, longitude }) => {
    expect(findCatalogSystems(BUNDLED_CATALOG, { query: city }).map(x => x.system.system_id)).toEqual([id]);
    expect(findCatalogSystems(BUNDLED_CATALOG, { latitude, longitude, radiusMeters: 1000 }).map(x => x.system.system_id)).toEqual([id]);
  });

  it.each(cities)("loads and joins $city through its reviewed cross-host feeds", async ({ id, code }) => {
    const source = INITIAL_GBFS_SYSTEMS.find(s => s.systemId === id)!;
    const feedNames = ["system_information", "station_information", "station_status", "vehicle_types", "free_bike_status"];
    const discovery = { version: "2.3", last_updated: 1788263100, ttl: 60, data: { en: { feeds:
      feedNames.map(name => ({ name, url: `https://gbfs.lyft.com/gbfs/2.3/${code}/en/${name}.json` })),
    } } };
    // Boston advertises lyft_bos upstream while the directory's stable ID is bluebikes.
    const system = { ...citiLikeSystemInformationV23, data: { ...citiLikeSystemInformationV23.data, system_id: `lyft_${code}` } };
    const vehicles = { ...citiLikeVehicleTypesV23, data: { vehicle_types: [
      ...citiLikeVehicleTypesV23.data.vehicle_types,
      { vehicle_type_id: "scooter", form_factor: "scooter", propulsion_type: "electric" },
    ] } };
    const statuses = { ...citiLikeStationStatusV23, data: { stations: citiLikeStationStatusV23.data.stations.map(s => ({
      ...s,
      vehicle_types_available: [...s.vehicle_types_available, { vehicle_type_id: "scooter", count: 4 }],
    })) } };
    const documents = new Map<string, unknown>([
      ["system_information", system], ["station_information", citiLikeStationInformationV23],
      ["station_status", statuses], ["vehicle_types", vehicles],
    ]);
    const requested: string[] = [];
    const bundle = await new GbfsClient(source, { fetcher: async input => {
      const url = new URL(input.toString());
      requested.push(url.toString());
      if (url.toString() === source.discoveryUrl) return Response.json(discovery);
      expect(url.hostname).toBe("gbfs.lyft.com");
      const name = url.pathname.split("/").at(-1)!.replace(".json", "");
      expect(documents.has(name)).toBe(true);
      return Response.json(documents.get(name));
    } }).fetchStationBundle();
    expect(requested).toHaveLength(5);
    expect(bundle.system.system_id).toBe(id);
    const joined = joinStationsWithStatus(bundle.stations, bundle.statuses);
    expect(joined.warnings).toEqual([]);
    expect(joined.stations.every(s => s.station.system_id === id && s.status?.system_id === id)).toBe(true);
    const availability = joined.stations[0]!.status!.availability;
    expect(availability.vehicle_type_counts).toEqual({ bike: 6, ebike: 3, scooter: 4 });
    expect(compatibleBikesAvailable(availability, ["bike", "ebike"])).toBe(9);
    expect(availability.docks_available).toBe(21);
  });
});
