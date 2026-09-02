import type { Station } from "../contracts/entities";

const EARTH_MEAN_RADIUS_METERS = 6_371_008.8;

export interface Coordinate {
  latitude: number;
  longitude: number;
}

const assertCoordinate = ({ latitude, longitude }: Coordinate): void => {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new RangeError("Invalid WGS84 coordinate");
  }
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const haversineDistanceMeters = (
  origin: Coordinate,
  destination: Coordinate,
): number => {
  assertCoordinate(origin);
  assertCoordinate(destination);

  const latitudeDelta = toRadians(destination.latitude - origin.latitude);
  const longitudeDelta = toRadians(
    destination.longitude - origin.longitude,
  );
  const originLatitude = toRadians(origin.latitude);
  const destinationLatitude = toRadians(destination.latitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) *
      Math.cos(destinationLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    EARTH_MEAN_RADIUS_METERS *
    Math.asin(Math.min(1, Math.sqrt(haversine)))
  );
};

export const distanceToStationMeters = (
  origin: Coordinate,
  station: Pick<Station, "latitude" | "longitude">,
): number => haversineDistanceMeters(origin, station);

export const isWithinRadius = (
  origin: Coordinate,
  destination: Coordinate,
  radiusMeters: number,
): boolean => {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError("Radius must be a finite non-negative number");
  }
  return haversineDistanceMeters(origin, destination) <= radiusMeters;
};
