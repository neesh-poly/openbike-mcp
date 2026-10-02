import {
  StationSchema, StationStatusSchema, SystemSchema, VehicleTypeSchema,
  type Station, type StationStatus, type Warning,
} from "../contracts";
import { GbfsNormalizationError } from "../gbfs/normalize";
import { withGbfsFeedError } from "../gbfs/errors";
import { FeedTransport, type LoadedDocument } from "../gbfs/transport";
import type { GbfsClientOptions, GbfsFetchState, GbfsStationBundle, GbfsSystemSource } from "../gbfs/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const flag = (value: unknown): boolean | null =>
  value === "true" ? true : value === "false" ? false : null;

const timestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1)
    ? new Date(time).toISOString() : null;
};

export const normalizeTflBikePoints = (
  loaded: LoadedDocument,
  source: GbfsSystemSource,
): GbfsStationBundle => {
  if (!Array.isArray(loaded.document)) {
    throw new GbfsNormalizationError("INVALID_DOCUMENT", "TfL did not return a BikePoint list.");
  }
  const stations: Station[] = [];
  const statuses: StationStatus[] = [];
  const warnings: Warning[] = [];
  let malformed = 0;
  let missingTime = 0;
  const seen = new Set<string>();
  for (const point of loaded.document) {
    if (!isRecord(point) || !Array.isArray(point.additionalProperties)) {
      malformed++;
      continue;
    }
    const properties = new Map(point.additionalProperties.flatMap(property =>
      isRecord(property) && typeof property.key === "string" ? [[property.key, property] as const] : []));
    const value = (key: string) => properties.get(key)?.value;
    const station = StationSchema.safeParse({
      system_id: source.systemId, station_id: point.id, name: point.commonName,
      latitude: point.lat, longitude: point.lon, capacity: count(value("NbDocks")),
      station_type: null, region_id: null, rental_methods: [], rental_uris: null,
    });
    if (!station.success || seen.has(station.data.station_id)) {
      malformed++;
      continue;
    }
    seen.add(station.data.station_id);
    const bikes = count(value("NbBikes"));
    const docks = count(value("NbEmptyDocks"));
    const classic = count(value("NbStandardBikes"));
    const electric = count(value("NbEBikes"));
    const installed = flag(value("Installed"));
    const locked = flag(value("Locked"));
    const enabled = installed === false || locked === true ? false
      : installed === true && locked === false ? true : null;
    // Keep source timestamps. A new HTTP response must not freshen unchanged/old counts.
    const times = ["NbBikes", "NbEmptyDocks", "NbStandardBikes", "NbEBikes"]
      .filter(key => properties.has(key))
      .map(key => timestamp(properties.get(key)?.modified));
    const reported = times.length > 0 && times.every(time => time !== null)
      ? (times as string[]).sort()[0]! : null;
    if (reported === null) missingTime++;
    stations.push(station.data);
    statuses.push(StationStatusSchema.parse({
      system_id: source.systemId, station_id: station.data.station_id,
      observed_at: reported ?? loaded.observation.fetched_at,
      station_last_reported: reported,
      availability: {
        bikes_available: bikes, docks_available: docks,
        vehicle_type_counts: {
          ...(classic === null ? {} : { bike: classic }),
          ...(electric === null ? {} : { ebike: electric }),
        },
        is_installed: installed, is_renting: enabled, is_returning: enabled,
        confidence: bikes !== null && docks !== null && enabled !== null && reported !== null
          ? "high" : bikes !== null || docks !== null ? "medium" : "unavailable",
      },
    }));
  }
  if (malformed > 0) warnings.push({ code: "PARTIAL_RESULTS", system_id: source.systemId,
    message: `${malformed} malformed or duplicate TfL station record(s) were ignored.`, retryable: false });
  if (missingTime > 0) warnings.push({ code: "SOURCE_TIMESTAMP_MISSING", system_id: source.systemId,
    message: `${missingTime} TfL station record(s) lacked a usable source timestamp.`, retryable: false });
  const system = SystemSchema.parse({
    system_id: source.systemId, name: source.name ?? "Santander Cycles", operator: "Transport for London",
    city: source.city ?? "London", region: source.region ?? null, country_code: source.countryCode ?? "GB",
    timezone: "Europe/London", discovery_url: source.discoveryUrl, detected_version: "TfL-BikePoint",
    languages: ["en"], license: source.licenseOverride ?? null,
    capabilities: { docked: true, dockless: false, ebike: true, station_status: true },
  });
  return {
    system, stations, statuses, warnings,
    vehicleTypes: ["bike", "ebike"].map(category => VehicleTypeSchema.parse({
      system_id: source.systemId, vehicle_type_id: category, category, form_factor: "bicycle",
      propulsion_type: category === "bike" ? "human" : "electric_assist", max_range_meters: null,
    })),
    discovery: { version: "TfL-BikePoint", languages: ["en"],
      feeds: { station_information: source.discoveryUrl, station_status: source.discoveryUrl },
      providerLastUpdated: null, ttlSeconds: 60 },
    // Both logical feeds come from this one response; preserve its real validators and hash.
    observations: ["station_information", "station_status"].map(feed_name => ({
      ...loaded.observation, feed_name: feed_name as "station_information" | "station_status", ttl_seconds: 60,
    })),
    state: { station_status: loaded.cached },
  };
};

export class TflClient {
  private readonly transport: FeedTransport;
  constructor(private readonly source: GbfsSystemSource, options: GbfsClientOptions = {}) {
    this.transport = new FeedTransport(source, options);
  }
  async fetchStationBundle(previousState: GbfsFetchState = {}): Promise<GbfsStationBundle> {
    const loaded = await this.transport.loadDocument("station_status", this.source.discoveryUrl, previousState.station_status);
    return withGbfsFeedError("station_status", () => normalizeTflBikePoints(loaded, this.source));
  }
}
