# Contributing

Open Bikeshare MCP welcomes feed adapters, focused fixtures, catalog corrections, tests, and documentation fixes.

## Local checks

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm build:production
```

Use Node.js 22.18 or newer. Run `pnpm cf-typegen` after changing `wrangler.jsonc` bindings; the package script already selects staging.

## Feed and fixture rules

- Do not add arbitrary client-supplied feed URLs. Catalog entries and endpoint hosts are reviewed code/data changes.
- Prefer minimal synthetic or redacted fixtures that demonstrate one behavior. Do not commit entire live provider feeds.
- Record the GBFS version, source system, retrieval date, license or data-policy URL, and the behavior represented.
- Preserve unknown values as unknown. Never infer live docks from station capacity or silently treat a missing count as zero.
- Keep provider-specific extensions inside adapters; public contracts stay normalized and additive within V1.

## Pull requests

Describe the user-visible behavior, providers/versions covered, security implications, and commands run. New adapters need a positive fixture, malformed-input coverage, and a join/ranking assertion. Catalog corrections must cite a provider or MobilityData source and pass the publication regression checks.
