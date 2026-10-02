# October 2026 global city expansion

Reviewed October 2, 2026. These are dated live observations, not guaranteed fleet sizes or service availability.

The release configures 20 cities and enables 18. Eleven new cities pass live pickup and return checks: Washington DC, Toronto, Montréal, Austin, Berlin, Madrid, Barcelona, Tokyo, Philadelphia, Los Angeles, and London. Existing New York, Vancouver, Oslo, Vienna, San Francisco, Boston, and Chicago coverage is rechecked. Portland and Paris remain disabled pending fresh station observations. Seattle retains its previous feed-access/dockless limitation.

## Reviewed sources

The source of each GBFS URL is the [MobilityData directory](https://github.com/MobilityData/gbfs/blob/master/systems.csv), cross-checked against the operator feed. London uses the official [TfL BikePoint API](https://api.tfl.gov.uk/BikePoint), described by [TfL open-data documentation](https://tfl.gov.uk/info-for/open-data-users/our-open-data). All tested feeds respond without credentials.

| City | Format | Station records | Source | Activation |
|---|---|---:|---|---|
| New York City | 2.3 | 2520 | [operator feed](https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json) | Enabled |
| Vancouver | 2.2 | 263 | [operator feed](https://gbfs.kappa.fifteen.eu/gbfs/2.2/mobi/en/gbfs.json) | Enabled |
| Oslo | 3.0 | 267 | [operator feed](https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs) | Enabled |
| Vienna | 2.3 | 261 | [operator feed](https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_wr/gbfs.json) | Enabled |
| San Francisco | 2.3 | 640 | [operator feed](https://gbfs.lyftbikes.com/gbfs/2.3/gbfs.json) | Enabled |
| Boston | 2.3 | 624 | [operator feed](https://gbfs.bluebikes.com/gbfs/2.3/gbfs.json) | Enabled |
| Chicago | 2.3 | 2072 | [operator feed](https://gbfs.divvybikes.com/gbfs/2.3/gbfs.json) | Enabled |
| Washington, DC | 2.3 | 866 | [operator feed](https://gbfs.capitalbikeshare.com/gbfs/2.3/gbfs.json) | Enabled |
| Toronto | 3.0 | 1073 | [operator feed](https://toronto.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json) | Enabled |
| Montréal | 2.2 | 1118 | [operator feed](https://gbfs.velobixi.com/gbfs/2-2/gbfs.json) | Enabled |
| Portland | 2.3 | 307 | [operator feed](https://gbfs.biketownpdx.com/gbfs/2.3/gbfs.json) | Pending freshness |
| Austin | 3.0 | 83 | [operator feed](https://austin.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json) | Enabled |
| Berlin | 2.3 | 1051 | [operator feed](https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bn/gbfs.json) | Enabled |
| Madrid | 3.0 | 678 | [operator feed](https://madrid.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json) | Enabled |
| Barcelona | 3.0 | 543 | [operator feed](https://barcelona.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json) | Enabled |
| Tokyo | 2.3 | 1915 | [operator feed](https://api-public.odpt.org/api/v4/gbfs/docomo-cycle-tokyo/gbfs.json) | Enabled |
| Philadelphia | 1.1 | 319 | [operator feed](https://gbfs.bcycle.com/bcycle_indego/gbfs.json) | Enabled |
| Los Angeles | 1.1 | 224 | [operator feed](https://gbfs.bcycle.com/bcycle_lametro/gbfs.json) | Enabled |
| Paris | 1.0 | 1519 | [operator feed](https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/gbfs.json) | Pending freshness |
| London | TfL-BikePoint | 800 | [operator feed](https://api.tfl.gov.uk/BikePoint) | Enabled |

## Interpretation and limitations

- City metadata and runtime feed sources derive from one reviewed catalog. Exact provider/subfeed hosts are allowlisted. Coverage comes from station coordinates, with a 5 km discovery buffer; it is not a guarantee of a station at every coordinate.
- Four BIXI placeholder stations at 0,0 were excluded from the coverage bounds. Their disabled operational flags still prevent pickup/return results. Accent-insensitive catalog lookup accepts both Montreal and Montréal.
- GBFS 1.0/1.1 support enables Bcycle's Philadelphia and LA feeds. Explicit classic/electric counts are retained; unknown `smart` categories remain unknown. Missing station capacity is not reconstructed from availability.
- Vélib documents GBFS 1.0 but omits the version and calls its envelope timestamp `lastUpdatedOther`. Its counts arrive as an array of mechanical/e-bike objects. The adapter corrects those wire-format differences without changing station clocks.
- Paris's newest station readings were about 45 minutes old. The [City of Paris mirror](https://opendata.paris.fr/explore/dataset/velib-disponibilite-en-temps-reel/) showed the same old observations. The city is configured but disabled; re-fetching the envelope does not make those readings fresh.
- Portland's station feed was reachable and contained counts, but every station timestamp exceeded one day, with some dating back many months. It is configured but disabled pending a usable timestamp source. Its advertised e-bike type alone does not meet the activation gate.
- Tokyo provides aggregate bikes and return spaces with fresh station timestamps but no vehicle-type breakdown. Generic bike queries work; the adapter does not invent e-bike counts or promise type-specific results.
- TfL provides standard-bike, e-bike, empty-dock, capacity, installed/locked, and property-modification fields. Old property timestamps remain old, so only stations inside the caller's freshness window can satisfy nearby availability. Empty docks are read explicitly rather than inferred by subtraction.
- Mixed GBFS vehicle counts separate scooters from bicycles. Unknown values stay unknown; absent per-category counts are not silently filled with zero.

## Attribution and provider policies

Each response retains real source URLs, fetch times, provider clocks, and warnings. Declared license identifiers/URLs are retained (including Berlin CC0 and Tokyo CC-BY); providers that omit a declaration remain `unknown` in catalog metadata, not assumed public-domain. The service returns bounded normalized answers, not raw-feed downloads. See [Capital Bikeshare system data](https://capitalbikeshare.com/system-data), [BIXI open data](https://bixi.com/en/open-data), [BIKETOWN system data](https://biketownpdx.com/system-data), [Vélib open data](https://www.velib-metropole.fr/fr/donnees-open-data-gbfs-du-service-velib-metropole), and [TfL terms](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service).

## Validation and resource scope

Synthetic tests cover old/new GBFS versions, legacy count shapes, mixed scooters, unknown type counts, unchanged timestamps, 304 raw-document reuse, malformed TfL data, redirects, and city lookup. A Worker integration test persists and restores a TfL snapshot through the same SQLite path used for GBFS.

`pnpm smoke:feeds` checks all enabled providers with a 180-second freshness limit. Explicit IDs can review disabled candidates: `pnpm smoke:feeds paris biketown_pdx`. `pnpm smoke:coverage <endpoint>` checks the deployed MCP's city/name lookup, coordinate lookup, pickup, return, station detail, and type filtering. Requests are paced below the 60/minute public limit. No service limits are relaxed for validation.

Eighteen enabled systems mean 18 daily scheduled probes. Seventeen GBFS systems use four or five bounded feed requests each; TfL uses one. The 4 MiB feed limit, 4 MiB normalized snapshot limit, four-system per-request fan-out, queue concurrency, and rate limits remain unchanged. Demand-driven refresh costs still depend on usage. The local benchmark verifies functional/resource bounds, not deployed per-invocation CPU or isolate memory.

The existing dependency audit reports six advisories in unchanged transitive dependencies (`fast-uri`, `ip-address`, `hono`). This release does not bypass the required CI audit or merge through a failed check.
