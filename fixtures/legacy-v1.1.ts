/** Synthetic BCycle-shaped legacy edge case; not used as a launch-system seed. */
export const legacyDiscoveryV11 = {
  last_updated: 1_788_263_100,
  ttl: 0,
  version: "1.1",
  data: {
    en: {
      feeds: [
        {
          name: "station_information",
          url: "https://legacy.example.test/station_information.json",
        },
      ],
    },
  },
} as const;

export const legacyStationInformationV11 = {
  last_updated: 1_788_263_100,
  ttl: 300,
  version: "1.1",
  data: {
    stations: [
      {
        station_id: "legacy-1",
        name: "Legacy Station",
        lat: 34.05,
        lon: -118.25,
        _bcycle_station_type: "KIOSK",
        rental_methods: ["CREDITCARD"],
      },
    ],
  },
} as const;

export const legacyStationStatusV11 = {
  last_updated: 1_788_263_100,
  ttl: 60,
  version: "1.1",
  data: {
    stations: [
      {
        station_id: "legacy-1",
        num_bikes_available: 4,
        num_docks_available: 8,
        num_bikes_available_types: { mechanical: 3, "2": 1 },
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
        last_reported: 1_788_263_000,
      },
    ],
  },
} as const;
