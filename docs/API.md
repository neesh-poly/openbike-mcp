# MCP API

The live production Streamable HTTP endpoint is `https://mcp.openbike.neesh.page/mcp`. It is stateless: clients initialize, list tools, and call tools normally, but the server does not retain protocol sessions between requests.

Send one JSON-RPC request per HTTP POST. Top-level JSON-RPC batches are intentionally rejected so one rate-limit unit cannot fan out into many provider operations.

## Client configuration

Clients that accept a remote HTTP MCP URL can use:

```json
{
  "mcpServers": {
    "openbike": {
      "url": "https://mcp.openbike.neesh.page/mcp"
    }
  }
}
```

No API key is required during the initial canary. Requests are rate limited, and clients should cache discovery answers briefly and respect retryable errors.

## `get_nearby_availability`

Required: `latitude`, `longitude`, and `mode` (`take`, `return`, or `either`). Optional defaults: `radius_meters=800`, `limit=5`, `minimum_available=1`, `include_unavailable=false`, and `max_staleness_seconds=300`. `system_ids` and station-level `vehicle_types` may narrow the query.

Take mode ranks compatible available bikes and then distance. Return mode ranks live docks and then distance. Either mode ranks operational stations primarily by distance. A missing count remains `null`, never zero. Station capacity is not substituted for live docks.

## `find_stations`

Required: `latitude` and `longitude`. Optional: `radius_meters` up to 10,000, `system_ids`, diacritic-insensitive `query`, `include_status`, `operational_only`, `limit` up to 100, and an opaque continuation `cursor`.

## `get_station`

Required: `system_id` and provider-scoped `station_id`. Optional `include_status` and `include_raw_links` default to true. Station IDs are always namespaced by system.

## `find_systems`

Coordinates must be supplied together. Optional filters include `radius_km`, `query`, ISO alpha-2 `country_code`, capability (`docked`, `dockless`, `ebike`, or `station_status`), and `limit`. Coverage confidence distinguishes station bounds from weaker catalog metadata; sharing a city name alone is not claimed as exact coverage.

## `get_system_health`

Requires `system_id`. Returns only safe diagnostics: discovery URL, detected version, required-feed presence, fetch/provider timestamps, validation state, recent success rate, capability flags, and degradation. It never returns stack traces, Cloudflare identifiers, secrets, or raw upstream bodies.

## Freshness and partial success

Each live result includes provider and retrieval timestamps, age, TTL, and `is_stale`. Data beyond provider TTL may be returned with a warning only while it remains inside the caller’s maximum staleness. Multi-system calls return successful systems plus stable warnings for failed systems whenever a partial answer is possible.

Stable error codes are `INVALID_ARGUMENT`, `NOT_FOUND`, `NO_SYSTEM_COVERAGE`, `NO_RESULTS`, `SYSTEM_UNAVAILABLE`, `STALE_DATA`, `UNSUPPORTED_FEED`, `RATE_LIMITED`, and `INTERNAL_ERROR`.

Every successful tool call returns the same bounded JSON object in both `structuredContent` and a JSON `TextContent` block so modern and content-only MCP clients receive equivalent data.
