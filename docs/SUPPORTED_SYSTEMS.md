# Supported systems and catalog admission

The active canary remains the four manually reviewed systems below. The daily Workflow also stages eligible rows from MobilityData's canonical `systems.csv` as **disabled candidates** when `MOBILITYDATA_CATALOG_MODE=candidates`. Candidate indexing is not a claim of live or worldwide coverage: candidates are not probed, returned by MCP tools, or matched to coordinates until an operator explicitly promotes them.

| System ID | System | GBFS | Why included |
|---|---|---:|---|
| `lyft_nyc` | Citi Bike, New York City | 2.3 | Large docked-system and mixed bike/e-bike baseline. |
| `mobibikes_ca_vancouver` | Mobi Bike Share, Vancouver | 2.2 | Virtual stations, geofencing, and stationed/free-floating edge cases. |
| `oslobysykkel` | Oslo Bysykkel | 3.0 | Localized strings, station-area polygons, ISO timestamps, and short TTLs. |
| `nextbike_wr` | WienMobil Rad, Vienna | 2.3 | Nextbike extensions, optional capacity, and mixed vehicle variants. |

The normalized `system_id` is lowercase even when the upstream MobilityData catalog uses mixed case. Reachability was checked on September 2, 2026; it is not a long-term uptime guarantee.

## Provider policies and behavior

- Citi Bike’s feed does not declare a license in its live system feed. Its [official data policy](https://citibikenyc.com/data-sharing-policy) permits product use but restricts standalone redistribution and trademark use. The service returns normalized answers, not raw-feed mirrors.
- Mobi declares ODbL 1.0. The catalog preserves license/source attribution; database redistribution requires separate review.
- Oslo’s [open-data page](https://oslobysykkel.no/en/open-data/realtime) and [Entur Mobility documentation](https://developer.entur.no/docs/open-services/mobility) identify NLOD 2.0. Requests include the non-secret identification header `ET-Client-Name: openbike-mcp`.
- WienMobil’s live system information declares CC0 1.0. Source metadata is still preserved.

Normal station queries do not fetch `free_bike_status` or expose individual dockless vehicle coordinates. Capability probes may inspect advertised feed availability under separate byte and execution budgets.

## Canary warning baseline

The September 2, 2026 live-source probe completed for all four reviewed systems. The remaining warnings describe upstream data quality rather than a service failure: Citi Bike ignored optional discovery entries, reported 81 stations without station-level timestamps while retaining a usable feed timestamp, and produced a truthful stale-data warning when its TTL elapsed; Mobi exposed ignored optional discovery entries; WienMobil omitted capacity for 61 otherwise usable stations. Oslo completed without a warning. These observations are a dated baseline, not a waiver—new warning classes or materially larger counts require triage.

## MobilityData candidate admission

The catalog source is pinned to the reviewed `raw.githubusercontent.com/MobilityData/gbfs/{master|main}/systems.csv` path and fetched with redirect rejection and a 4 MiB body limit. Admission then:

- canonicalizes the upstream title-cased CSV headings and normalizes a stable ASCII `system_id` while retaining the original `source_system_id`;
- excludes every row that declares authentication metadata, lacks a usable name, or has a malformed discovery URL;
- rejects HTTP, credentials, credential-like query parameters, ports, IP literals, dotless/local/internal hostnames, fragments, and invalid DNS labels;
- quarantines every member of a duplicate normalized-ID group instead of choosing a last-wins row;
- stores only the exact discovery hostname in the outbound allowlist; runtime fetches still enforce the reviewed-host policy and Workers' public-network restriction; and
- records version, capability, license, timezone, language, and geographic coverage as unknown until a successful probe or explicit review establishes them.

Candidates therefore use `enabled: false`, `coverage.confidence: unknown`, null bounds/centroid, null `detected_version`, an unknown license, and all-false placeholder capabilities. All-false is an inert internal placeholder, not a claim that a provider lacks those capabilities. Because unknown coverage has no geometry, it never satisfies a coordinate lookup.

`MOBILITYDATA_CATALOG_MODE=reviewed` publishes only the four bootstrap systems. `candidates` adds the inert candidate index. There is deliberately no configuration value that globally enables every MobilityData row.

## Promotion gate

Promotion is per system through the `catalog:overrides` KV document. Enabling a disabled candidate is rejected unless the same override explicitly supplies `reviewed_hosts`; the resulting catalog still has to pass schema, exact-host, and regression validation. Before promotion, review and record:

1. discovery reachability and the advertised GBFS version;
2. every discovery and subfeed hostname (cross-host feeds need each exact host added);
3. provider terms, authentication requirements, and any non-secret identification headers;
4. representative normalized fixtures and adapter tests;
5. probe-derived capability metadata and station/geofence-derived coverage; and
6. queue, Durable Object, subrequest, memory, and monthly-cost impact at the intended rollout size.

Example override shape after those checks:

```json
{
  "sample-system": {
    "enabled": true,
    "reviewed_hosts": ["gbfs.provider.example.com"],
    "coverage": {
      "bounds": null,
      "centroid": null,
      "confidence": "unknown",
      "buffer_meters": 0
    }
  }
}
```

Keeping coverage unknown is valid for explicit ID, country, or text discovery, but it will not produce a coordinate match. Worldwide auto-onboarding remains blocked until live enrichment can prove cross-host policy, reachability, capabilities, license treatment, and geographic coverage without exceeding the deployment budget.

## Adding a system

Follow [CONTRIBUTING.md](../CONTRIBUTING.md). New active entries need a reviewed HTTPS discovery URL/hostname, data-policy evidence, representative minimized fixtures, adapter coverage, a safe location hint, and station bounds or an explicit `unknown` coverage label.
