# Deployment

The four-system production canary is live at `https://mcp.openbike.neesh.page/mcp` and has passed deployment and smoke validation. The September 2, 2026 launch catalog contained 1,524 systems: four reviewed systems were enabled and 1,520 candidates remained disabled unless individually promoted through the reviewed override path.

## Environments

`wrangler.jsonc` defines isolated `staging` and `production` Workers. Each environment has distinct catalog KV/R2, probe/DLQ queues, Workflow, Durable Object namespace, metrics dataset, and rate-limit namespace. Only production owns the Custom Domain `mcp.openbike.neesh.page`.

## Release procedure

1. Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, and `pnpm build`.
2. Deploy staging with `pnpm deploy:staging`.
3. Seed or publish the catalog and run the live provider canary.
4. Exercise initialize, tools/list, and all five tools using two independent MCP clients.
5. Record the release-fit evidence available at deployment time, including bundle size, warm/cold latency, connection ceilings, and refresh coalescing. Before private-alpha promotion, separately complete the deployed CPU and isolate-memory profiling required by the platform-fit gate.
6. Deploy production with `pnpm deploy:production` and rerun the health and protocol smoke suite.
7. Watch Workers Logs, traces, queue failures, and cost indicators during the initial rollout.

The initial production deployment and smoke validation are complete. For each subsequent release, rerun health, readiness, protocol, all-tool, and catalog/probe-status checks before tagging. Do not label the release a worldwide public beta until the PRD's Phase 2 coverage and availability gates are measured.

## Initial production launch evidence

The September 2, 2026 UTC launch deployed protected-main commit `ed8a9f3` as Worker version `3493edd1-111d-4eb2-9d62-4aac43fb9e92`.

- Catalog Workflow instance `cf_141b6e038d376d89f65382ed2c96d257a3f89fbb8a98ef5296a110585c006b84` validated 1,535 source rows and published 1,524 systems: four enabled reviewed systems and 1,520 disabled candidates.
- The materialized launch probe cycle completed 4/4 systems with three healthy, one degraded, and zero unavailable.
- Modern-auto and legacy-2025 MCP client smokes passed initialize, `tools/list`, and all five tools.
- From the launch machine, 10-sample p95 wall times were 69.7 ms for `/healthz`, 26.9 ms for `/readyz`, and 581 ms for warm `find_systems`. These client-side samples are deployment evidence, not an availability SLO.
- The custom hostname presented a valid publicly trusted certificate. The production `workers.dev` hostname and preview URLs returned no Worker route and remain disabled.

Deployment credentials belong in Wrangler OAuth storage or CI secrets. The repository contains no provider secrets because the seed feeds are public.

## Catalog publication

The scheduled `CatalogRefreshWorkflow` fetches the official MobilityData systems catalog, stages unauthenticated public-HTTPS rows as disabled candidates, merges reviewed overrides, validates URLs and coverage regression, writes an immutable `catalog/v1/<version>-<sha256>.json` R2 object, and only then updates KV `catalog:current`. Probe messages use `<catalog-version>:<system-id>` idempotency keys. `MOBILITYDATA_CATALOG_MODE=candidates` never auto-enables rows; the exact per-system promotion gate and remaining worldwide-enrichment work are documented in [SUPPORTED_SYSTEMS.md](SUPPORTED_SYSTEMS.md).

The Worker includes a small reviewed bootstrap catalog so a first deployment can become ready before the scheduled refresh. Production answers still expose which catalog version produced each result.

## Rollback

Follow [runbooks/rollback.md](runbooks/rollback.md). Never delete a Durable Object class, R2 catalog object, or namespace as part of a routine code rollback.
