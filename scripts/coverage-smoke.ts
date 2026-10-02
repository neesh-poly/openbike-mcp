import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { FindSystemsOutputSchema, GetNearbyAvailabilityOutputSchema, GetStationOutputSchema } from "../src/contracts";

const endpoint = new URL(process.argv[2] ?? "https://mcp.openbike.neesh.page/mcp");
const targets = [
  { id: "lyft_bay", city: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { id: "bluebikes", city: "Boston", latitude: 42.3601, longitude: -71.0589 },
  { id: "lyft_chi", city: "Chicago", latitude: 41.8781, longitude: -87.6298 },
];
const client = new Client({ name: "openbike-coverage-smoke", version: "0.1.0" });
const summaries: unknown[] = [];
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 30_000 });
  const all = FindSystemsOutputSchema.parse(await call("find_systems", { limit: 100 }));
  for (const { id, city, latitude, longitude } of targets) {
    assert(all.results.some(s => s.system_id === id), `${city} is not enabled`);
    const located = FindSystemsOutputSchema.parse(await call("find_systems", { latitude, longitude, radius_km: 5 }));
    assert(located.results.some(s => s.system_id === id), `${city} did not match coordinates`);
    const modes: unknown[] = [];
    for (const mode of ["take", "return"] as const) {
      const result = GetNearbyAvailabilityOutputSchema.parse(await call("get_nearby_availability", {
        latitude, longitude, mode, radius_meters: 3000, limit: 3,
        max_staleness_seconds: 600,
        ...(mode === "take" ? { vehicle_types: ["bike", "ebike"] } : {}),
      }));
      assert.equal(result.systems_failed.length, 0, `${city}: upstream failure`);
      assert(result.results.length > 0, `${city}: no usable ${mode} results`);
      for (const row of result.results) {
        assert.equal(row.station.system_id, id);
        assert(row.freshness.age_seconds <= 600);
        assert.equal(row.availability.is_installed, true);
        assert.equal(mode === "take" ? row.availability.is_renting : row.availability.is_returning, true);
        const count = mode === "take"
          ? (row.availability.vehicle_type_counts.bike ?? 0) + (row.availability.vehicle_type_counts.ebike ?? 0)
          : row.availability.docks_available;
        assert(count !== null && count > 0);
      }
      const first = result.results[0]!;
      if (mode === "take") {
        const station = GetStationOutputSchema.parse(await call("get_station", { system_id: id, station_id: first.station.station_id }));
        assert.equal(station.station.station_id, first.station.station_id);
        assert(station.availability);
      }
      modes.push({ mode, count: result.results.length, station: first.station.name, availability: first.availability,
        freshness: first.freshness, warnings: result.warnings.map(w => w.code) });
    }
    summaries.push({ city, system_id: id, modes });
  }
  console.log(JSON.stringify({ ok: true, endpoint: endpoint.toString(), enabled_systems: all.results.length, summaries }, null, 2));
} finally {
  await client.close();
}
