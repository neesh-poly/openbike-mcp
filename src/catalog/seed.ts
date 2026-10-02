import type { CatalogSnapshot, CatalogSystem } from "./types";

export const BUNDLED_CATALOG_VERSION = "bundled-2026-10-02-expanded";

const DEFAULT_CAPABILITIES = {
  docked: true,
  dockless: false,
  ebike: true,
  station_status: true,
} as const;

export const BUNDLED_CATALOG_SYSTEMS: readonly CatalogSystem[] = [
  {
    system_id: "lyft_nyc",
    source_system_id: "lyft_nyc",
    name: "Citi Bike",
    operator: "Lyft",
    city: "New York City",
    region: "New York",
    country_code: "US",
    timezone: "America/New_York",
    discovery_url: "https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json",
    detected_version: "2.3",
    languages: ["en"],
    license: {
      id: null,
      name: "Citi Bike Data Use Policy",
      url: "https://citibikenyc.com/data-sharing-policy",
      status: "declared",
    },
    capabilities: DEFAULT_CAPABILITIES,
    coverage: {
      bounds: { south: 40.49, west: -74.27, north: 40.92, east: -73.68 },
      centroid: { latitude: 40.7128, longitude: -74.006 },
      confidence: "catalog_metadata",
      buffer_meters: 5_000,
    },
    location_hint: "enam",
    reviewed_hosts: ["gbfs.citibikenyc.com", "gbfs.lyft.com"],
    request_headers: {},
    preferred_languages: ["en"],
    enabled: true,
  },
  {
    system_id: "mobibikes_ca_vancouver",
    source_system_id: "Mobibikes_CA_Vancouver",
    name: "Mobi by Rogers (Vancouver)",
    operator: "Vancouver Bike Share",
    city: "Vancouver",
    region: "British Columbia",
    country_code: "CA",
    timezone: "America/Vancouver",
    discovery_url:
      "https://gbfs.kappa.fifteen.eu/gbfs/2.2/mobi/en/gbfs.json",
    detected_version: "2.2",
    languages: ["en"],
    license: {
      id: "ODbL-1.0",
      name: "Open Data Commons Open Database License 1.0",
      url: "https://spdx.org/licenses/ODbL-1.0.html",
      status: "declared",
    },
    capabilities: DEFAULT_CAPABILITIES,
    coverage: {
      bounds: { south: 49.2, west: -123.3, north: 49.32, east: -123.02 },
      centroid: { latitude: 49.2827, longitude: -123.1207 },
      confidence: "catalog_metadata",
      buffer_meters: 5_000,
    },
    location_hint: "wnam",
    reviewed_hosts: ["gbfs.kappa.fifteen.eu"],
    request_headers: {},
    preferred_languages: ["en"],
    enabled: true,
  },
  {
    system_id: "oslobysykkel",
    source_system_id: "oslobysykkel",
    name: "Oslo Bysykkel",
    operator: "UIP Bauer Media Outdoor Norge AS",
    city: "Oslo",
    region: "Oslo",
    country_code: "NO",
    timezone: "Europe/Oslo",
    discovery_url:
      "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
    detected_version: "3.0",
    languages: ["nb"],
    license: {
      id: "NLOD-2.0",
      name: "Norwegian Licence for Open Government Data 2.0",
      url: "https://data.norge.no/nlod/en/2.0",
      status: "declared",
    },
    capabilities: DEFAULT_CAPABILITIES,
    coverage: {
      bounds: { south: 59.84, west: 10.58, north: 60.02, east: 10.95 },
      centroid: { latitude: 59.9139, longitude: 10.7522 },
      confidence: "catalog_metadata",
      buffer_meters: 5_000,
    },
    location_hint: "weur",
    reviewed_hosts: ["api.entur.io"],
    request_headers: { "ET-Client-Name": "openbike-mcp" },
    preferred_languages: ["nb", "en"],
    enabled: true,
  },
  {
    system_id: "nextbike_wr",
    source_system_id: "nextbike_wr",
    name: "WienMobil Rad",
    operator: "nextbike GmbH",
    city: "Vienna",
    region: "Vienna",
    country_code: "AT",
    timezone: "Europe/Berlin",
    discovery_url:
      "https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_wr/gbfs.json",
    detected_version: "2.3",
    languages: ["de", "en"],
    license: {
      id: "CC0-1.0",
      name: "Creative Commons Zero v1.0 Universal",
      url: "https://spdx.org/licenses/CC0-1.0.html",
      status: "declared",
    },
    capabilities: DEFAULT_CAPABILITIES,
    coverage: {
      bounds: { south: 48.1, west: 16.18, north: 48.32, east: 16.58 },
      centroid: { latitude: 48.2082, longitude: 16.3738 },
      confidence: "catalog_metadata",
      buffer_meters: 5_000,
    },
    location_hint: "weur",
    reviewed_hosts: ["gbfs.nextbike.net"],
    request_headers: {},
    preferred_languages: ["de", "en"],
    enabled: true,
  },
  // Reviewed 2026-10-02; bounds are derived from provider station locations.
  {
    system_id: "lyft_bay",
    source_system_id: "lyft_bay",
    name: "Lyft Bike",
    operator: "Lyft",
    city: "San Francisco",
    region: "San Francisco Bay Area, California",
    country_code: "US",
    timezone: "America/Los_Angeles",
    discovery_url: "https://gbfs.lyftbikes.com/gbfs/2.3/gbfs.json",
    detected_version: "2.3",
    languages: ["en", "fr", "es"],
    license: {
      id: null,
      name: "Lyft Bike Data License Agreement",
      url: "https://baywheels-assets.s3.amazonaws.com/data-license-agreement.html",
      status: "declared",
    },
    capabilities: {
      docked: true,
      dockless: true,
      ebike: true,
      station_status: true,
    },
    coverage: {
      bounds: {
        south: 37.309014074275915,
        west: -122.511208,
        north: 37.88534088973987,
        east: -121.8636494,
      },
      centroid: {
        latitude: 37.7749,
        longitude: -122.4194,
      },
      confidence: "station_bounds",
      buffer_meters: 5_000,
    },
    location_hint: "wnam",
    reviewed_hosts: ["gbfs.lyftbikes.com", "gbfs.lyft.com"],
    request_headers: {},
    preferred_languages: ["en"],
    enabled: true,
  },
  {
    system_id: "bluebikes",
    source_system_id: "bluebikes",
    name: "Bluebikes",
    operator: "Lyft",
    city: "Boston",
    region: "Greater Boston, Massachusetts",
    country_code: "US",
    timezone: "America/New_York",
    discovery_url: "https://gbfs.bluebikes.com/gbfs/2.3/gbfs.json",
    detected_version: "2.3",
    languages: ["en", "fr", "es"],
    license: {
      id: null,
      name: "Bluebikes Data License Agreement",
      url: "https://bluebikes.com/data-license-agreement",
      status: "declared",
    },
    capabilities: {
      docked: true,
      dockless: true,
      ebike: true,
      station_status: true,
    },
    coverage: {
      bounds: {
        south: 42.252287,
        west: -71.2477594614029,
        north: 42.53466911383265,
        east: -70.87021440267563,
      },
      centroid: {
        latitude: 42.3601,
        longitude: -71.0589,
      },
      confidence: "station_bounds",
      buffer_meters: 5_000,
    },
    location_hint: "enam",
    reviewed_hosts: ["gbfs.bluebikes.com", "gbfs.lyft.com"],
    request_headers: {},
    preferred_languages: ["en"],
    enabled: true,
  },
  {
    system_id: "lyft_chi",
    source_system_id: "lyft_chi",
    name: "Divvy",
    operator: "Lyft",
    city: "Chicago",
    region: "Illinois",
    country_code: "US",
    timezone: "America/Chicago",
    discovery_url: "https://gbfs.divvybikes.com/gbfs/2.3/gbfs.json",
    detected_version: "2.3",
    languages: ["en", "fr", "es"],
    license: {
      id: null,
      name: "Divvy Data License Agreement",
      url: "https://divvybikes.com/data-license-agreement",
      status: "declared",
    },
    capabilities: {
      docked: true,
      dockless: true,
      ebike: true,
      station_status: true,
    },
    coverage: {
      bounds: {
        south: 41.64850076266409,
        west: -87.84396,
        north: 42.064854,
        east: -87.52823173999786,
      },
      centroid: {
        latitude: 41.8781,
        longitude: -87.6298,
      },
      confidence: "station_bounds",
      buffer_meters: 5_000,
    },
    location_hint: "enam",
    reviewed_hosts: ["gbfs.divvybikes.com", "gbfs.lyft.com"],
    request_headers: {},
    preferred_languages: ["en"],
    enabled: true,
  },
  // Reviewed public feeds; see docs/operations/2026-10-global-expansion.md.
  {
    "system_id": "cabi",
    "source_system_id": "cabi",
    "name": "Capital Bikeshare",
    "operator": "Lyft",
    "city": "Washington, DC",
    "region": "District of Columbia, Maryland, Virginia",
    "country_code": "US",
    "timezone": "America/New_York",
    "discovery_url": "https://gbfs.capitalbikeshare.com/gbfs/2.3/gbfs.json",
    "detected_version": "2.3",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": "https://capitalbikeshare.com/data-license-agreement",
      "status": "declared"
    },
    "capabilities": {
      "docked": true,
      "dockless": true,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 38.71103517,
        "west": -77.4193554659783,
        "north": 39.12582811177034,
        "east": -76.825535
      },
      "centroid": {
        "latitude": 38.9072,
        "longitude": -77.0369
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "enam",
    "reviewed_hosts": [
      "gbfs.capitalbikeshare.com",
      "gbfs.lyft.com"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "bike_share_toronto",
    "source_system_id": "bike_share_toronto",
    "name": "Bike Share Toronto",
    "operator": null,
    "city": "Toronto",
    "region": "Ontario",
    "country_code": "CA",
    "timezone": "America/Toronto",
    "discovery_url": "https://toronto.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json",
    "detected_version": "3.0",
    "languages": [
      "en",
      "fr",
      "nl",
      "es"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 43.5880774,
        "west": -79.60346425086402,
        "north": 43.812642480301804,
        "east": -79.1231844760227
      },
      "centroid": {
        "latitude": 43.6532,
        "longitude": -79.3832
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "enam",
    "reviewed_hosts": [
      "toronto.publicbikesystem.net"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en",
      "fr"
    ],
    "enabled": true
  },
  {
    "system_id": "bixi_mtl",
    "source_system_id": "Bixi_MTL",
    "name": "BIXI Montréal",
    "operator": null,
    "city": "Montréal",
    "region": "Quebec",
    "country_code": "CA",
    "timezone": "America/Montreal",
    "discovery_url": "https://gbfs.velobixi.com/gbfs/2-2/gbfs.json",
    "detected_version": "2.2",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 45.379756292248274,
        "west": -73.94148454070091,
        "north": 45.70234934325735,
        "east": -71.87262399125757
      },
      "centroid": {
        "latitude": 45.5019,
        "longitude": -73.5674
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "enam",
    "reviewed_hosts": [
      "gbfs.velobixi.com"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en",
      "fr"
    ],
    "enabled": true
  },
  {
    "system_id": "biketown_pdx",
    "source_system_id": "biketown_pdx",
    "name": "BIKETOWN",
    "operator": null,
    "city": "Portland",
    "region": "Oregon",
    "country_code": "US",
    "timezone": "America/Los_Angeles",
    "discovery_url": "https://gbfs.biketownpdx.com/gbfs/2.3/gbfs.json",
    "detected_version": "2.3",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": "https://biketownpdx.com/data-license-agreement",
      "status": "declared"
    },
    "capabilities": {
      "docked": true,
      "dockless": true,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 45.4607915,
        "west": -122.7591351,
        "north": 45.5965621,
        "east": -122.5321656
      },
      "centroid": {
        "latitude": 45.5152,
        "longitude": -122.6784
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "wnam",
    "reviewed_hosts": [
      "gbfs.biketownpdx.com",
      "gbfs.lyft.com"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": false
  },
  {
    "system_id": "austin",
    "source_system_id": "austin",
    "name": "CapMetro Bikeshare",
    "operator": null,
    "city": "Austin",
    "region": "Texas",
    "country_code": "US",
    "timezone": "America/Chicago",
    "discovery_url": "https://austin.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json",
    "detected_version": "3.0",
    "languages": [
      "en",
      "fr",
      "nl",
      "es"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 30.226188000000004,
        "west": -97.772695,
        "north": 30.295394,
        "east": -97.698123
      },
      "centroid": {
        "latitude": 30.2672,
        "longitude": -97.7431
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "enam",
    "reviewed_hosts": [
      "austin.publicbikesystem.net"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "nextbike_bn",
    "source_system_id": "nextbike_bn",
    "name": "nextbike Berlin",
    "operator": "nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig",
    "city": "Berlin",
    "region": null,
    "country_code": "DE",
    "timezone": "Europe/Berlin",
    "discovery_url": "https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bn/gbfs.json",
    "detected_version": "2.3",
    "languages": [
      "en"
    ],
    "license": {
      "id": "CC0-1.0",
      "name": null,
      "url": null,
      "status": "declared"
    },
    "capabilities": {
      "docked": true,
      "dockless": true,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 52.40854,
        "west": 13.160078,
        "north": 52.595837,
        "east": 13.691439
      },
      "centroid": {
        "latitude": 52.52,
        "longitude": 13.405
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "weur",
    "reviewed_hosts": [
      "gbfs.nextbike.net"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "bicimad_madrid",
    "source_system_id": "bicimad_madrid",
    "name": "bicimad",
    "operator": null,
    "city": "Madrid",
    "region": null,
    "country_code": "ES",
    "timezone": "Europe/Madrid",
    "discovery_url": "https://madrid.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json",
    "detected_version": "3.0",
    "languages": [
      "en",
      "fr",
      "nl",
      "es"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 40.3325463,
        "west": -3.8163961268440296,
        "north": 40.5157202,
        "east": -3.548534
      },
      "centroid": {
        "latitude": 40.4168,
        "longitude": -3.7038
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "weur",
    "reviewed_hosts": [
      "madrid.publicbikesystem.net"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "bike_barcelona",
    "source_system_id": "bike_barcelona",
    "name": "Bicing",
    "operator": null,
    "city": "Barcelona",
    "region": null,
    "country_code": "ES",
    "timezone": "Europe/Madrid",
    "discovery_url": "https://barcelona.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json",
    "detected_version": "3.0",
    "languages": [
      "ca",
      "en",
      "fr",
      "nl",
      "es"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 41.3467746,
        "west": 2.1091535,
        "north": 41.462095,
        "east": 2.2206913
      },
      "centroid": {
        "latitude": 41.3874,
        "longitude": 2.1686
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "weur",
    "reviewed_hosts": [
      "barcelona.publicbikesystem.net"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "docomo-cycle-tokyo",
    "source_system_id": "docomo-cycle-tokyo",
    "name": "docomo bike share",
    "operator": null,
    "city": "Tokyo",
    "region": null,
    "country_code": "JP",
    "timezone": "Asia/Tokyo",
    "discovery_url": "https://api-public.odpt.org/api/v4/gbfs/docomo-cycle-tokyo/gbfs.json",
    "detected_version": "2.3",
    "languages": [
      "ja"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": "https://creativecommons.org/licenses/by/4.0/deed.ja",
      "status": "declared"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": false,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 35.506142,
        "west": 139.565817,
        "north": 35.778605,
        "east": 139.846383
      },
      "centroid": {
        "latitude": 35.6812,
        "longitude": 139.7671
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "apac",
    "reviewed_hosts": [
      "api-public.odpt.org"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "bcycle_indego",
    "source_system_id": "bcycle_indego",
    "name": "Indego",
    "operator": null,
    "city": "Philadelphia",
    "region": "Pennsylvania",
    "country_code": "US",
    "timezone": "America/New_York",
    "discovery_url": "https://gbfs.bcycle.com/bcycle_indego/gbfs.json",
    "detected_version": "1.1",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 39.88994,
        "west": -75.249,
        "north": 40.03055,
        "east": -75.10121
      },
      "centroid": {
        "latitude": 39.9526,
        "longitude": -75.1652
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "enam",
    "reviewed_hosts": [
      "gbfs.bcycle.com"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "bcycle_lametro",
    "source_system_id": "bcycle_lametro",
    "name": "Metro Bike Share",
    "operator": null,
    "city": "Los Angeles",
    "region": "California",
    "country_code": "US",
    "timezone": "America/Los_Angeles",
    "discovery_url": "https://gbfs.bcycle.com/bcycle_lametro/gbfs.json",
    "detected_version": "1.1",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 33.92846,
        "west": -118.49136,
        "north": 34.17765,
        "east": -118.22541
      },
      "centroid": {
        "latitude": 34.0485,
        "longitude": -118.2585
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "wnam",
    "reviewed_hosts": [
      "gbfs.bcycle.com"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },
  {
    "system_id": "paris",
    "source_system_id": "Paris",
    "name": "Vélib’ Métropole",
    "operator": null,
    "city": "Paris",
    "region": "Île-de-France",
    "country_code": "FR",
    "timezone": "Europe/Paris",
    "discovery_url": "https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/gbfs.json",
    "detected_version": "1.0",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": null,
      "url": null,
      "status": "unknown"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 48.743385629116,
        "west": 2.1655421457014,
        "north": 48.95756799268,
        "east": 2.5382421165704727
      },
      "centroid": {
        "latitude": 48.8566,
        "longitude": 2.3522
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "weur",
    "reviewed_hosts": [
      "velib-metropole-opendata.smovengo.cloud"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": false,
    "feed_format": "velib"
  },
  {
    "system_id": "tfl_london",
    "source_system_id": "tfl_london",
    "name": "Santander Cycles",
    "operator": "Transport for London",
    "city": "London",
    "region": "Greater London",
    "country_code": "GB",
    "timezone": "Europe/London",
    "feed_format": "tfl",
    "discovery_url": "https://api.tfl.gov.uk/BikePoint",
    "detected_version": "TfL-BikePoint",
    "languages": [
      "en"
    ],
    "license": {
      "id": null,
      "name": "Transport Data Service terms",
      "url": "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
      "status": "declared"
    },
    "capabilities": {
      "docked": true,
      "dockless": false,
      "ebike": true,
      "station_status": true
    },
    "coverage": {
      "bounds": {
        "south": 51.452997,
        "west": -0.236769,
        "north": 51.549369,
        "east": 0.004979
      },
      "centroid": {
        "latitude": 51.5074,
        "longitude": -0.1278
      },
      "confidence": "station_bounds",
      "buffer_meters": 5000
    },
    "location_hint": "weur",
    "reviewed_hosts": [
      "api.tfl.gov.uk"
    ],
    "request_headers": {},
    "preferred_languages": [
      "en"
    ],
    "enabled": true
  },

];

export const BUNDLED_CATALOG: CatalogSnapshot = {
  schema_version: 1,
  version: BUNDLED_CATALOG_VERSION,
  generated_at: "2026-10-02T00:00:00.000Z",
  source_url:
    "https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv",
  source_etag: null,
  systems: [...BUNDLED_CATALOG_SYSTEMS],
};
