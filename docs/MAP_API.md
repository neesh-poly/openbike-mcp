# Open-dock map snapshots

`GET /map-docks/{system_id}` provides compact, anonymous map points for enabled bundled systems. It uses the same catalog, Durable Object snapshots, provider adapters, and freshness rules as the MCP. It does not accept arbitrary feed URLs or visitor locations. `HEAD` and CORS `OPTIONS` are supported.

```json
{"system_id":"lyft_nyc","generated_at":"2026-10-02T22:00:00.000Z","fetched_at":"2026-10-02T21:59:45.000Z","max_age_seconds":180,"docks":[[-73.99,40.72,12,1790978490]]}
```

Each tuple is `[longitude, latitude, available_spaces, valid_until_unix_seconds]`. Points are included only when the station is installed, accepts returns, has a known positive number of spaces, and has a sufficiently recent provider observation. A missing station observation falls back to the provider's station-status timestamp, never an invented fetch timestamp. Expiry is bounded by both provider time and fetch time. Timestamps implausibly beyond fetch time are excluded.

The endpoint covers the whole bikeshare system. The website clips points to its city map boundary. It must discard tuples after their individual expiry: a point can expire while a 30-second response remains in cache.

Responses use `Cache-Control: public, max-age=30, s-maxage=30`. The Cloudflare edge cache is keyed by origin and pathname; query strings do not generate variants. `X-OpenBike-Cache` reports HIT/MISS. Cache misses use the existing per-IP HTTP limiter and existing shared feed snapshots. CORS allows anonymous GET from any origin, without credentials. Browser clients should bound concurrent warmup requests and refresh no more frequently than the cache lifetime.

Unknown/disabled systems return 404. Feed failure returns 503 with `AVAILABILITY_UNAVAILABLE`, no-store and Retry-After 30; it does not fabricate an empty successful result. Rate limits return 429. A station budget bounds response work. MCP transport and tool output remain unchanged.

Validation: `pnpm test`, both Wrangler dry-run builds, and `pnpm exec tsx scripts/map-smoke.ts https://openbike-mcp-staging.ilios.workers.dev`. The smoke script checks all 18 enabled systems, current source timestamps, numeric point data, CORS, and repeat-request cache behavior.
