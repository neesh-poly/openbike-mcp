import type { GbfsSystemSource } from "./types";

/**
 * Small, manually reviewed launch catalog. Feed URLs remain provider-owned;
 * this service stores normalized snapshots rather than redistributing raw data.
 */
export const INITIAL_GBFS_SYSTEMS = [
  {
    systemId: "lyft_nyc",
    discoveryUrl: "https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json",
    city: "New York City",
    region: "NY-NJ-CT",
    countryCode: "US",
    preferredLanguages: ["en"],
    reviewedHosts: [
      { hostname: "gbfs.citibikenyc.com", pathPrefixes: ["/gbfs/"] },
      { hostname: "gbfs.lyft.com", pathPrefixes: ["/gbfs/"] },
    ],
    licenseOverride: "https://citibikenyc.com/data-sharing-policy",
  },
  {
    systemId: "mobibikes_ca_vancouver",
    discoveryUrl:
      "https://gbfs.kappa.fifteen.eu/gbfs/2.2/mobi/en/gbfs.json",
    city: "Vancouver",
    region: "British Columbia",
    countryCode: "CA",
    preferredLanguages: ["en"],
    reviewedHosts: [
      {
        hostname: "gbfs.kappa.fifteen.eu",
        pathPrefixes: ["/gbfs/2.2/mobi/"],
      },
    ],
  },
  {
    systemId: "oslobysykkel",
    discoveryUrl:
      "https://api.entur.io/mobility/v2/gbfs/v3/oslobysykkel/gbfs",
    city: "Oslo",
    countryCode: "NO",
    preferredLanguages: ["nb", "en"],
    reviewedHosts: [
      {
        hostname: "api.entur.io",
        pathPrefixes: ["/mobility/v2/gbfs/v3/oslobysykkel/"],
      },
    ],
    requestHeaders: { "ET-Client-Name": "openbike-mcp" },
    licenseOverride: "NLOD-2.0",
  },
  {
    systemId: "nextbike_wr",
    discoveryUrl:
      "https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_wr/gbfs.json",
    city: "Vienna",
    countryCode: "AT",
    preferredLanguages: ["de", "en"],
    reviewedHosts: [
      {
        hostname: "gbfs.nextbike.net",
        pathPrefixes: ["/maps/gbfs/v2/nextbike_wr/"],
      },
    ],
  },
  {
    systemId: "lyft_bay",
    discoveryUrl: "https://gbfs.lyftbikes.com/gbfs/2.3/gbfs.json",
    city: "San Francisco",
    region: "San Francisco Bay Area, California",
    countryCode: "US",
    preferredLanguages: ["en"],
    reviewedHosts: [
      {
        hostname: "gbfs.lyftbikes.com",
        pathPrefixes: ["/gbfs/"],
      },
      {
        hostname: "gbfs.lyft.com",
        pathPrefixes: ["/gbfs/"],
      }
    ],
    licenseOverride: "https://baywheels-assets.s3.amazonaws.com/data-license-agreement.html",
  },
  {
    systemId: "bluebikes",
    discoveryUrl: "https://gbfs.bluebikes.com/gbfs/2.3/gbfs.json",
    city: "Boston",
    region: "Greater Boston, Massachusetts",
    countryCode: "US",
    preferredLanguages: ["en"],
    reviewedHosts: [
      {
        hostname: "gbfs.bluebikes.com",
        pathPrefixes: ["/gbfs/"],
      },
      {
        hostname: "gbfs.lyft.com",
        pathPrefixes: ["/gbfs/"],
      }
    ],
    licenseOverride: "https://bluebikes.com/data-license-agreement",
  },
  {
    systemId: "lyft_chi",
    discoveryUrl: "https://gbfs.divvybikes.com/gbfs/2.3/gbfs.json",
    city: "Chicago",
    region: "Illinois",
    countryCode: "US",
    preferredLanguages: ["en"],
    reviewedHosts: [
      {
        hostname: "gbfs.divvybikes.com",
        pathPrefixes: ["/gbfs/"],
      },
      {
        hostname: "gbfs.lyft.com",
        pathPrefixes: ["/gbfs/"],
      }
    ],
    licenseOverride: "https://divvybikes.com/data-license-agreement",
  },
] as const satisfies readonly GbfsSystemSource[];

export const findInitialGbfsSystem = (
  systemId: string,
): GbfsSystemSource | undefined =>
  INITIAL_GBFS_SYSTEMS.find(
    (source) => source.systemId === systemId.trim().toLowerCase(),
  );
