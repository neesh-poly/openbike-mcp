# Open Bikeshare MCP

[![CI](https://github.com/neesh-poly/openbike-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/neesh-poly/openbike-mcp/actions/workflows/ci.yml)

An open-source, read-only Model Context Protocol server for live bikeshare discovery and station availability. It normalizes General Bikeshare Feed Specification (GBFS 1.x–3.x) feeds, TfL BikePoint, and GIRA station data so agents can answer questions such as “Can I return a bike near here?” with distance, operational state, and explicit freshness.

OpenBike runs on Cloudflare with **19 enabled cities**: New York City, Vancouver, Oslo, Vienna, San Francisco, Boston, Chicago, Washington, DC, Toronto, Montréal, Austin, Berlin, Madrid, Barcelona, Tokyo, Philadelphia, Los Angeles, London, Lisbon. Paris and Portland have adapters and reviewed configuration but remain disabled while their station timestamps fail the live freshness gate. The catalog also retains other public feeds as disabled candidates; inclusion in that index does not imply active coverage.

- MCP endpoint: `https://mcp.openbike.neesh.page/mcp`
- Service health: `https://mcp.openbike.neesh.page/healthz`
- Readiness: `https://mcp.openbike.neesh.page/readyz`
- Catalog and probe-cycle status: `https://mcp.openbike.neesh.page/status`

During the initial canary, the endpoint is unauthenticated, rate limited, and intentionally accepts no arbitrary feed URLs.

## Tools

| Tool | Purpose |
|---|---|
| `get_nearby_availability` | Rank nearby stations for taking or returning a bike. |
| `find_stations` | Search station metadata, optionally with live status. |
| `get_station` | Get one namespaced station and current status. |
| `find_systems` | Discover indexed systems by coordinates, country, capability, or text. |
| `get_system_health` | Inspect safe feed and degradation diagnostics for one system. |

See [docs/API.md](docs/API.md) for inputs, semantics, errors, and example MCP configuration.

## Website map feed

`GET /map-docks/{systemId}/snapshot` returns version 2 station tuples: `[id, longitude, latitude, openSpaces, observedUnixSeconds]`. Zero means full or closed; null means unknown. Original station/provider/fetch clocks bound the observation time and never become newer merely because a client fetched again. Empty or unavailable inventories return an error rather than an all-full city. The legacy `/map-docks/{systemId}` contract remains available.

The website paints its first map directly from HTML and uses responsive static images. It polls only the visible city's snapshot every 15 seconds after a three-second dwell, pauses when hidden or idle for two minutes, backs off on errors, and retains known observations without changing their timestamps. `GET /map-docks/{systemId}/events` now returns 204 to stop legacy SSE reconnects. Neither change alters the MCP tools' freshness contract.

Map snapshots use a shared 15-second revalidation interval and keep a last-known cache for up to 24 hours. An expired cache returns immediately while the Durable Object refreshes in the background. Production warms the 19 enabled systems every two minutes with concurrency two. Snapshot payloads are stored in bounded SQLite chunks, preserving the previous good version transactionally; old row-based snapshots are read and migrated on their next successful refresh.

A persisted global allowance limits public map cache refresh work to 25,000 per UTC day and 500,000 per UTC month, including scheduled warming and the legacy map endpoint. Each allowed refresh spends one unit; Workers do not reserve batches that can be lost when an isolate exits. Cache hits do not spend this allowance. Exhaustion serves retained edge or Durable Object data without fetching the provider, or returns 503 with Retry-After when no eligible snapshot exists. Original observation timestamps remain intact. This is an application limit, **not an account billing cap**: incoming Worker requests, MCP traffic, and other account resources can still be billed. The Worker CPU limit is 2 seconds per invocation; production logs and traces sample 1%. No paid integration was added.

**Rollback:** versions before the chunk-storage migration cannot read migrated station rows. Keep the chunk reader when reverting other changes, or roll forward with a fix; do not blindly roll the Worker back across this migration. Provider data can be refreshed again, but an old binary would not preserve the cached fallback.


## Architecture

The service runs on Cloudflare Workers using the current stateless Streamable HTTP MCP handler. One SQLite-backed `SystemFeed` Durable Object per system owns coherent live snapshots, conditional-request metadata, refresh single-flight, and circuit state. Immutable catalog and status versions live in R2, with only current pointers and reviewed overrides in KV. A scheduled Workflow publishes catalog versions and Queue consumers run bounded, idempotent probes with a dead-letter queue.

Vercel Functions plus managed Redis remains the measured fallback if the Worker platform-fit gate fails. Vercel AI Gateway is not used because the request path performs deterministic data retrieval and does not invoke a model.

## Development

Requirements: Node.js 22.18+ and pnpm 11.24.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dev
```

The local MCP URL is printed by Wrangler. Cloudflare bindings are emulated locally; live provider requests remain restricted to the reviewed catalog.

## Deployment

Staging and production use separate KV, R2, Queue, Workflow, Durable Object, Analytics Engine, and rate-limit bindings. Production owns `mcp.openbike.neesh.page`; staging uses its `workers.dev` hostname.

```sh
pnpm deploy:staging
pnpm deploy:production
```

Deployments require an authenticated Wrangler session or a narrowly scoped Cloudflare API token. Do not commit deployment tokens. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [the rollback runbook](docs/runbooks/rollback.md), and [cost controls](docs/operations/cost-controls.md).

## Release scope

The active cities and pending providers are listed in [SUPPORTED_SYSTEMS.md](docs/SUPPORTED_SYSTEMS.md). [City expansion evidence](docs/operations/2026-10-global-expansion.md) records feed checks and limitations. Disabled systems are not probed, coordinate-matched, or returned by MCP tools.

City configuration has one source of truth in `src/catalog/seed.ts`. Standard feeds share the GBFS normalizer; small adapters in `src/feeds/` handle alternate formats. See [extending city coverage](docs/FEED_ADAPTERS.md).

## Product requirements

- [Canonical Markdown PRD](docs/Open_Bikeshare_MCP_PRD.md)
- [Generated review DOCX](docs/Open_Bikeshare_MCP_PRD_Cloudflare_v1.3.docx)
- [Cloudflare-first ADR](docs/decisions/0001-cloudflare-first-hosting.md)
- [Original DOCX reference](docs/reference/Open_Bikeshare_MCP_PRD_original.docx)

Do not hand-edit the generated DOCX. Update the Markdown source and run the documented Python builder so the decision history remains diffable.

```sh
python3 -m pip install -r requirements.txt
python3 tools/build_prd.py
python3 tools/check_prd.py
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for adapter and fixture rules. Report security issues privately using [SECURITY.md](SECURITY.md). This project is available under the [MIT License](LICENSE); upstream GBFS data remains subject to each provider’s terms and attribution requirements.
