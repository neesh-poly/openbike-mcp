# Deployment

The repository is release-candidate complete for a four-system canary, but the production URL must not be advertised as live until every release step below succeeds. Worldwide catalog candidates remain disabled unless individually promoted through the reviewed override path.

## Environments

`wrangler.jsonc` defines isolated `staging` and `production` Workers. Each environment has distinct catalog KV/R2, probe/DLQ queues, Workflow, Durable Object namespace, metrics dataset, and rate-limit namespace. Only production owns the Custom Domain `mcp.openbike.neesh.page`.

## Release procedure

1. Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, and `pnpm build`.
2. Deploy staging with `pnpm deploy:staging`.
3. Seed or publish the catalog and run the live provider canary.
4. Exercise initialize, tools/list, and all five tools using two independent MCP clients.
5. Record the platform-fit report, including bundle size, warm/cold latency, connection ceiling, refresh coalescing, and peak memory evidence.
6. Deploy production with `pnpm deploy:production` and rerun the health and protocol smoke suite.
7. Watch Workers Logs, traces, queue failures, and cost indicators during the initial rollout.

After a successful production smoke run, replace "planned" endpoint language in the README and API documentation with the observed deployment status, commit that evidence, and create the release tag. Do not label the release a worldwide public beta until the PRD's Phase 2 coverage and availability gates are measured.

Deployment credentials belong in Wrangler OAuth storage or CI secrets. The repository contains no provider secrets because the seed feeds are public.

## Catalog publication

The scheduled `CatalogRefreshWorkflow` fetches the official MobilityData systems catalog, stages unauthenticated public-HTTPS rows as disabled candidates, merges reviewed overrides, validates URLs and coverage regression, writes an immutable `catalog/v1/<version>-<sha256>.json` R2 object, and only then updates KV `catalog:current`. Probe messages use `<catalog-version>:<system-id>` idempotency keys. `MOBILITYDATA_CATALOG_MODE=candidates` never auto-enables rows; the exact per-system promotion gate and remaining worldwide-enrichment work are documented in [SUPPORTED_SYSTEMS.md](SUPPORTED_SYSTEMS.md).

The Worker includes a small reviewed bootstrap catalog so a first deployment can become ready before the scheduled refresh. Production answers still expose which catalog version produced each result.

## Rollback

Follow [runbooks/rollback.md](runbooks/rollback.md). Never delete a Durable Object class, R2 catalog object, or namespace as part of a routine code rollback.
