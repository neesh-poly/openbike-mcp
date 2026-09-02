import type {
  AvailabilityConfidence,
  Freshness,
} from "../contracts/entities";

export interface FreshnessInput {
  providerLastUpdated: string | null;
  stationLastReported: string | null;
  fetchedAt: string;
  ttlSeconds: number;
  maxStalenessSeconds: number;
  now?: Date | number | string;
}

export interface FreshnessEvaluation {
  freshness: Freshness;
  within_max_staleness: boolean;
  source_timestamp_present: boolean;
}

const timestampMilliseconds = (value: Date | number | string): number => {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("Invalid timestamp");
  }
  return milliseconds;
};

export const evaluateFreshness = ({
  providerLastUpdated,
  stationLastReported,
  fetchedAt,
  ttlSeconds,
  maxStalenessSeconds,
  now = Date.now(),
}: FreshnessInput): FreshnessEvaluation => {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
    throw new RangeError("TTL must be a non-negative integer");
  }
  if (!Number.isInteger(maxStalenessSeconds) || maxStalenessSeconds < 0) {
    throw new RangeError("Maximum staleness must be a non-negative integer");
  }

  const sourceTimestamp = stationLastReported ?? providerLastUpdated;
  const observedAt = sourceTimestamp ?? fetchedAt;
  const ageSeconds = Math.max(
    0,
    Math.floor(
      (timestampMilliseconds(now) - timestampMilliseconds(observedAt)) / 1_000,
    ),
  );

  return {
    freshness: {
      provider_last_updated: providerLastUpdated,
      station_last_reported: stationLastReported,
      fetched_at: fetchedAt,
      age_seconds: ageSeconds,
      ttl_seconds: ttlSeconds,
      is_stale: ageSeconds > ttlSeconds,
    },
    within_max_staleness: ageSeconds <= maxStalenessSeconds,
    source_timestamp_present: sourceTimestamp !== null,
  };
};

export interface ConfidenceInput {
  hasUsableStatus: boolean;
  relevantCountKnown: boolean;
  operationalFlagsKnown: boolean;
  freshness: FreshnessEvaluation;
  semanticsAmbiguous?: boolean;
}

export const determineAvailabilityConfidence = ({
  hasUsableStatus,
  relevantCountKnown,
  operationalFlagsKnown,
  freshness,
  semanticsAmbiguous = false,
}: ConfidenceInput): AvailabilityConfidence => {
  if (
    !hasUsableStatus ||
    !relevantCountKnown ||
    !freshness.within_max_staleness
  ) {
    return "unavailable";
  }
  if (freshness.freshness.is_stale || semanticsAmbiguous) {
    return "low";
  }
  if (!operationalFlagsKnown || !freshness.source_timestamp_present) {
    return "medium";
  }
  return "high";
};
