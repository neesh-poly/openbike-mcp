import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { FindSystemsOutputSchema, GetNearbyAvailabilityOutputSchema, GetStationOutputSchema } from "../src/contracts";
import { BUNDLED_CATALOG_SYSTEMS } from "../src/catalog/seed";

const endpoint = new URL(process.argv[2] ?? "https://mcp.openbike.neesh.page/mcp");
const selectedIds = new Set(process.argv.slice(3));
const targets = BUNDLED_CATALOG_SYSTEMS.filter(system => system.enabled &&
  (selectedIds.size === 0 || selectedIds.has(system.system_id)));
assert(targets.length > 0, "No enabled systems selected");
const client = new Client({ name: "openbike-coverage-smoke", version: "0.1.0" });
const summaries: unknown[] = [];
const failures: unknown[] = [];

async function call(name: string, args: Record<string, unknown>) {
  // Stay below the public 60/minute limit even when every city is selected.
  await setTimeout(1_200);
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 30_000 });
  const all = FindSystemsOutputSchema.parse(await call("find_systems", { limit: 100 }));
  for (const system of targets) {
    const id = system.system_id;
    const { latitude, longitude } = system.coverage.centroid!;
    try {
      assert(all.results.some(s => s.system_id === id), `${system.city} is not enabled`);
      for (const query of [{ query: system.city! }, { latitude, longitude, radius_km: 5 }]) {
        const found = FindSystemsOutputSchema.parse(await call("find_systems", query));
        assert(found.results.some(s => s.system_id === id), `${system.city} did not match ${JSON.stringify(query)}`);
      }
      const modes: unknown[] = [];
      for (const mode of ["take", "return"] as const) {
        const result = GetNearbyAvailabilityOutputSchema.parse(await call("get_nearby_availability", {
          latitude, longitude, mode, radius_meters: 5_000, limit: 3, system_ids: [id],
          max_staleness_seconds: 180,
        }));
        assert.equal(result.systems_failed.length, 0, `${system.city}: upstream failure`);
        assert(result.results.length > 0, `${system.city}: no usable ${mode} results`);
        for (const row of result.results) {
          assert.equal(row.station.system_id, id);
          assert(row.freshness.age_seconds <= 180);
          assert.equal(row.availability.is_installed, true);
          assert.equal(mode === "take" ? row.availability.is_renting : row.availability.is_returning, true);
          const count = mode === "take" ? row.availability.bikes_available : row.availability.docks_available;
          assert(count !== null && count > 0);
        }
        const first = result.results[0]!;
        if (mode === "take") {
          const station = GetStationOutputSchema.parse(await call("get_station", { system_id: id, station_id: first.station.station_id }));
          assert.equal(station.station.station_id, first.station.station_id);
          assert(station.availability);
          const category = first.availability.vehicle_type_counts.ebike ? "ebike"
            : first.availability.vehicle_type_counts.bike ? "bike" : undefined;
          if (category) {
            const typed = GetNearbyAvailabilityOutputSchema.parse(await call("get_nearby_availability", {
              latitude, longitude, mode, radius_meters: 5_000, limit: 3, system_ids: [id],
              vehicle_types: [category], max_staleness_seconds: 180,
            }));
            assert(typed.results.length > 0, `${system.city}: no ${category} result`);
            assert(typed.results.every(row => (row.availability.vehicle_type_counts[category] ?? 0) > 0));
          }
        }
        modes.push({ mode, count: result.results.length, station: first.station.name,
          availability: first.availability, freshness: first.freshness,
          warnings: result.warnings.map(w => w.code) });
      }
      summaries.push({ city: system.city, system_id: id, modes });
      console.error(`PASS ${system.city}`);
    } catch (error) {
      failures.push({ city: system.city, system_id: id, error: String(error) });
      console.error(`FAIL ${system.city}: ${error}`);
    }
  }
  console.log(JSON.stringify({ ok: failures.length === 0, endpoint: endpoint.toString(),
    enabled_systems: all.results.length, summaries, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await client.close();
}
