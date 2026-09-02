# Open Bikeshare MCP

[![CI](https://github.com/neesh-poly/openbike-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/neesh-poly/openbike-mcp/actions/workflows/ci.yml)

An open-source, read-only Model Context Protocol server for live bikeshare discovery and station availability. It normalizes heterogeneous General Bikeshare Feed Specification (GBFS) feeds so agents can answer questions such as “Can I return a bike near here?” with distance, operational state, and explicit freshness.

The implementation is release-candidate complete for a four-system production canary. The Cloudflare service is not live until the paid Workers plan is activated and the staging and production smoke gates pass. Worldwide public beta remains a later milestone: MobilityData catalog rows are indexed only as disabled candidates until each provider passes the documented admission gate.

- Planned MCP endpoint: `https://mcp.openbike.neesh.page/mcp`
- Planned service health: `https://mcp.openbike.neesh.page/healthz`
- Planned readiness: `https://mcp.openbike.neesh.page/readyz`
- Planned provider summary: `https://mcp.openbike.neesh.page/status`

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

The first deployment requires an authenticated Wrangler session or a narrowly scoped Cloudflare API token. Do not commit deployment tokens. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [the rollback runbook](docs/runbooks/rollback.md), and [cost controls](docs/operations/cost-controls.md).

## Release scope

The first production canary enables four manually reviewed systems: Citi Bike (New York), Mobi (Vancouver), Oslo Bysykkel, and WienMobil Rad (Vienna). The catalog Workflow may stage additional MobilityData rows as disabled candidates, but disabled systems are never probed, matched to coordinates, or returned by MCP tools. See [docs/SUPPORTED_SYSTEMS.md](docs/SUPPORTED_SYSTEMS.md) for the promotion checklist and the remaining worldwide-coverage gates.

## Product requirements

- [Canonical Markdown PRD](docs/Open_Bikeshare_MCP_PRD.md)
- [Generated review DOCX](docs/Open_Bikeshare_MCP_PRD_Cloudflare_v1.2.docx)
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
