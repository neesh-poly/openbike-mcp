import { BUNDLED_CATALOG_SYSTEMS } from "../src/catalog/seed";
import { createStationFeedClient } from "../src/feeds/client";
import { catalogSource } from "../src/feeds/source";
import { haversineDistanceMeters, joinStationsWithStatus, evaluateFreshness, isOperationalForMode } from "../src/domain";

// Explicit IDs also permit auditing a disabled candidate before promotion.
const ids = new Set(process.argv.slice(2));
const systems = BUNDLED_CATALOG_SYSTEMS.filter(s => ids.size ? ids.has(s.system_id) : s.enabled);
if (!systems.length) throw new Error("No matching systems");
const results: unknown[] = [];
let failed = false;
for (const system of systems) {
  try {
    const bundle = await createStationFeedClient(catalogSource(system)).fetchStationBundle();
    const observation = bundle.observations.find(o => o.feed_name === "station_status")!;
    const joined = joinStationsWithStatus(bundle.stations, bundle.statuses);
    const nearby = joined.stations.filter(row => row.status &&
      haversineDistanceMeters(system.coverage.centroid!, row.station) <= 5_000);
    const available = (mode: "take" | "return") => nearby.filter(row => {
      const availability = row.status!.availability;
      const count = mode === "take" ? availability.bikes_available : availability.docks_available;
      return isOperationalForMode(availability, mode) && count !== null && count > 0 &&
        evaluateFreshness({ providerLastUpdated: observation.provider_last_updated,
          stationLastReported: row.status!.station_last_reported, fetchedAt: observation.fetched_at,
          ttlSeconds: observation.ttl_seconds ?? 60, maxStalenessSeconds: 180 }).within_max_staleness;
    }).length;
    const take = available("take");
    const returns = available("return");
    const ok = take > 0 && returns > 0;
    failed ||= !ok;
    const result = { city: system.city, system_id: system.system_id, ok,
      stations: bundle.stations.length, statuses: bundle.statuses.length,
      nearby_pickups: take, nearby_returns: returns,
      warnings: [...new Set([...bundle.warnings, ...joined.warnings].map(w => w.code))] };
    results.push(result);
    console.error(`${ok ? "PASS" : "FAIL"} ${system.city}: ${take} pickups, ${returns} returns within 180 seconds`);
  } catch (error) {
    failed = true;
    results.push({ city: system.city, system_id: system.system_id, ok: false, error: String(error) });
    console.error(`FAIL ${system.city}: ${error}`);
  }
}
console.log(JSON.stringify({ ok: !failed, checked_at: new Date().toISOString(), results }, null, 2));
if (failed) process.exitCode = 1;
