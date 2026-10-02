import { haversineDistanceMeters } from "../domain/distance";
import type {
  CatalogBounds,
  CatalogCandidate,
  CatalogSearchInput,
  CatalogSnapshot,
  CatalogSystem,
} from "./types";

const normalize = (value: string): string =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US").trim();

const longitudeInBounds = (
  longitude: number,
  bounds: CatalogBounds,
): boolean =>
  bounds.west <= bounds.east
    ? longitude >= bounds.west && longitude <= bounds.east
    : longitude >= bounds.west || longitude <= bounds.east;

export const coordinateInBounds = (
  latitude: number,
  longitude: number,
  bounds: CatalogBounds,
): boolean =>
  latitude >= bounds.south &&
  latitude <= bounds.north &&
  longitudeInBounds(longitude, bounds);

const approximateDistanceToBoundsMeters = (
  latitude: number,
  longitude: number,
  bounds: CatalogBounds,
): number => {
  if (coordinateInBounds(latitude, longitude, bounds)) {
    return 0;
  }

  const clampedLatitude = Math.max(
    bounds.south,
    Math.min(bounds.north, latitude),
  );
  let clampedLongitude = longitude;
  if (!longitudeInBounds(longitude, bounds)) {
    const distanceWest = Math.abs(longitude - bounds.west);
    const distanceEast = Math.abs(longitude - bounds.east);
    clampedLongitude = distanceWest <= distanceEast ? bounds.west : bounds.east;
  }
  return haversineDistanceMeters(
    { latitude, longitude },
    { latitude: clampedLatitude, longitude: clampedLongitude },
  );
};

const metadataMatches = (system: CatalogSystem, rawQuery: string): boolean => {
  const query = normalize(rawQuery);
  if (query.length === 0) return true;
  return [
    system.system_id,
    system.source_system_id,
    system.name,
    system.operator,
    system.city,
    system.region,
    system.country_code,
  ].some((value) => value !== null && normalize(value).includes(query));
};

export const getCatalogSystem = (
  catalog: CatalogSnapshot,
  systemId: string,
): CatalogSystem | undefined => {
  const normalizedId = normalize(systemId);
  return catalog.systems.find(
    (system) =>
      system.system_id === normalizedId ||
      normalize(system.source_system_id) === normalizedId,
  );
};

export const findCatalogSystems = (
  catalog: CatalogSnapshot,
  input: CatalogSearchInput = {},
): CatalogCandidate[] => {
  const hasLatitude = input.latitude !== undefined;
  const hasLongitude = input.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    throw new RangeError("Latitude and longitude must be supplied together");
  }
  if (
    hasLatitude &&
    (input.latitude! < -90 ||
      input.latitude! > 90 ||
      input.longitude! < -180 ||
      input.longitude! > 180 ||
      !Number.isFinite(input.latitude) ||
      !Number.isFinite(input.longitude))
  ) {
    throw new RangeError("Invalid WGS84 coordinate");
  }
  if (
    input.radiusMeters !== undefined &&
    (!Number.isFinite(input.radiusMeters) || input.radiusMeters < 0)
  ) {
    throw new RangeError("Radius must be a finite non-negative number");
  }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
  const explicitIds = new Set(
    (input.systemIds ?? []).map((systemId) => normalize(systemId)),
  );
  const hasCoordinate = hasLatitude && hasLongitude;
  const radiusMeters = Math.max(0, input.radiusMeters ?? 25_000);
  const countryCode = input.countryCode?.trim().toUpperCase();

  const candidates: CatalogCandidate[] = [];
  for (const system of catalog.systems) {
    if (!system.enabled) continue;
    if (countryCode !== undefined && system.country_code !== countryCode) continue;
    if (input.query !== undefined && !metadataMatches(system, input.query)) continue;

    const explicitlyMatched =
      explicitIds.size > 0 &&
      (explicitIds.has(system.system_id) ||
        explicitIds.has(normalize(system.source_system_id)));
    if (explicitIds.size > 0 && !explicitlyMatched) continue;

    let distanceMeters: number | null = null;
    if (hasCoordinate) {
      const latitude = input.latitude as number;
      const longitude = input.longitude as number;
      const { bounds, centroid, buffer_meters: bufferMeters } = system.coverage;
      if (bounds !== null) {
        distanceMeters = approximateDistanceToBoundsMeters(
          latitude,
          longitude,
          bounds,
        );
      } else if (centroid !== null) {
        distanceMeters = haversineDistanceMeters(
          { latitude, longitude },
          centroid,
        );
      }

      if (
        !explicitlyMatched &&
        (distanceMeters === null || distanceMeters > radiusMeters + bufferMeters)
      ) {
        continue;
      }
    }

    candidates.push({
      system,
      distance_meters:
        distanceMeters === null ? null : Math.round(distanceMeters),
      matched_by: explicitlyMatched
        ? "explicit"
        : hasCoordinate
          ? "coverage"
          : "metadata",
    });
  }

  return candidates
    .sort((left, right) => {
      if (left.matched_by !== right.matched_by) {
        if (left.matched_by === "explicit") return -1;
        if (right.matched_by === "explicit") return 1;
      }
      if (left.distance_meters !== right.distance_meters) {
        if (left.distance_meters === null) return 1;
        if (right.distance_meters === null) return -1;
        return left.distance_meters - right.distance_meters;
      }
      return left.system.system_id.localeCompare(right.system.system_id);
    })
    .slice(0, limit);
};

export const getSystemFeedStub = (
  env: Pick<Env, "SYSTEM_FEEDS">,
  system: Pick<CatalogSystem, "system_id" | "location_hint">,
) =>
  env.SYSTEM_FEEDS.getByName(system.system_id, {
    locationHint: system.location_hint,
  });
