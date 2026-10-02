# San Francisco, Boston, and Chicago feed review

Reviewed October 2, 2026. These are dated observations, not guaranteed fleet sizes or availability.

| City / directory ID | Reviewed discovery URL | Station records | Coverage |
|---|---|---:|---|
| San Francisco / `lyft_bay` | `https://gbfs.lyftbikes.com/gbfs/2.3/gbfs.json` | 640 | Bay Area station bounds, including neighboring service areas |
| Boston / `bluebikes` | `https://gbfs.bluebikes.com/gbfs/2.3/gbfs.json` | 624 | Greater Boston station bounds |
| Chicago / `lyft_chi` | `https://gbfs.divvybikes.com/gbfs/2.3/gbfs.json` | 2,072 | Chicago-area station bounds |

All three discovery documents and their station, status, system, and vehicle-type feeds declare GBFS 2.3. Each discovery host and the shared subfeed host `gbfs.lyft.com` were reviewed. No authentication or custom request headers are needed. Station coordinates produced the catalog bounds; city centers provide the centroids. Each has a 5 km discovery buffer. A coverage match is a system-selection hint, not a promise that a station exists at every point inside the bounds.

Boston's directory entry still points to a legacy discovery URL. The reviewed entry pins its working 2.3 URL and keeps `bluebikes` as its public ID even though the live system document says `lyft_bos`. San Francisco's official feed and website now use the name Lyft Bike. Only catalog admission changes; the existing station adapter handles all three feeds.

## Sources and terms

- San Francisco: [official system data](https://lyftbikes.com/system-data), [data license](https://baywheels-assets.s3.amazonaws.com/data-license-agreement.html).
- Boston: [official system data](https://bluebikes.com/system-data), [data license](https://bluebikes.com/data-license-agreement).
- Chicago: [official system data](https://divvybikes.com/system-data), [data license](https://divvybikes.com/data-license-agreement).

The licenses allow data use in a product or service and restrict standalone redistribution and implied affiliation. OpenBike serves bounded, normalized station answers with source metadata; it does not publish downloadable provider datasets or operator logos. The catalog retains the corresponding policy link when a live system document omits a license.

## Normalization and resource checks

Live `GbfsClient.fetchStationBundle()` checks successfully normalized and joined all station records. Expected upstream warnings include ignored optional discovery entries and missing station timestamps. Staleness remains explicit. Chicago publishes scooter types as well as bikes; bike pickup checks explicitly select `bike` and `ebike` so scooter counts do not satisfy them.

The largest checked document was Chicago station status at about 872 KB, below the 4 MiB feed limit. The three complete bundles total about 2.6 MB of source JSON and require five requests each; no individual dockless-vehicle feed is fetched. Three additional systems add three daily probe messages and about 15 feed requests per daily cycle. The existing four-system per-request fan-out, queue concurrency, byte limits, rate limit, and spending controls remain in effect. Demand-driven refresh traffic still depends on usage.

Synthetic tests cover both reviewed hosts, Boston's ID mapping, geographic discovery, station/status joins, and bicycle filtering in the presence of scooters. `pnpm smoke:coverage <endpoint>` verifies coordinate-based discovery, live pickups, live returns, freshness, and individual station lookup in all three cities.

## Seattle remains disabled

The catalog lists Lime Seattle and Bird Seattle. On October 2, Lime's public v2 discovery returned HTTP 403. Bird's 2.3 discovery responded, but its station information and station status lists were empty; its individual-vehicle feed contained one scooter and no e-bikes. Bird advertises an e-bike type, which alone does not establish available bike coverage. These observations do not imply that Seattle has no bikeshare service.

Enabling Seattle requires a usable bicycle feed and an explicit dockless-vehicle query path. OpenBike's station APIs cannot truthfully represent an individual dockless bike as a station or promise an empty dock there. Seattle is therefore excluded from the website's supported-city list.
