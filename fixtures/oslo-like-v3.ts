/** Synthetic v3 fixture exercising localized strings and RFC 3339 timestamps. */
export const osloLikeDiscoveryV3 = {
  last_updated: "2026-09-02T14:30:00Z",
  ttl: 0,
  version: "3.0",
  data: {
    feeds: [
      {
        name: "system_information",
        url: "https://api.example.test/mobility/oslo/system_information",
      },
      {
        name: "station_information",
        url: "https://api.example.test/mobility/oslo/station_information",
      },
      {
        name: "station_status",
        url: "https://api.example.test/mobility/oslo/station_status",
      },
      {
        name: "vehicle_types",
        url: "https://api.example.test/mobility/oslo/vehicle_types",
      },
      {
        name: "vehicle_status",
        url: "https://api.example.test/mobility/oslo/vehicle_status",
      },
    ],
  },
} as const;

export const osloLikeSystemInformationV3 = {
  last_updated: "2026-09-02T14:30:00Z",
  ttl: 86_400,
  version: "3.0",
  data: {
    system_id: "synthetic_oslo",
    languages: ["nb", "en"],
    name: [
      { text: "Eksempel bysykkel", language: "nb" },
      { text: "Example City Bike", language: "en" },
    ],
    operator: [
      { text: "Eksempel Mobilitet", language: "nb" },
      { text: "Example Mobility", language: "en" },
    ],
    timezone: "Europe/Oslo",
    license_id: "NLOD-2.0",
  },
} as const;

export const osloLikeStationInformationV3 = {
  last_updated: "2026-09-02T14:30:00Z",
  ttl: 3_600,
  version: "3.0",
  data: {
    stations: [
      {
        station_id: "oslo-001",
        name: [
          { text: "Eksempelplassen", language: "nb" },
          { text: "Example Square", language: "en" },
        ],
        lat: 59.913,
        lon: 10.752,
        capacity: 24,
        rental_methods: ["KEY", "TRANSITCARD"],
      },
    ],
  },
} as const;

export const osloLikeStationStatusV3 = {
  last_updated: "2026-09-02T14:30:00Z",
  ttl: 10,
  version: "3.0",
  data: {
    stations: [
      {
        station_id: "oslo-001",
        num_vehicles_available: 7,
        num_docks_available: 17,
        vehicle_types_available: [
          { vehicle_type_id: "oslo-classic", count: 5 },
          { vehicle_type_id: "oslo-electric", count: 2 },
        ],
        is_installed: true,
        is_renting: true,
        is_returning: true,
        last_reported: "2026-09-02T14:29:55Z",
      },
    ],
  },
} as const;

export const osloLikeVehicleTypesV3 = {
  last_updated: "2026-09-02T14:30:00Z",
  ttl: 3_600,
  version: "3.0",
  data: {
    vehicle_types: [
      {
        vehicle_type_id: "oslo-classic",
        form_factor: "bicycle",
        propulsion_type: "human",
      },
      {
        vehicle_type_id: "oslo-electric",
        form_factor: "bicycle",
        propulsion_type: "electric_assist",
        max_range_meters: 45_000,
      },
    ],
  },
} as const;
