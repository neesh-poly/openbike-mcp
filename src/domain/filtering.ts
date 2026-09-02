import type {
  Availability,
  Freshness,
  Station,
  StationStatus,
  VehicleCategory,
} from "../contracts/entities";
import type { AvailabilityMode } from "../contracts/tools";
import type { JoinedStation } from "./join";
import { matchesSearchText } from "./search";

export interface AvailabilityCandidate {
  station: Station;
  status: StationStatus;
  freshness: Freshness;
  distance_meters: number;
}

export interface NearbySelectionOptions {
  mode: AvailabilityMode;
  radiusMeters: number;
  minimumAvailable: number;
  maxStalenessSeconds: number;
  includeUnavailable: boolean;
  vehicleTypes?: readonly VehicleCategory[];
  systemIds?: readonly string[];
}

export interface StationSearchCandidate extends JoinedStation {
  distance_meters: number;
}

export interface StationSearchFilterOptions {
  radiusMeters: number;
  operationalOnly: boolean;
  query?: string;
  systemIds?: readonly string[];
}

export const compatibleBikesAvailable = (
  availability: Availability,
  vehicleTypes: readonly VehicleCategory[] = [],
): number | null => {
  if (vehicleTypes.length === 0) {
    return availability.bikes_available;
  }

  let total = 0;
  for (const category of vehicleTypes) {
    const count = availability.vehicle_type_counts[category];
    if (count === undefined) {
      return null;
    }
    total += count;
  }
  return total;
};

export const relevantAvailabilityCount = (
  availability: Availability,
  mode: AvailabilityMode,
  vehicleTypes: readonly VehicleCategory[] = [],
): number | null => {
  if (mode === "take") {
    return compatibleBikesAvailable(availability, vehicleTypes);
  }
  if (mode === "return") {
    return availability.docks_available;
  }

  // "Either" is only available when the count and the corresponding
  // operational direction agree. Keeping these paired prevents a disabled
  // rental side from borrowing the return-side flag (and vice versa).
  const bikes =
    availability.is_renting === true
      ? compatibleBikesAvailable(availability, vehicleTypes)
      : null;
  const docks =
    availability.is_returning === true
      ? availability.docks_available
      : null;
  if (bikes === null && docks === null) {
    return null;
  }
  return Math.max(bikes ?? 0, docks ?? 0);
};

export const isOperationalForMode = (
  availability: Availability,
  mode: AvailabilityMode,
): boolean => {
  if (availability.is_installed !== true) {
    return false;
  }
  if (mode === "take") {
    return availability.is_renting === true;
  }
  if (mode === "return") {
    return availability.is_returning === true;
  }
  return (
    availability.is_renting === true || availability.is_returning === true
  );
};

export const isViableAvailabilityCandidate = (
  candidate: AvailabilityCandidate,
  options: NearbySelectionOptions,
): boolean => {
  const availability = candidate.status.availability;
  const count = relevantAvailabilityCount(
    availability,
    options.mode,
    options.vehicleTypes,
  );
  return (
    candidate.freshness.age_seconds <= options.maxStalenessSeconds &&
    isOperationalForMode(availability, options.mode) &&
    count !== null &&
    count >= options.minimumAvailable
  );
};

export const filterNearbyCandidates = (
  candidates: readonly AvailabilityCandidate[],
  options: NearbySelectionOptions,
): AvailabilityCandidate[] => {
  const allowedSystems =
    options.systemIds === undefined ? null : new Set(options.systemIds);

  return candidates.filter((candidate) => {
    if (
      candidate.distance_meters > options.radiusMeters ||
      (allowedSystems !== null &&
        !allowedSystems.has(candidate.station.system_id)) ||
      candidate.freshness.age_seconds > options.maxStalenessSeconds
    ) {
      return false;
    }
    return (
      options.includeUnavailable ||
      isViableAvailabilityCandidate(candidate, options)
    );
  });
};

const stationIsOperational = (joined: JoinedStation): boolean => {
  const availability = joined.status?.availability;
  return (
    availability?.is_installed === true &&
    (availability.is_renting === true || availability.is_returning === true)
  );
};

export const filterStationSearchCandidates = (
  candidates: readonly StationSearchCandidate[],
  options: StationSearchFilterOptions,
): StationSearchCandidate[] => {
  const allowedSystems =
    options.systemIds === undefined ? null : new Set(options.systemIds);
  return candidates.filter((candidate) => {
    if (
      candidate.distance_meters > options.radiusMeters ||
      (allowedSystems !== null &&
        !allowedSystems.has(candidate.station.system_id))
    ) {
      return false;
    }
    if (
      options.query !== undefined &&
      !matchesSearchText(candidate.station.name, options.query)
    ) {
      return false;
    }
    return !options.operationalOnly || stationIsOperational(candidate);
  });
};
