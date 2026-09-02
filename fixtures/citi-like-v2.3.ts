/** Synthetic, minimized fixture. It is not a copy of Citi Bike's raw dataset. */
export const citiLikeDiscoveryV23 = {
  last_updated: 1_788_263_100,
  ttl: 0,
  version: "2.3",
  data: {
    en: {
      feeds: [
        {
          name: "system_information",
          url: "https://gbfs.example.test/gbfs/2.3/nyc/en/system_information.json",
        },
        {
          name: "station_information",
          url: "https://gbfs.example.test/gbfs/2.3/nyc/en/station_information.json",
        },
        {
          name: "station_status",
          url: "https://gbfs.example.test/gbfs/2.3/nyc/en/station_status.json",
        },
        {
          name: "vehicle_types",
          url: "https://gbfs.example.test/gbfs/2.3/nyc/en/vehicle_types.json",
        },
        {
          name: "free_bike_status",
          url: "https://gbfs.example.test/gbfs/2.3/nyc/en/free_bike_status.json",
        },
      ],
    },
  },
} as const;

export const citiLikeSystemInformationV23 = {
  last_updated: 1_788_263_100,
  ttl: 86_400,
  version: "2.3",
  data: {
    system_id: "synthetic_nyc",
    language: "en",
    name: "Synthetic City Bike",
    operator: "Example Mobility",
    timezone: "America/New_York",
    license_url: "https://example.test/data-policy",
  },
} as const;

export const citiLikeStationInformationV23 = {
  last_updated: 1_788_263_100,
  ttl: 86_400,
  version: "2.3",
  data: {
    stations: [
      {
        station_id: "nyc-001",
        name: "Canal St & Example Ave",
        lat: 40.719,
        lon: -74.001,
        capacity: 31,
        region_id: "manhattan",
        rental_methods: ["KEY", "CREDITCARD"],
        rental_uris: { web: "https://example.test/rent/nyc-001" },
      },
      {
        station_id: "nyc-002",
        name: "Example Plaza",
        lat: 40.721,
        lon: -73.997,
        capacity: 18,
        is_virtual_station: true,
        rental_methods: ["KEY"],
      },
    ],
  },
} as const;

export const citiLikeStationStatusV23 = {
  last_updated: 1_788_263_100,
  ttl: 5,
  version: "2.3",
  data: {
    stations: [
      {
        station_id: "nyc-001",
        num_bikes_available: 9,
        num_docks_available: 21,
        vehicle_types_available: [
          { vehicle_type_id: "classic", count: 6 },
          { vehicle_type_id: "electric", count: 3 },
        ],
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
        last_reported: 1_788_263_090,
      },
      {
        station_id: "nyc-002",
        num_bikes_available: 2,
        num_docks_available: 16,
        vehicle_types_available: [
          { vehicle_type_id: "electric", count: 2 },
        ],
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
        last_reported: 1_788_263_080,
      },
    ],
  },
} as const;

export const citiLikeVehicleTypesV23 = {
  last_updated: 1_788_263_100,
  ttl: 86_400,
  version: "2.3",
  data: {
    vehicle_types: [
      {
        vehicle_type_id: "classic",
        form_factor: "bicycle",
        propulsion_type: "human",
      },
      {
        vehicle_type_id: "electric",
        form_factor: "bicycle",
        propulsion_type: "electric_assist",
      },
    ],
  },
} as const;
