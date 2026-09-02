# ADR 0001: Cloudflare-first hosting

- Status: Accepted for the V1 production canary, subject to deployed platform-fit evidence before private alpha
- Date: 2026-09-01
- Governing specification: `../Open_Bikeshare_MCP_PRD.md`

## Context

Open Bikeshare MCP needs a globally reachable, read-only Streamable HTTP MCP endpoint over heterogeneous public GBFS feeds. The hard parts are provider isolation, coherent near-real-time caching, burst collapse, bounded fan-out, safe outbound fetching, and inexpensive scheduled health work. The service does not call a language model in V1.

## Decision

Use Cloudflare Workers Paid as the default public runtime, with these boundaries:

- Keep `/mcp` stateless and create a fresh MCP server per request.
- Address one SQLite-backed `SystemFeed` Durable Object by normalized system ID. It owns that provider's validated snapshot, HTTP validators, single-flight refresh, breaker state, and last-known-good data.
- Publish immutable catalog snapshots to R2. Store only the current catalog pointer and reviewed overrides in KV; KV is not authoritative for live availability.
- Use a scheduled Workflow to validate and publish catalogs, then enqueue idempotent per-system probe messages. Process probes with bounded Queue consumers, retries, and a dead-letter queue.
- Export privacy-safe logs and traces through OpenTelemetry, and write service/cache/provider metrics to Analytics Engine.
- Apply WAF and permissive edge rate limits before execution, then cost-aware Worker-side limits. Do not describe location-local edge counters as exact global quotas.
- Allow only reviewed public HTTPS GBFS destinations and enforce redirect, DNS, byte, record-count, and time budgets. Evaluate Workers VPC/Gateway egress during the security spike if independent network enforcement is required.
- Do not add Redis or a request-path database to the Cloudflare V1 design.

## Rationale

The design maps the coordination unit to the product's natural boundary: one bikeshare system. Durable Objects provide serialization and colocated persistent state without turning an MCP protocol session into infrastructure state. Workers, R2, KV, Workflows, and Queues cover the request path and background work in one deployment model, while retaining a portable domain layer.

Vercel AI Gateway is not selected because it routes and observes model calls; it neither hosts this deterministic MCP data service nor solves its feed-cache coordination problem.

## Consequences and gate

The implementation must remain inside the Workers isolate memory and pending-connection envelope, so candidate systems, provider fetches, response bytes, normalization memory, and total request time are explicitly capped. V1 caps each serialized normalized SystemFeed snapshot at 4 MiB and fans out to at most four systems, bounding the serialized aggregate to 16 MiB before object overhead and response shaping. Before private alpha, replay the largest supported recorded feeds under concurrency and require:

- peak isolate memory below 80 MB;
- no application path waiting on more than four configured concurrent operations;
- warm p95 below two seconds and cold p95 below five seconds for the supported fixture set; and
- concurrent misses for one system/feed collapsing to one upstream refresh.

If the workload still fails after reducing buffering, duplicate object graphs, fan-out, and response size without weakening product requirements, switch as one deliberate architecture move to Vercel Functions plus a managed Redis-compatible cache. Do not operate a hybrid V1 by accident.
