export const malformedNonObject = ["not", "an", "envelope"] as const;

export const malformedDiscovery = {
  version: "2.3",
  last_updated: 1_788_263_100,
  ttl: 0,
  data: { en: { unexpected: [] } },
} as const;

export const malformedStationInformation = {
  version: "2.3",
  last_updated: 1_788_263_100,
  ttl: 60,
  data: { stations: "not-an-array" },
} as const;
