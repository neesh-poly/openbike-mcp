import type { Station, StationStatus } from "../contracts/entities";
import type { Warning } from "../contracts/warnings";

export interface JoinedStation {
  station: Station;
  status?: StationStatus;
}

export interface StationJoinResult {
  stations: JoinedStation[];
  warnings: Warning[];
}

const stationKey = (systemId: string, stationId: string): string =>
  `${systemId}\u0000${stationId}`;

const isNewer = (candidate: StationStatus, current: StationStatus): boolean =>
  Date.parse(candidate.observed_at) > Date.parse(current.observed_at);

export const joinStationsWithStatus = (
  stations: readonly Station[],
  statuses: readonly StationStatus[],
  maxWarnings = 100,
): StationJoinResult => {
  if (!Number.isInteger(maxWarnings) || maxWarnings < 1) {
    throw new RangeError("maxWarnings must be a positive integer");
  }

  const warnings: Warning[] = [];
  let warningsDropped = 0;
  const addWarning = (warning: Warning): void => {
    if (warnings.length < maxWarnings) {
      warnings.push(warning);
    } else {
      warningsDropped += 1;
    }
  };

  const statusByStation = new Map<string, StationStatus>();
  for (const status of statuses) {
    const key = stationKey(status.system_id, status.station_id);
    const previous = statusByStation.get(key);
    if (previous !== undefined) {
      addWarning({
        code: "DUPLICATE_STATION_STATUS",
        message: "Multiple status records were supplied; the newest observation was used.",
        system_id: status.system_id,
        station_id: status.station_id,
        retryable: false,
      });
      if (isNewer(status, previous)) {
        statusByStation.set(key, status);
      }
    } else {
      statusByStation.set(key, status);
    }
  }

  const knownStationKeys = new Set(
    stations.map((station) => stationKey(station.system_id, station.station_id)),
  );

  for (const status of statusByStation.values()) {
    if (!knownStationKeys.has(stationKey(status.system_id, status.station_id))) {
      addWarning({
        code: "ORPHAN_STATION_STATUS",
        message: "A status record had no matching station-information record.",
        system_id: status.system_id,
        station_id: status.station_id,
        retryable: false,
      });
    }
  }

  const joined = stations.map((station): JoinedStation => {
    const status = statusByStation.get(
      stationKey(station.system_id, station.station_id),
    );
    if (status === undefined) {
      addWarning({
        code: "MISSING_STATION_STATUS",
        message: "A station had no matching live status record.",
        system_id: station.system_id,
        station_id: station.station_id,
        retryable: true,
      });
      return { station };
    }
    return { station, status };
  });

  if (warningsDropped > 0) {
    const truncationWarning: Warning = {
      code: "WARNINGS_TRUNCATED",
      message: "Additional normalization warnings were omitted from this response.",
      retryable: false,
    };
    warnings[warnings.length - 1] = truncationWarning;
  }

  return { stations: joined, warnings };
};
