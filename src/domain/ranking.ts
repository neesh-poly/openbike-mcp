import type { AvailabilityCandidate, NearbySelectionOptions } from "./filtering";
import {
  filterNearbyCandidates,
  isViableAvailabilityCandidate,
  relevantAvailabilityCount,
} from "./filtering";

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const deterministicIdentityOrder = (
  left: AvailabilityCandidate,
  right: AvailabilityCandidate,
): number =>
  compareText(left.station.system_id, right.station.system_id) ||
  compareText(left.station.station_id, right.station.station_id);

export const rankNearbyCandidates = (
  candidates: readonly AvailabilityCandidate[],
  options: NearbySelectionOptions,
): AvailabilityCandidate[] =>
  [...candidates].sort((left, right) => {
    if (options.includeUnavailable) {
      const viabilityDelta =
        Number(isViableAvailabilityCandidate(right, options)) -
        Number(isViableAvailabilityCandidate(left, options));
      if (viabilityDelta !== 0) return viabilityDelta;
    }

    if (options.mode !== "either") {
      const leftCount = relevantAvailabilityCount(
        left.status.availability,
        options.mode,
        options.vehicleTypes,
      );
      const rightCount = relevantAvailabilityCount(
        right.status.availability,
        options.mode,
        options.vehicleTypes,
      );
      const countDelta = (rightCount ?? -1) - (leftCount ?? -1);
      if (countDelta !== 0) return countDelta;
    }

    const distanceDelta = left.distance_meters - right.distance_meters;
    if (distanceDelta !== 0) return distanceDelta;
    return deterministicIdentityOrder(left, right);
  });

export const selectNearbyCandidates = (
  candidates: readonly AvailabilityCandidate[],
  options: NearbySelectionOptions,
  limit: number,
): AvailabilityCandidate[] => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Limit must be a positive integer");
  }
  return rankNearbyCandidates(
    filterNearbyCandidates(candidates, options),
    options,
  ).slice(0, limit);
};
