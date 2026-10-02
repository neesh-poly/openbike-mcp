import type { CatalogSystem } from "../catalog/types";
import type { GbfsSystemSource } from "../gbfs/types";

export const catalogSource = (system: CatalogSystem): GbfsSystemSource => {
  const licenseOverride =
    system.license.url ?? system.license.id ?? system.license.name;
  return {
    systemId: system.system_id,
    name: system.name,
    ...(system.feed_format === undefined ? {} : { format: system.feed_format }),
    discoveryUrl: system.discovery_url,
    reviewedHosts: system.reviewed_hosts.map((hostname) => ({ hostname })),
    ...(system.city === null ? {} : { city: system.city }),
    ...(system.region === null ? {} : { region: system.region }),
    ...(system.country_code === null ? {} : { countryCode: system.country_code }),
    ...(system.preferred_languages.length === 0
      ? {}
      : { preferredLanguages: system.preferred_languages }),
    ...(Object.keys(system.request_headers).length === 0
      ? {}
      : { requestHeaders: system.request_headers }),
    ...(licenseOverride === null ? {} : { licenseOverride }),
  };
};

