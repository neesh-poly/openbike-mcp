import type {
  FeedObservation,
  Station,
  StationStatus,
  System,
  SystemCapabilities,
  VehicleType,
  Warning,
} from "../contracts";
import type {
  ConditionalRequestMetadata,
  FetchLike,
  ResponseMetadata,
} from "../security/fetch-json";
import type { ReviewedHostRule } from "../security/url-policy";

export type GbfsDataFeedName =
  | "manifest"
  | "system_information"
  | "station_information"
  | "station_status"
  | "vehicle_types"
  | "free_bike_status"
  | "vehicle_status"
  | "geofencing_zones";

export type GbfsFetchFeedName = "gbfs" | GbfsDataFeedName;

export type FeedFormat = "gbfs" | "velib" | "tfl";

export interface GbfsSystemSource {
  format?: FeedFormat;
  name?: string;
  systemId: string;
  discoveryUrl: string;
  city?: string;
  region?: string;
  countryCode?: string;
  preferredLanguages?: readonly string[];
  reviewedHosts: readonly ReviewedHostRule[];
  /** Applied to every reviewed host unless a rule overrides the same header. */
  requestHeaders?: Readonly<Record<string, string>>;
  licenseOverride?: string;
}

export interface NormalizedGbfsDiscovery {
  version: string;
  languages: string[];
  feeds: Partial<Record<GbfsDataFeedName, string>>;
  providerLastUpdated: string | null;
  ttlSeconds: number | null;
}

export interface NormalizationResult<T> {
  value: T;
  warnings: Warning[];
}

export interface GbfsNormalizationContext {
  name?: string;
  systemId: string;
  discoveryUrl: string;
  detectedVersion: string;
  fetchedAt: string;
  languages?: readonly string[];
  preferredLanguages?: readonly string[];
  city?: string;
  region?: string;
  countryCode?: string;
  licenseOverride?: string;
  capabilities?: SystemCapabilities;
  vehicleTypes?: readonly VehicleType[];
}

export interface CachedGbfsDocument {
  document: unknown;
  metadata: ResponseMetadata;
  /** Used to avoid sending validators for a previous resource after discovery changes. */
  url?: string;
}

export type GbfsFetchState = Partial<
  Record<GbfsFetchFeedName, CachedGbfsDocument>
>;

export interface GbfsStationBundle {
  discovery: NormalizedGbfsDiscovery;
  system: System;
  stations: Station[];
  statuses: StationStatus[];
  vehicleTypes: VehicleType[];
  warnings: Warning[];
  observations: FeedObservation[];
  state: GbfsFetchState;
}

export interface GbfsClientOptions {
  /** Pure conversion only. Raw documents, validators, and attribution remain intact. */
  adaptDocument?: (feed: GbfsFetchFeedName, document: unknown) => unknown;
  fetcher?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  now?: () => Date;
}

export interface FetchedGbfsDocument {
  document: unknown;
  metadata: ResponseMetadata;
  conditional: ConditionalRequestMetadata;
  fetchedAt: string;
  httpStatus: number;
  url: string;
}
