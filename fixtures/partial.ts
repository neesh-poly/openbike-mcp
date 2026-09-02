export const partialStationInformationV23 = {
  last_updated: 1_788_263_100,
  ttl: 60,
  version: "2.3",
  data: {
    stations: [
      {
        station_id: "partial-good",
        name: "Station Without Capacity",
        lat: 49.28,
        lon: -123.12,
        rental_uris: {
          web: "https://example.test/station/partial-good",
          android: "http://insecure.example.test/not-retained",
        },
      },
      {
        station_id: "partial-invalid",
        name: "Invalid Coordinate",
        lat: 999,
        lon: -123.1,
      },
      null,
    ],
  },
} as const;

export const partialStationStatusV23 = {
  last_updated: 1_788_263_100,
  ttl: 10,
  version: "2.3",
  data: {
    stations: [
      {
        station_id: "partial-good",
        num_bikes_available: 2,
        num_docks_available: 4,
        is_renting: 1,
        last_reported: 0,
      },
      { station_id: "status-only-flags", is_installed: 1, is_renting: 0 },
      { num_bikes_available: 4 },
    ],
  },
} as const;
