# Extending city coverage

`src/catalog/seed.ts` is the single source of reviewed city configuration. `src/feeds/source.ts` converts it to a runtime source; the compatibility export in `src/gbfs/systems.ts` derives from the same entries. The live smoke scripts also derive their targets from the catalog. There is no plugin registration or dynamic loading.

## Shared output and transport

`createStationFeedClient()` is the small format boundary used by `SystemFeed`. All implementations return the existing `GbfsStationBundle` contract: namespaced system/station IDs, validated station coordinates, typed availability, operational flags, provider and station clocks, per-feed observations, and raw conditional-cache state. Its historical name remains for compatibility with persistence and existing callers.

- `gbfs` (default): the common 1.0/1.1, 2.1–2.3, and 3.x parser. Bcycle's legacy object counts and Vélib's array counts both become the same vehicle categories. Missing values remain unknown; mixed scooter counts never satisfy bike pickup filters.
- `velib`: a pure document adapter supplies the operator-documented 1.0 version when omitted and maps `lastUpdatedOther` to the envelope clock. It never changes a station's `last_reported` value. Original responses remain in cache, including on 304 revalidation.
- `tfl`: one BikePoint response provides station geometry and status. Explicit `NbEmptyDocks` supplies return spaces, not capacity minus bikes. Strict parsing preserves unknown counts and maps installed/locked flags. Source property timestamps remain attached to station status.

All formats use `FeedTransport` and the existing bounded JSON fetcher: exact reviewed hosts, redirect validation, no credentials, byte/depth/time limits, conditional requests, and payload-free errors. Source URLs and observations identify the actual endpoint. TfL's two logical feeds share one HTTP response; no fictitious GBFS discovery fetch is reported.

The Durable Object, SQLite storage, freshness evaluation, ranking, and MCP handlers are shared. Adding a provider must not require city-specific branches in those layers.

## Add a city

1. Inspect the operator's actual public feed and terms. Record version, hosts, source URLs, timestamp semantics, bike-type semantics, and licensing metadata; leave absent license/type/count data unknown.
2. Add one catalog entry with a stable ID, readable name, city, country, timezone, reviewed hosts, source URL, location hint, and station-derived bounds. Exclude placeholder coordinates from coverage geometry. Start disabled.
3. For standard GBFS, no new adapter is needed. A genuinely different wire format gets a small module under `src/feeds/`, a `feed_format` case in the catalog schema/type, and a case in `createStationFeedClient()`.
4. Add minimal synthetic fixtures for successful normalization, malformed input, unknown counts, stale clocks, joins, and availability selection. Test HTTP revalidation if adapting documents. Do not commit entire provider feeds.
5. Run `pnpm smoke:feeds <system_id>` against the real feed. It checks nearby pickups and returns within a 180-second freshness budget. A successful parse alone is insufficient. Enable only after it passes.
6. Run local checks, deploy staging, publish a fresh catalog, and run `pnpm smoke:coverage <staging-endpoint>`. This derives all enabled cities and checks city/name lookup, live pickups, returns, station details, and type filtering. It paces requests below the public rate limit. Then deploy production, publish its catalog, and repeat the smoke there.
7. Update supported-city documentation and website coverage only for enabled, verified cities.

A feed that parses but returns stale observations stays disabled. Do not clear or replace old station timestamps merely to make availability tests pass. Upstream data quality warnings remain visible to the caller.
