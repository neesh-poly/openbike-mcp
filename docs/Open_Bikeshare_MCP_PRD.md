---
document_label: PRODUCT REQUIREMENTS DOCUMENT
title: Open Bikeshare MCP
subtitle: An open-source MCP server for normalized real-time bikeshare discovery and availability
status: Production canary live with four reviewed systems; private-alpha and public-beta gates remain open
owner: Kanishq0106@gmail.com
target: Live Cloudflare Workers production canary at mcp.openbike.neesh.page; private alpha, then gated worldwide public beta
version: 1.3
last_updated: September 2, 2026
decision_summary: Build a stateless, read-only MCP service on Cloudflare Workers. Use a per-system Durable Object for coherent live GBFS caching and refresh coalescing, versioned R2/KV catalog data, scheduled Workflows and Queues for provider probes, and Workers-native security and telemetry. Retain a Vercel Functions plus managed Redis fallback only if measured Worker memory or connection limits fail the documented platform-fit gates.
---

# 1. Executive Summary

Bikeshare availability is published across hundreds of independent systems. Most systems expose General Bikeshare Feed Specification (GBFS) feeds, but consumers still need to discover the correct provider, follow version-specific discovery documents, combine station metadata with live status, interpret dock and vehicle types, handle stale or malformed feeds, and calculate proximity. Those details are a poor fit for repeated ad hoc agent reasoning.

Open Bikeshare MCP centralizes that work. An MCP client supplies a coordinate, place-derived coordinate, system ID, station ID, and optional filters. The service resolves relevant GBFS systems, fetches and validates the minimum required feeds, joins static station metadata to near-real-time status, normalizes the result, and returns concise structured data suitable for both model reasoning and direct UI rendering.

**Current release status.** The four-system production canary is live at `https://mcp.openbike.neesh.page/mcp` on Cloudflare Workers Paid and has passed staging and production smoke validation. The September 2, 2026 launch catalog contained 1,524 systems: four reviewed systems were enabled and 1,520 were disabled candidates. The catalog/probe pipeline is live and `/status` reported a completed 4/4 launch probe cycle; disabled candidates are not probed, coordinate-matched, or returned until individually reviewed and promoted. This release does not claim worldwide coverage or private-alpha/public-beta readiness.

V1 runs as one Cloudflare Workers project with a stateless Streamable HTTP MCP endpoint. A globally deployed request Worker performs protocol handling, validation, system discovery, and result composition. One SQLite-backed Durable Object per bikeshare system owns fresh feed state, conditional-request metadata, refresh single-flight, and provider circuit state. A scheduled Workflow publishes catalog versions and Queues fan out idempotent system probes. This is one modular TypeScript codebase and one platform project, without Redis or a request-path database.

The hosting choice is conditional on measured fit. Before private alpha, the implementation must prove that the largest supported feeds remain comfortably below the 128 MB Worker isolate limit and that cold multi-system queries meet the five-second request budget while respecting Cloudflare's six pending outbound-connection limit. If either gate fails after bounded optimization, the approved fallback is Vercel Functions with managed Redis. Vercel AI Gateway is not part of V1 because the service does not invoke language models.

## 1.1 Product principles

- Answer the user's real decision: whether they can take or return a bike nearby now, not merely whether a station exists.
- Prefer a small composable tool surface. Default tools should complete common questions in one call; diagnostic tools remain available for deeper inspection.
- Never hide freshness or feed limitations. Every live response includes source timestamps, retrieval time, staleness, and relevant warnings.
- Normalize common concepts without pretending all systems are identical. Preserve provider-specific ambiguity and expose validated raw-source links.
- Remain public-data-only and read-only. No accounts, rentals, unlocks, reservations, payments, or user tracking.
- Keep the product contract portable even though Cloudflare is the explicit V1 deployment decision.

## 1.2 V1 platform decision

| Decision | V1 choice | Rationale |
|---|---|---|
| Public compute | Cloudflare Workers Paid | Global HTTPS execution, automatic scaling, first-party MCP handler, custom domain/TLS, and low paid baseline. |
| MCP transport | Stateless `createMcpHandler()` at `/mcp` | Current Streamable HTTP path; V1 has no MCP protocol session state. |
| Fresh shared state | One `SystemFeed` Durable Object per `system_id` | Globally unique coordination boundary for live cache, single-flight refresh, ETags, and circuit state. |
| Catalog publication | Immutable R2 snapshots plus KV current-version pointer and reviewed overrides | Catalog writes are infrequent; immutable versions make rollback and audit straightforward. |
| Background work | Scheduled Workflow to publish; Queue to fan out probes | Durable steps, retries, bounded concurrency, and dead-letter handling. |
| Custom metrics | Workers Analytics Engine | OpenTelemetry export currently covers logs and traces, not custom metrics. |
| V1 database | None in the request path | Durable Object SQLite covers per-system state; R2/KV cover the catalog. Add D1 or Postgres only when control-plane editing or analytics require it. |
| AI gateway | None | No model call exists in the core request path. |

## 1.3 Implementation and release status

| Area | Current evidence | Remaining release gate |
|---|---|---|
| MCP and GBFS core | Five stateless Streamable HTTP tools, GBFS 2.x/3.x normalization, bounded fetches, coherent per-system snapshots, partial failure, and freshness semantics are implemented. Modern-auto and legacy-2025 client smokes passed all five tools in staging and production. | Expand the independent-client and live-city evidence matrix before private alpha. |
| Active coverage | Four manually reviewed systems are enabled: Citi Bike, Mobi, Oslo Bysykkel, and WienMobil Rad. The launch probe cycle completed 4/4 with three healthy, one degraded, and zero unavailable. | Observe stability over time before expanding the canary. |
| Catalog expansion | Production published 1,524 systems from the September 2, 2026 source audit: four enabled reviewed systems and 1,520 inert candidates. Authenticated, unsafe, malformed, and duplicate-ID rows fail closed. | Review discovery and subfeed hosts, terms, fixtures, capabilities, and geographic coverage per provider before promotion. |
| Cloudflare resources | Workers Paid is active. Isolated staging/production KV, R2, Queues, dead-letter queues, Workflows, Durable Objects, metrics, rate limits, WAF, and the custom domain are deployed; DNS/TLS and the launch probe pipeline passed live validation. | Complete the rollback rehearsal and capture sustained cost and telemetry evidence. |
| Platform fit | The deterministic 6,000-station local workerd benchmark stays within the 4 MiB snapshot bound and coalesces 1/10/100 cold misses. The launch machine measured production p95 of 69.7 ms for health, 26.9 ms for readiness, and 581 ms for warm `find_systems`. | Capture deployed Worker CPU, isolate-memory, multi-region, and cold-path evidence; local or single-origin measurements are not substitutes. |
| Release designation | Live four-system production canary, before private alpha. | Private alpha requires the Phase 1 system range and client evidence; public beta additionally requires at least 90% reachable enabled coverage, the availability observation window, security review completion, and all Phase 2 exit criteria. |

# 2. Problem and Opportunity

## 2.1 User problem

A user asking "Are there open docks near this restaurant?" implicitly requires geocoding, system discovery, station search, a static/live feed join, distance ranking, operational-status filtering, and freshness interpretation. Today, every MCP client or agent must independently implement these steps, often with brittle provider-specific code.

## 2.2 Why now

GBFS is specifically intended to provide current shared-mobility status and real-time travel advice. Its ecosystem offers a common discovery and data model across docked and dockless services, while MCP provides a standard interface for agents to invoke remote tools. A thin hosted normalization layer can therefore offer broad geographic coverage without negotiating proprietary operator integrations.

Cloudflare's current platform closes several operational gaps that would otherwise require third-party infrastructure: stateless MCP handling, globally unique Durable Object coordination, scheduled Workflows, Queues with retries and dead-letter queues, custom domains, edge abuse controls, and direct OpenTelemetry log/trace export.

## 2.3 Target users

| Persona | Need | Primary job |
|---|---|---|
| MCP end user | Fast, trustworthy answer | Find a bike or return slot near a destination now. |
| Agent/app developer | One integration across systems | Add bikeshare context without implementing GBFS. |
| Open-data builder | Reusable normalized service | Prototype maps, assistants, automations, or accessibility tools. |
| Maintainer | Observable provider fleet | Identify broken, stale, or incompatible feeds. |

# 3. Goals, Non-goals, and Success Metrics

## 3.1 Goals for V1

- Publicly host an MCP endpoint using Streamable HTTP and publish an open-source implementation.
- Discover systems worldwide using the MobilityData GBFS catalog plus curated overrides.
- Return nearby stations with live bikes, docks, vehicle-type breakdowns when available, distance, status, and freshness.
- Support GBFS 2.x and 3.x through explicit adapters and a stable internal schema.
- Fail partially and transparently when a provider is degraded instead of inventing or silently serving old data.
- Provide sufficient observability and test fixtures for community maintenance.
- Operate on Cloudflare without Redis while preserving coherent per-system status snapshots, per-feed refresh single-flight, and bounded catalog-scale probe fan-out.
- Keep the architecture portable enough to move the request handler and cache boundary if platform-fit gates fail.

## 3.2 Non-goals for V1

- Trip routing, travel-time prediction, navigation, or multimodal itinerary planning.
- Renting, unlocking, reserving, returning, paying for, or authenticating with a bikeshare operator.
- Guaranteed coverage of proprietary, undocumented, login-gated, or license-incompatible feeds.
- Historical utilization analytics, demand forecasting, rebalancing recommendations, or station outage prediction.
- A consumer map application. A small documentation/demo page is allowed but is not the product surface.
- Street-address geocoding inside the core service. Clients should pass coordinates in V1; optional geocoding may follow.
- Model inference, model routing, prompt management, or use of Vercel AI Gateway or Cloudflare AI Gateway.
- A cross-provider relational database in the request path.

## 3.3 Success metrics

| Metric | Beta target | Measurement |
|---|---|---|
| Coverage | At least 90% of cataloged, reachable GBFS systems indexed | Daily catalog/probe Workflow. |
| Correctness | At least 99% fixture conformance; zero known bike/dock inversion defects | Contract and golden tests. |
| Freshness | At least 95% of successful live responses within provider TTL or five minutes | Analytics Engine response events. |
| Warm latency | p50 under 500 ms; p95 under 2.0 s for warm nearby queries | Workers traces and synthetic checks. |
| Cold budget | 95% of supported cold multi-system queries finish within five seconds | Traces segmented by cache outcome. |
| Availability | 99.5% monthly for the MCP service, excluding upstream feed failures | Independent synthetic checks. |
| Tool efficiency | At least 80% of common user questions satisfied with one tool call | Sampled traces and product evals. |
| Cache coalescing | No more than one upstream refresh per system/feed during a concurrent miss window | Durable Object instrumentation and load tests. |
| Worker fit | Peak measured isolate memory below 80 MB in the defined largest-feed concurrency test | Workers memory profiling and repeatable benchmark. |

# 4. User Stories and Core Journeys

## 4.1 Primary user stories

- As a rider, I want to know whether I can return a bike within a short walk of a destination right now.
- As a rider, I want to find nearby conventional bikes or e-bikes that are actually rentable.
- As a traveler, I want the same query to work across cities without knowing the local operator or feed URL.
- As an agent developer, I want compact JSON with stable fields and clear warnings so I can render or reason over it.
- As a maintainer, I want to inspect system and feed health when a user reports an incorrect answer.
- As an operator of the public service, I want one provider's traffic or failure to remain isolated from other systems.

## 4.2 Canonical return-a-bike flow

1. Client geocodes the user's destination or already has latitude/longitude.
2. Client calls `get_nearby_availability` with `mode=return`, `radius_meters`, and optional system hint.
3. The Worker validates the tool request, applies an edge/client budget, and resolves candidate systems from the versioned geographic index.
4. The Worker selects at most the configured candidate-system cap and calls the corresponding `SystemFeed` Durable Objects.
5. Each Durable Object returns a coherent cached snapshot or performs one bounded, single-flight refresh using conditional GBFS requests.
6. The Worker removes non-installed or non-returning stations by default, ranks remaining stations by distance, and returns dock counts plus freshness.
7. The agent answers with the nearest viable choices and explicitly notes stale data, capacity ambiguity, or upstream failure.

# 5. MCP Tool Surface

V1 exposes five public tools. The first three serve user-facing tasks; the final two support discovery and diagnostics. All tool names use `snake_case`, all coordinates use WGS84 decimal degrees, all distances are meters, and timestamps are RFC 3339 strings.

| Tool | Purpose | Typical use |
|---|---|---|
| `get_nearby_availability` | One-call answer for bikes or return capacity near a point | "Can I park near Bottega?" |
| `find_stations` | Search station metadata and optionally attach live status | "Which stations are within 800 m?" |
| `get_station` | Fetch one normalized station and current status | Follow-up or refresh. |
| `find_systems` | Discover bikeshare systems by point, country, or text | Unknown city/operator. |
| `get_system_health` | Inspect feed versions, timestamps, errors, and capability flags | Diagnostics and monitoring. |

## 5.1 Tool: get_nearby_availability

Primary high-level tool. It should be sufficient for the dominant "take" and "return" questions without forcing the client to orchestrate system discovery and station joins.

### Input schema

| Field | Type | Req. | Rules / default |
|---|---|---|---|
| `latitude` | number | Yes | -90 through 90. |
| `longitude` | number | Yes | -180 through 180. |
| `mode` | enum | Yes | `take`, `return`, or `either`. |
| `radius_meters` | integer | No | Default 800; range 50 through 5,000. |
| `limit` | integer | No | Default 5; range 1 through 25. |
| `system_ids` | string array | No | Restrict search to known normalized IDs. |
| `vehicle_types` | string array | No | `bike`, `ebike`, `cargo_bike`, `scooter`, `other`. |
| `minimum_available` | integer | No | Default 1; minimum viable bikes or docks. |
| `include_unavailable` | boolean | No | Default false. |
| `max_staleness_seconds` | integer | No | Default 300; mark or exclude older status. |

### Output contract

- `query`: normalized coordinates, mode, radius, filters, and server interpretation.
- `systems_considered`: normalized IDs and names; `systems_failed`: ID plus safe error code.
- `results[]`: system, station, coordinates, `distance_meters`, availability, operational flags, capacity, vehicle-type counts, source timestamps, freshness, and rental deep links when supplied.
- `availability`: `bikes_available`, `docks_available`, `vehicle_type_counts`, `is_renting`, `is_returning`, `is_installed`, and `confidence`.
- `freshness`: `provider_last_updated`, `station_last_reported` when present, `fetched_at`, `age_seconds`, `ttl_seconds`, and `is_stale`.
- `warnings[]`: stable code, human-readable message, `system_id`, `station_id` when applicable, and retryable boolean.

### Semantics

- `mode=take` ranks operational stations meeting `minimum_available` by compatible bikes available, then distance.
- `mode=return` ranks stations that allow returns and meet `minimum_available` by compatible docks available, then distance.
- `mode=either` returns both measures and ranks primarily by distance among operational stations.
- A null count means unknown, not zero. Stations with unknown dock count are excluded from return-mode viable results unless `include_unavailable=true`.
- Physical capacity is informational and must not substitute for live docks available.
- Provider station IDs are namespaced by `system_id`; no station ID is assumed globally unique.

## 5.2 Tool: find_stations

Lower-level station search for map population, broader inspection, and client-controlled ranking.

| Input | Type | Behavior |
|---|---|---|
| `latitude` / `longitude` | number | Required search center. |
| `radius_meters` | integer | Default 1,000; maximum 10,000. |
| `system_ids` | string array | Optional restriction. |
| `query` | string | Optional case/diacritic-insensitive station-name filter. |
| `include_status` | boolean | Default true. |
| `operational_only` | boolean | Default true. |
| `limit` / `cursor` | integer / string | Maximum 100; opaque continuation cursor. |

Returns normalized station records sorted by distance, a `next_cursor` when applicable, `systems_considered`, retrieval metadata, and warnings. Pagination is implemented by this service even though upstream GBFS files are not paginated.

## 5.3 Tool: get_station

| Input | Type | Behavior |
|---|---|---|
| `system_id` | string | Required normalized system ID. |
| `station_id` | string | Required provider-scoped ID. |
| `include_status` | boolean | Default true. |
| `include_raw_links` | boolean | Default true; links only, never unbounded raw payloads. |

Returns station metadata, current availability, supported rental methods/deep links when present, feed attribution, and freshness. `NOT_FOUND` and `SYSTEM_UNAVAILABLE` are distinct errors.

## 5.4 Tool: find_systems

| Input | Type | Behavior |
|---|---|---|
| `latitude` / `longitude` | number | Optional point; use both or neither. |
| `radius_km` | number | Default 50 when coordinates are supplied. |
| `query` | string | Optional name/operator/city search. |
| `country_code` | string | Optional ISO 3166-1 alpha-2 filter. |
| `capability` | enum | Optional `docked`, `dockless`, `ebike`, or `station_status`. |
| `limit` | integer | Default 20; maximum 100. |

Returns system ID, display name, operator, city/region/country, feed URL, detected GBFS version, capability summary, service-area confidence, and last successful probe. The service must not claim point coverage solely because a system shares the same city; coverage confidence distinguishes exact geofence, station-bounds inference, and catalog metadata.

## 5.5 Tool: get_system_health

Diagnostic tool returning discovery URL, detected version, required-feed presence, most recent successful fetch per feed, provider timestamps/TTLs, schema validation status, last error class, rolling success rate, capability flags, and current degradation state. It excludes internal stack traces, infrastructure identifiers, secrets, and unrestricted upstream response bodies.

## 5.6 Common error model

| Code | Meaning | Retryable |
|---|---|---|
| `INVALID_ARGUMENT` | Input failed schema or range validation. | No. |
| `NO_SYSTEM_COVERAGE` | No indexed system plausibly serves the area. | No. |
| `NO_RESULTS` | Systems found but no station matched filters. | Maybe. |
| `SYSTEM_UNAVAILABLE` | Candidate upstream feed could not be used. | Yes. |
| `STALE_DATA` | Only data older than requested threshold is available. | Yes. |
| `UNSUPPORTED_FEED` | Feed version/capabilities cannot satisfy query. | No. |
| `RATE_LIMITED` | Client or upstream limit reached. | Yes. |
| `INTERNAL_ERROR` | Unexpected service failure with request ID. | Yes. |

Tool-level failure is reserved for invalid requests or complete inability to answer. Multi-system queries return partial results plus warnings when at least one system succeeds.

# 6. Data Model and Normalization

## 6.1 Normalized entities

| Entity | Identity | Key fields |
|---|---|---|
| System | `system_id` | Name, operator, location, timezone, feed URL/version, languages, license, capabilities. |
| Station | `system_id + station_id` | Name, latitude/longitude, capacity, station type, rental methods, vehicle docks, region. |
| StationStatus | `system_id + station_id + observed_time` | Vehicle/dock counts, type counts, renting/returning/installed, `last_reported`. |
| VehicleType | `system_id + vehicle_type_id` | Normalized category, propulsion, form factor, range when supplied. |
| FeedObservation | `system_id + feed_name + fetch_time` | HTTP status, ETag, provider timestamp, TTL, validation outcome, content hash. |
| Warning | `request + stable_code` | Scope, message, source, retryability. |

## 6.2 GBFS version handling

- Implement one adapter per supported major-version family and normalize into a version-independent domain model.
- Discover feed URLs through `gbfs.json`; support provider `manifest.json` where available; never hardcode standard filenames as URLs.
- Treat `station_information` as relatively static and `station_status` as near-real-time. Join only within the same system namespace.
- Map v2 `free_bike_status` and v3 `vehicle_status` into a common dockless-vehicle model, but keep individual vehicle locations out of default tools for privacy and payload control.
- Ignore unknown extension fields by default, record them in validation telemetry, and promote them only through reviewed adapters.
- Current supported inputs are maintained GBFS 2.x and 3.x feeds. Capability-gated additions must not destabilize the stable schema.

## 6.3 Availability confidence

| Value | Condition | Client interpretation |
|---|---|---|
| high | Live feed valid, within TTL/threshold, required operational flags known. | Suitable for direct answer. |
| medium | Counts valid but one relevant optional field missing, or slightly beyond provider TTL. | Answer with caveat. |
| low | Stale status accepted by policy or provider semantics ambiguous. | Do not present as definitive. |
| unavailable | No usable status. | Return diagnostic warning, not inferred counts. |

# 7. Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Index cataloged GBFS systems and apply reviewed feed overrides without code deployment. | P0 |
| FR-02 | Resolve candidate systems from coordinates using geofences when present, otherwise station bounds plus a conservative buffer. | P0 |
| FR-03 | Fetch discovery, system, station, vehicle-type, and status feeds with per-feed cache policies. | P0 |
| FR-04 | Validate JSON, version, required fields, coordinate ranges, timestamps, IDs, and non-negative counts. | P0 |
| FR-05 | Join static and live station data, retaining orphan/missing-record warnings. | P0 |
| FR-06 | Calculate great-circle distance and rank results deterministically. | P0 |
| FR-07 | Filter by operational state, minimum availability, normalized vehicle type, system, and staleness. | P0 |
| FR-08 | Expose source attribution and freshness metadata in every live result. | P0 |
| FR-09 | Return partial success across providers and stable safe errors. | P0 |
| FR-10 | Support conditional upstream requests with ETag/If-None-Match and bounded retries. | P1 |
| FR-11 | Expose health diagnostics and a public service status endpoint outside MCP. | P1 |
| FR-12 | Allow community-contributed fixtures, system metadata corrections, and adapter tests. | P1 |
| FR-13 | Route each system's live read through a deterministic per-system coordination boundary that globally collapses concurrent misses. | P0 |
| FR-14 | Bound candidate systems, pending connections, decompressed response bytes, normalization memory, and total request time. | P0 |
| FR-15 | Publish immutable catalog versions and preserve the last validated snapshot when refresh fails. | P0 |
| FR-16 | Process provider probes idempotently with retry and dead-letter behavior. | P1 |

# 8. Engineering Architecture

## 8.1 Recommended V1 architecture

Use one Cloudflare Workers project and one modular TypeScript codebase. The platform contains multiple Cloudflare primitives, but the product remains a modular monolith with shared domain types, tests, fixtures, and deployment configuration.

```text
MCP client
  -> Cloudflare WAF and edge rate limit
  -> API Worker on mcp.openbike.neesh.page
       /mcp -> stateless createMcpHandler
       /healthz /readyz /status
       -> KV current catalog pointer and reviewed overrides
       -> R2 immutable catalog snapshot
       -> in-isolate geographic index
       -> up to 3-4 SystemFeed Durable Objects
            -> in-memory hot snapshot and in-flight Promise
            -> SQLite-backed normalized feed state, ETags, TTLs, breaker
            -> allowlisted GBFS HTTPS endpoints

Scheduled CatalogRefreshWorkflow
  -> validate and publish immutable catalog version
  -> enqueue one idempotent probe message per system
  -> bounded Queue consumers
  -> SystemFeed.probe()
  -> materialized public status summary
  -> dead-letter queue after exhausted retries

Workers Logs and Traces -> OpenTelemetry destination
Analytics Engine -> latency, cache, provider, and coverage metrics
```

## 8.2 Component map

| Component | Responsibility | Cloudflare-first implementation |
|---|---|---|
| MCP transport | Handle initialize/list/call negotiation and serialize responses without protocol session storage. | `createMcpHandler()` from `agents/mcp/server`; Streamable HTTP at `/mcp`; explicit allowed hostnames and current transport mode. |
| Tool handlers | Validate inputs, enforce budgets, and compose domain services. | Zod/JSON Schema plus typed handlers; no business logic in transport layer. |
| System index | Catalog, overrides, and geospatial candidate lookup. | Immutable R2 catalog version; KV pointer/overrides; in-isolate R-tree keyed by catalog version. |
| SystemFeed Durable Object | Own coherent live state and provider coordination per system. | One SQLite-backed object addressed by normalized `system_id`; location hint near provider on first creation. |
| GBFS client | Discovery, HTTPS fetch, conditional requests, validation, and bounded streaming. | Workers Fetch API with AbortSignal deadlines, `redirect: manual`, byte caps, and v2/v3 adapters. |
| Normalizer | Map version/provider data to stable entities. | Pure typed functions with recorded golden fixtures. |
| Query engine | Join, filter, distance, ranking, and warnings. | Stateless domain module in the request Worker. |
| Catalog refresh | Fetch, validate, diff, and atomically publish catalog versions. | Directly scheduled Workflow with retryable steps; preserve previous valid pointer on failure. |
| Probe worker | Refresh system capability and non-sensitive health data. | Queue consumer with low `max_concurrency`, retries, idempotency, and DLQ. |
| Observability | Logs, traces, metrics, request IDs, and SLO evidence. | Workers Logs/Traces plus OTel export; Analytics Engine custom metrics; external synthetics. |

The MCP handler creates a fresh `McpServer` from its factory for each request. Configure `route: "/mcp"`, `responseMode: "auto"`, explicit production `allowedHostnames`, and an explicit browser-origin policy. Set `legacy: "reject"` only after the two required beta clients pass the current stateless transport suite. Pin the exact MCP package versions required by the selected Cloudflare Agents release; as reviewed for this revision, the stateless path uses `@modelcontextprotocol/server` v2.

## 8.3 SystemFeed Durable Object contract

Each normalized `system_id` maps to one globally unique `SystemFeed` Durable Object. It is the unit of cache coherence and provider isolation, not an MCP session.

The object stores:

- Latest validated normalized `station_information`, `station_status`, required discovery metadata, and a last-known-good snapshot.
- ETag, Last-Modified, provider timestamps, fetch timestamps, TTL, validation version, and content hash per feed.
- Consecutive failure count, breaker state, retry-after deadline, and last safe error classification.
- An ephemeral in-memory snapshot while hot and an in-memory `Map<feedKey, Promise>` that collapses simultaneous refreshes.

The object exposes typed RPC methods such as `getAvailability(query)`, `getStation(stationId)`, `getHealth()`, and `probe()`. Important state is persisted because in-memory state disappears after eviction or deployment. Network fetches must not be wrapped in a long `blockConcurrencyWhile()` section; the explicit in-flight Promise is the refresh lock.

## 8.4 Request lifecycle

1. Accept the MCP request over HTTPS, validate protocol and tool input, assign a request ID and cost budget, and apply an edge/client rate check.
2. Load the current catalog version pointer; reuse the parsed in-isolate geographic index when its version matches.
3. Resolve candidate systems from explicit IDs or the geographic index and cap the candidate set before any provider work.
4. Obtain deterministic Durable Object stubs by `system_id`, using a provider-region location hint only on first creation.
5. Call no more than the configured system-concurrency cap with `Promise.allSettled` and a total deadline.
6. Each Durable Object serves a fresh snapshot or performs one bounded conditional refresh. Stale-while-revalidate is allowed only where the cache policy explicitly permits it.
7. Validate and normalize each provider independently; isolate failure and preserve last-known-good data with explicit freshness metadata.
8. Join station records, compute distances, apply filters, rank, and cap results.
9. Return bounded `structuredContent` plus matching JSON `TextContent` for content-only client compatibility, including source metadata and warnings.
10. Emit privacy-safe traces, logs, and metrics; never log full prompts, exact coordinates, or unbounded provider payloads.

## 8.5 Cache and storage policy

| Data | Authority / storage | Default policy | Stale behavior |
|---|---|---|---|
| Catalog snapshot | Immutable R2 object | Publish daily after validation. | Retain previous validated version; warn only if older than seven days. |
| Catalog pointer / reviewed overrides | Workers KV | Infrequent versioned writes; Worker isolate caches parsed version. | Eventual propagation is acceptable; never mutate a large live object in place. |
| Discovery/system info | SystemFeed DO SQLite | Six to 24 hours; honor HTTP validators. | Serve stale up to seven days for metadata with warning. |
| Station information | SystemFeed DO SQLite and hot memory | 15 minutes or provider TTL when greater. | Serve stale up to 24 hours with warning. |
| Station/vehicle status | SystemFeed DO SQLite and hot memory | Provider TTL; otherwise 30-60 seconds. | Never silently serve beyond `max_staleness_seconds`. |
| Negative/error state | SystemFeed DO SQLite and hot memory | 10-60 seconds by error class. | Prevent thundering herds and expose retryable warning. |
| Raw/versioned diagnostic fixture | R2, bounded and access controlled | Store only when explicitly enabled for debugging/fixtures. | Never expose unbounded raw payloads through public tools. |

Workers KV is not the authority for live availability because its reads are eventually consistent and a change can remain invisible in another location for 60 seconds or more. The Cache API may be used as an opportunistic local optimization but is not the shared beta cache. No Redis service is required for V1.

## 8.6 Catalog refresh and provider probes

`CatalogRefreshWorkflow` runs on a direct cron schedule. Its steps fetch the upstream catalog, apply reviewed overrides, validate system records and URL policy, build geographic artifacts, compare coverage against the previous version, write an immutable R2 snapshot, and update the KV current-version pointer only after validation passes.

After publication, the Workflow enqueues one small message per system. Queue delivery is at least once, so messages include a deterministic catalog version and system ID and all consumers are idempotent. Consumers use deliberately bounded `max_concurrency`, retry transient failures with delay, and send exhausted messages to a dead-letter queue. A single scheduled invocation must never `Promise.all()` the entire worldwide catalog.

`/status` reads a materialized non-sensitive summary for the current probe cycle. The coordinator publishes the initial `probing` state and the terminal `complete` state; intermediate progress remains in coordinator storage rather than repeatedly writing the shared KV pointer. It does not synchronously fan out to every system.

## 8.7 Project layout

```text
src/index.ts                    Worker fetch handler and public routes
src/mcp/server.ts               createMcpHandler factory and five tools
src/domain/                     stable entities, normalization, query engine
src/gbfs/client.ts              bounded discovery and feed retrieval
src/gbfs/normalize.ts           GBFS 2.x/3.x normalization adapters
src/security/fetch-json.ts      redirect, DNS, byte and time policy
src/security/url-policy.ts      reviewed-host and public-network policy
src/catalog/                    R2/KV catalog loading and geographic index
src/durable/system-feed.ts      SystemFeed Durable Object
src/workflows/catalog-refresh.ts scheduled publication workflow
src/queues/probe-consumer.ts    idempotent provider probe consumer
src/observability/              privacy-safe traces, logs and metrics
fixtures/                       recorded representative provider responses
tests/                          unit, contract, integration, security and load tests
wrangler.jsonc                  bindings, routes, limits, queues and schedules
```

## 8.8 Hosting and deployment model

- The request handler is deployed globally on Workers Paid with automatic scaling; do not model it as one region with horizontal replicas.
- The production Worker uses `https://mcp.openbike.neesh.page`; Cloudflare manages its DNS record and certificate.
- Keep `/mcp`, `/healthz`, `/readyz`, and `/status` on the same Worker project.
- Staging and production use separate R2, KV, Queue, Durable Object namespace, Analytics Engine, and rate-limit bindings.
- The public GBFS path requires no provider secrets. Deployment/API tokens and telemetry credentials are platform secrets, never normal environment variables committed to the repository.
- Use version metadata and gradual deployment/rollback. A code rollback must not invalidate persisted Durable Object data; schema migrations require forward/backward compatibility.
- Start with default nearest-ingress Worker execution. Do not enable Smart Placement until traces show it improves upstream latency.
- Apply a best-effort location hint when a system's Durable Object is first created, choosing the broad region nearest the provider rather than the first arbitrary user. Durable Objects do not automatically relocate later.

## 8.9 Platform constraints and application budgets

| Constraint | Published platform envelope | V1 application rule |
|---|---|---|
| Worker memory | 128 MB per isolate, shared by concurrent requests | Cap each serialized normalized SystemFeed snapshot at 4 MiB and request fan-out at four systems (16 MiB serialized aggregate before object overhead); stream and cap response bodies; avoid duplicate raw plus normalized copies; largest-feed load gate must remain under 80 MB peak. |
| Pending outbound connections | Six per invocation while waiting for response headers | Request Worker calls at most four system objects concurrently; each SystemFeed performs at most four provider fetches concurrently and always consumes or cancels bodies. |
| Paid subrequests | 10,000 per request | Candidate and feed caps remain far below the platform maximum. |
| CPU time | Paid default 30 seconds, configurable up to five minutes | Set an explicit lower CPU ceiling after profiling; network wall time remains governed by the five-second request budget. |
| Worker bundle | 10 MB paid limit and one-second startup budget | Keep adapters/data separate from large fixtures; fixtures live outside production bundle. |
| Queue/alarm execution | 15-minute wall-time envelope | One message performs one bounded system probe; never scan the whole catalog in one consumer. |

## 8.10 Cost posture

Workers Paid currently has a five-dollar monthly account minimum including 10 million Worker requests and 30 million CPU-milliseconds, with published request and CPU overages and no Worker data-transfer charge. Durable Objects, KV, R2, Queues, Workflows, logs/traces, and any Gateway or external observability plan have separate usage or plan economics. A slow upstream fetch can increase Durable Object active duration, so the beta replay must measure total platform usage rather than extrapolate from headline request price.

The service has a maintainer-approved operating ceiling of approximately USD 25 per month. The expected low-scale canary posture is the Workers Paid minimum plus usage-based platform primitives. A USD 10 Cloudflare budget notification is already configured, which is intentionally stricter than the ceiling but is not a hard cap. Production uses low queue concurrency, bounded feed fan-out, and sampled telemetry. At a projected USD 20 monthly run rate, pause background probes and investigate; before projected spend can exceed USD 25, disable nonessential scheduled work or the production route until the cause is understood.

The approved fallback has a higher published Vercel Pro baseline and adds a managed Redis-compatible service plus origin-transfer economics. Do not choose either platform from base subscription price alone; price the measured prototype replay against current official calculators before public beta.

# 9. Non-functional Requirements

| Area | Requirement |
|---|---|
| Performance | Warm p95 under two seconds. Upstream connection target 1.5 seconds, total per-provider budget three seconds, total request budget five seconds by default. |
| Availability | Service degrades per provider. One failing system must not fail a multi-system request. |
| Scalability | Stateless MCP handlers; sharded per-system Durable Objects; bounded candidates, feeds, pending connections, radius, results, and payload size. |
| Consistency | Counts from one response use a coherent status observation per provider; never mix incompatible snapshots without warning. |
| Memory | Largest supported feed plus concurrent normalization remains below the defined 80 MB platform-fit gate. |
| Accessibility | Text fields remain human-readable; distances and operational state are explicit rather than color-dependent. |
| Internationalization | Preserve supported languages; default language selection is deterministic; Unicode-safe names; coordinates remain WGS84. |
| Maintainability | Version adapters and provider overrides are independently testable; no business logic in transport handlers. |
| Portability | Domain, adapter, validation, and tool-contract modules do not import Cloudflare runtime APIs; platform code stays behind storage, queue, and coordination interfaces. |
| Compatibility | Advertise protocol support; use stable `structuredContent` schemas plus matching JSON `TextContent` for content-only clients, and apply semver to breaking tool changes. |

# 10. Security, Privacy, and Abuse Prevention

- No user account, payment, rental, or trip data is collected. Exact query coordinates are potentially sensitive.
- Do not persist exact coordinates in application logs. Metrics may use coarse regional/system labels; tracing attributes exclude raw coordinates and prompts.
- Accept no caller-supplied GBFS URL. Fetch only cataloged or explicitly reviewed HTTPS destinations.
- Reject URL credentials, non-HTTPS schemes, IP literals, localhost names, and disallowed ports before dispatch.
- Resolve A and AAAA records where supported and reject private, loopback, link-local, multicast, reserved, and metadata-network destinations.
- Use `redirect: manual`; validate the scheme, hostname, port, DNS result, and redirect count at every hop before following.
- Enforce strict compressed and decompressed byte caps, content-type checks, redirect count, DNS/connection/total deadlines, and JSON nesting/record-count limits.
- Enable strict-public Worker fetch behavior as defense in depth and test Cloudflare's public-destination sandbox against the security fixture suite.
- For independently enforced egress policy, evaluate the beta Workers VPC binding through Cloudflare Gateway. Gateway DNS, HTTP, and network policies can log and restrict Worker egress. If beta infrastructure is unacceptable and independent network enforcement is mandatory, use a controlled egress service rather than weakening the requirement.
- Apply a WAF rate-limiting rule before Worker execution and a Workers Rate Limiting binding for tool-cost-aware token/client limits. For anonymous V1 traffic, IP is only a lenient fallback because many users may share one address.
- Reject top-level JSON-RPC batches so a single HTTP-rate-limit unit cannot multiply provider or Durable Object work; clients send one MCP request per POST.
- Treat edge rate counters as permissive and location-local, not exact global quotas. A future paid/authenticated tier requiring exact quota accounting uses sharded Durable Objects or another strongly consistent store.
- Use the per-system Durable Object as the provider concurrency and circuit-breaker boundary. Do not use one global singleton Durable Object.
- Sanitize provider strings before model-visible output. Treat upstream text as untrusted data, never instructions.
- Return source URLs only when they are validated public HTTPS URLs. Never return internal errors, infrastructure details, bindings, or secrets.
- Publish a responsible disclosure path, dependency update policy, security headers, and abuse contact before public beta.
- Standard Workers egress does not provide a dedicated stable source IP. A provider that requires IP allowlisting needs Cloudflare dedicated egress/Gateway where available or a separate fetch tier.

# 11. Observability and Operations

## 11.1 Telemetry design

Workers automatic tracing captures the request handler and supported fetch/binding calls. Export sampled logs and traces to an OpenTelemetry-compatible destination. OpenTelemetry export does not currently include Worker infrastructure or custom application metrics, so emit service, cache, provider, and coverage metrics to Workers Analytics Engine.

Required request telemetry:

- Request count, latency, result count, error class, partial-success rate, cache status, tool name, catalog version, and Worker version.
- Per-system feed fetch count, latency, HTTP status class, validation result, provider data age, circuit state, consecutive failures, and conditional-request outcome.
- Catalog coverage, last successful publication/probe, detected GBFS version, capability changes, and feed URL changes.
- Queue delivery attempts, retries, dead-letter count, probe duration, and catalog publication outcome.
- No exact coordinates, prompts, client-provided free text, authorization material, or unbounded provider payloads in logs, traces, or metrics.

## 11.2 Public health routes

| Route | Meaning | Must not do |
|---|---|---|
| `/healthz` | Return handler/version health and a basic OK response. | Pretend to represent a long-lived process or replica. |
| `/readyz` | Verify required bindings/configuration and the current validated catalog pointer, with the reviewed bundled catalog as the first-deploy fallback. Publication owns full R2 integrity validation, so readiness remains a constant-time KV check. | Read/hash the full catalog, fan out to providers, or make readiness depend on one upstream. |
| `/status` | Return materialized aggregate provider health and last probe/publication timestamps. | Live-query the enabled provider fleet. |

## 11.3 Alerts

| Condition | Initial threshold | Response |
|---|---|---|
| Service error rate | Greater than 2% for 10 minutes | Page maintainer. |
| Warm p95 latency | Greater than three seconds for 15 minutes | Investigate cache, object routing, and upstream fan-out. |
| Coverage regression | More than 5% indexed systems lost day over day | Block catalog pointer update; inspect diff. |
| Popular provider outage | Three consecutive failed probes | Mark degraded and open issue/notify contact. |
| Stale responses | More than 10% for 15 minutes | Check Durable Object cache and provider timestamps. |
| Queue dead letters | Any sustained non-zero rate or burst above defined baseline | Inspect error class before redrive. |
| Worker memory headroom | Benchmark or production profile exceeds 80 MB gate | Block rollout; reduce buffering/concurrency or invoke fallback decision. |

# 12. Testing and Evaluation

## 12.1 Automated tests

- Unit tests for distance, ranking, null-vs-zero handling, operational filters, freshness, vehicle-type mapping, and location-hint selection.
- Golden fixtures for representative GBFS 2.x and 3.x feeds, localized fields, docked/dockless systems, malformed feeds, extensions, mixed vehicle types, and large station files.
- Contract tests for every tool input/output schema and error code using the current MCP handler.
- Integration tests with a local fake upstream covering ETag/304, timeouts, manual redirects, oversized and decompression-expanded payloads, invalid JSON, stale timestamps, missing stations, partial failures, and DNS/SSRF cases.
- Durable Object tests for eviction/restart, persisted last-known-good state, concurrent refresh single-flight, conditional requests, circuit transitions, and schema migration compatibility.
- KV/R2 catalog tests for immutable version publication, eventual pointer propagation, rollback, stale pointer handling, override validation, and coverage-regression blocking.
- Workflow/Queue tests for scheduled invocation, at-least-once delivery, idempotency, retries, delayed retry, low max concurrency, and dead-letter behavior.
- Security tests for SSRF, DNS rebinding defenses, redirect loops, prompt-like provider strings, decompression bombs, cursor tampering, rate-limit behavior, and sensitive telemetry exclusion.
- Per-location edge-rate tests proving that approximate abuse control is not misrepresented as exact global accounting.
- Gradual-deployment and version-skew tests proving that old and new Worker versions can read the active Durable Object schema during rollout and rollback.
- Live canaries against a small allowlisted provider set; canaries do not make the main test suite depend on the public internet.
- MCP interoperability tests from at least two independent clients over Streamable HTTP.

## 12.2 Cloudflare platform-fit benchmark

Before private alpha, publish a repeatable benchmark using recorded fixtures for the largest supported `station_information` and `station_status` payloads.

The benchmark must measure:

- Peak isolate memory while parsing, validating, normalizing, joining, and serializing under representative concurrent requests.
- CPU time separately from upstream/network wall time.
- Warm, cold, and stale-while-refresh latency.
- Parent Worker pending system calls and per-SystemFeed pending provider requests.
- Upstream request count during 1, 10, and 100 simultaneous cache misses for the same system.
- Failure behavior when a response exceeds compressed bytes, decompressed bytes, record count, or total deadline.

The pre-private-alpha platform-fit gate passes when peak memory is below 80 MB, no application path waits on more than the configured four concurrent operations, warm p95 is below two seconds, cold p95 is below five seconds for the supported fixture set, and concurrent misses collapse to one refresh per feed.

If it fails, first reduce buffering, duplicate object graphs, feed concurrency, candidate systems, and response size. If the measured workload still cannot pass without violating product requirements, execute the documented Vercel Functions plus managed Redis fallback rather than hiding the constraint.

## 12.3 Product eval set

Maintain a versioned set of natural-language scenarios with expected tool selection and factual assertions. Include take-vs-return intent, e-bike-only requests, no nearby coverage, zero availability, stale status, multiple overlapping systems, disabled stations, foreign-language names, and a provider outage. Evaluate whether the common question completes in one tool call and whether the final answer preserves source freshness and uncertainty.

# 13. Rollout Plan

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 - Local prototype | Citi Bike plus two to four diverse systems; local and remote MCP; one SystemFeed object. | Tool contracts stable; correct station join, freshness, and one-client flow. |
| 0.5 - Platform-fit spike | Recorded largest-feed suite, concurrency benchmark, Workers staging bindings, queue/workflow rehearsal. | Memory below 80 MB; pending-operation budgets enforced; warm/cold latency gates met; no unbounded buffering. |
| 1 - Private alpha | 20-50 systems across GBFS versions and regions; custom staging domain. | Golden suite; SSRF controls; dashboards; two-client MCP interop; p95 target met. |
| 2 - Public beta | Expand the live production canary to catalog-driven worldwide discovery while retaining the custom domain, public docs, WAF/rate limits, and status page. | At least 90% reachable coverage; 99.5% service availability; security review; queue/DLQ runbook; rollback tested. |
| 3 - Stable V1 | Compatibility policy, SLOs, maintained provider override process. | No P0/P1 correctness defects; measured one-call success at least 80%; sustained Worker fit headroom. |

## 13.1 Delivery status and next work

1. Completed for the production canary: schemas, Worker/MCP routes, GBFS adapters, `SystemFeed` Durable Objects, R2/KV catalog and geographic discovery, scheduled Workflow/Queues, materialized status, security controls, and staging/production launch.
2. Before private alpha, capture deployed CPU and isolate-memory evidence, rehearse rollback, expand the reviewed system set, and broaden independent-client coverage.
3. Before public beta, run multi-city evals, satisfy the coverage and availability observation gates, complete security review, and publish the promotion evidence.

# 14. Acceptance Criteria

- Given a coordinate inside a supported docked system, return-mode queries return the nearest operational stations with live docks, distance, and freshness.
- Take-mode queries distinguish zero from unknown availability and provide vehicle-type counts when the feed supplies them.
- A disabled or non-returning station is excluded by default for return queries.
- A stale provider observation is labeled stale and never described as current; `max_staleness_seconds` is enforced.
- A malformed or timed-out provider does not suppress valid results from another candidate provider.
- Every result identifies its system and source timestamp; every partial failure emits a stable warning.
- The public MCP endpoint works from at least two independent MCP clients over stateless Streamable HTTP.
- Concurrent misses for one system/feed produce one upstream refresh and coherent results for all waiting requests.
- KV is never the authority for 30-60-second live station status.
- The request Worker and each SystemFeed object enforce their configured pending-connection and total-deadline budgets.
- The largest-feed benchmark remains below 80 MB peak isolate memory and meets warm/cold latency gates.
- Catalog publication is immutable, validated, rollback-capable, and blocked on unacceptable coverage regression.
- Queue probes are idempotent; transient failures retry; exhausted messages reach a dead-letter queue with a runbook.
- All upstream fetches are restricted to validated public HTTPS destinations and respect redirect, DNS, size, decompression, record-count, and time limits.
- Logs, traces, and metrics contain no exact coordinates, prompts, authorization material, or unbounded upstream payloads.
- `/healthz`, `/readyz`, and `/status` have the documented Worker-specific semantics and do not live-fan-out globally; storage-backed readiness and status reads are rate limited before storage access.
- Operational dashboards distinguish service defects, platform-limit failures, catalog publication failures, and upstream provider failures.
- The repository includes fixtures, tests, local setup, Wrangler configuration, deployment instructions, contribution guidance, license, security policy, and platform fallback decision.

# 15. Product and Platform Decisions

| Question | Decision for V1 |
|---|---|
| Where is the public service hosted? | Cloudflare Workers Paid at `https://mcp.openbike.neesh.page`. Expansion beyond the four-system canary remains subject to the documented platform-fit benchmark. |
| What is the fallback if Workers does not fit? | Vercel Functions plus a managed Redis-compatible cache. Do not run a hybrid V1; switch only through the explicit go/no-go decision. |
| Does Vercel AI Gateway help this service? | No. It routes model inference and does not host or coordinate this deterministic MCP data service. Reconsider only if a future tool calls an LLM. |
| Does the MCP server need protocol sessions? | No for V1. Use the current stateless Streamable HTTP handler and store no MCP protocol session state. |
| Do we need Redis? | No on Cloudflare. Durable Objects provide live cache/locks/circuit state; Queues provide jobs/retries; KV/R2 provide slowly changing catalog data. |
| Do we need a database? | Not in the initial request path. Use a generated catalog and per-system Durable Object SQLite. Add D1 or Postgres/PostGIS when editable control-plane data, analytics, or geofence scale justify it. |
| Should the server geocode place names? | No. Require coordinates and publish examples showing client-side geocoding to avoid vendor keys, cost, and ambiguity. |
| Should dockless vehicles be exposed? | Index capability in V1, but defer a public nearby-vehicle tool until privacy, payload, and operator-license review. |
| Should stale data ever be served? | Yes only with explicit `is_stale`, age, warning, and client-configurable threshold; never silently substitute stale counts. |
| Should clients pass arbitrary GBFS URLs? | No for the public service. Accept only indexed/allowlisted systems to contain SSRF and abuse risk. |
| Should strict egress policy use Workers VPC/Gateway? | Evaluate during the security spike. It provides network-level logging/policy but is beta. Use a controlled egress service if independent enforcement is mandatory and beta is unacceptable. |
| What if an upstream provider requires a fixed source IP? | Use supported dedicated egress/Gateway or a separate fetch tier; standard Workers egress is shared. |
| Should tools mirror GBFS files? | No. Tools model user intent and normalized entities; raw-feed inspection belongs in diagnostics or documentation. |
| How should breaking changes ship? | Additive schema changes within V1; version tool names or endpoint/API major for breaking changes; publish deprecation windows. |

# 16. Future Work

- Optional geocoding and place search with pluggable providers.
- Nearby dockless vehicle discovery with deliberate privacy and payload safeguards.
- Service alerts, geofencing rules, pricing-plan summaries, and rental deep-link assistance.
- Historical reliability indicators derived from service-owned health telemetry, not rider trip histories.
- Route-aware ranking using walking distance and elevation outside the core GBFS layer.
- Authenticated higher quotas with globally exact accounting.
- D1 control-plane tables or external Postgres/PostGIS when catalog edits, analytics, or geofence scale justify them.
- Jurisdiction-specific catalog/cache deployments, regional egress policy, and data-residency controls.
- Self-hosting bundles and community-operated indexes.
- Optional model-backed explanation tools; only those calls would need an AI Gateway.

# Appendix A - Example get_nearby_availability response

```json
{
  "query": {
    "latitude": 40.7241,
    "longitude": -73.9997,
    "mode": "return",
    "radius_meters": 600
  },
  "systems_considered": [
    {"system_id": "us-ny-citi-bike", "name": "Citi Bike"}
  ],
  "results": [
    {
      "system": {"system_id": "us-ny-citi-bike", "name": "Citi Bike"},
      "station": {
        "station_id": "provider-scoped-id",
        "name": "Example Station",
        "latitude": 40.7238,
        "longitude": -74.0001
      },
      "distance_meters": 48,
      "availability": {
        "bikes_available": 7,
        "docks_available": 5,
        "is_renting": true,
        "is_returning": true,
        "is_installed": true,
        "confidence": "high"
      },
      "freshness": {
        "provider_last_updated": "2026-09-01T14:26:31Z",
        "fetched_at": "2026-09-01T14:26:42Z",
        "age_seconds": 11,
        "ttl_seconds": 30,
        "is_stale": false
      }
    }
  ],
  "warnings": []
}
```

# Appendix B - Cloudflare binding map

| Binding / route | Purpose | Required for V1 |
|---|---|---|
| `SYSTEM_FEEDS` Durable Object namespace | Per-system fresh cache, single-flight, ETags, and circuit state. | Yes. |
| `CATALOG_KV` | Current catalog version pointer and reviewed overrides. | Yes. |
| `CATALOG_R2` | Immutable catalog versions and bounded diagnostic snapshots. | Yes. |
| `PROBE_QUEUE` | Idempotent per-system probe messages. | Yes. |
| `PROBE_DLQ` | Exhausted probe messages. | Yes. |
| `CATALOG_REFRESH` Workflow | Scheduled catalog validation/publication and probe enqueue. | Yes. |
| `METRICS` Analytics Engine dataset | Request, cache, provider, queue, and coverage measurements. | Yes. |
| `EDGE_RATE_LIMITER` | Tool-cost-aware permissive client/token limiting. | Yes. |
| OTel destination | Sampled Worker logs and traces. | Yes for beta operations. |
| `EGRESS` Workers VPC/Gateway binding | Independently enforced DNS/HTTP/network egress policy. | Security-spike decision; beta. |
| D1 | Editable catalog/control-plane data. | No for initial request path. |

# Appendix C - Sources and Standards

This PRD was reviewed against the official sources below on September 2, 2026. Platform limits, prices, beta status, and exact package versions can change; implementation planning must re-check these pages before future deployments and before public-beta promotion.

- General Bikeshare Feed Specification (MobilityData): https://github.com/MobilityData/gbfs/blob/master/gbfs.md
- GBFS systems catalog (MobilityData): https://github.com/MobilityData/gbfs/blob/master/systems.csv
- GBFS project site: https://gbfs.org/
- MCP Streamable HTTP transport specification: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Cloudflare MCP handler API: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- Cloudflare remote MCP server guide: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Cloudflare MCP transport guidance: https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Durable Object rules and data location: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ and https://developers.cloudflare.com/durable-objects/reference/data-location/
- SQLite-backed Durable Object storage: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Workers KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Cloudflare R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Scheduled Workflows: https://developers.cloudflare.com/workflows/build/trigger-workflows/
- Cloudflare Queues configuration and delivery: https://developers.cloudflare.com/queues/configuration/configure-queues/ and https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Workers Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Gateway egress for Workers: https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/
- Workers request/redirect behavior: https://developers.cloudflare.com/workers/runtime-apis/request/
- Workers DNS API: https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/
- Workers Logs, Traces, and OpenTelemetry export: https://developers.cloudflare.com/workers/observability/ and https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- Workers Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/
- Vercel AI Gateway overview and pricing: https://vercel.com/docs/ai-gateway and https://vercel.com/docs/ai-gateway/pricing
- Vercel MCP deployment guide: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel
- Vercel Functions limits and usage pricing: https://vercel.com/docs/functions/limitations and https://vercel.com/docs/functions/usage-and-pricing
