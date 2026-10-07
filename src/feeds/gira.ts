import { StationSchema, StationStatusSchema, SystemSchema, type Station, type StationStatus, type Warning } from "../contracts";
import { withGbfsFeedError } from "../gbfs/errors";
import { GbfsNormalizationError } from "../gbfs/normalize";
import { FeedTransport, type LoadedDocument } from "../gbfs/transport";
import type { GbfsClientOptions, GbfsStationBundle, GbfsSystemSource } from "../gbfs/types";

// Public station collection identified through rt-evil-inc/gira-mais.
// See docs/operations/2026-10-lisbon.md for provenance and timestamp semantics.
export const GIRA_QUERY_URL = "https://firestore.googleapis.com/v1/projects/vaimoorotterdam/databases/(default)/documents:runQuery";
const TENANT = "P1/EML/EML/";
const DOCUMENT_PREFIX = "projects/vaimoorotterdam/databases/(default)/documents/docking-stations/";
const MAX_STATIONS = 1_000;
const OPEN = new Set(["AVAILABLE", "IN_USE", "LIMITED_USE"]);
const CLOSED = new Set(["DISABLED", "UNAVAILABLE_BY_SYSTEM", "UNAVAILABLE_BY_OPERATOR", "UNKNOWN"]);
const QUERY = { structuredQuery: {
  from: [{ collectionId: "docking-stations" }],
  where: { fieldFilter: { field: { fieldPath: "Tenant" }, op: "EQUAL", value: { stringValue: TENANT } } },
  // One extra result detects truncation instead of publishing an incomplete city.
  limit: MAX_STATIONS + 1,
} };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => {
  if (!record(value) || typeof value.integerValue !== "string" || !/^\d+$/.test(value.integerValue)) return null;
  const parsed = Number(value.integerValue);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const text = (value: unknown): string | null =>
  record(value) && typeof value.stringValue === "string" ? value.stringValue : null;
const bool = (value: unknown): boolean | null =>
  record(value) && typeof value.booleanValue === "boolean" ? value.booleanValue : null;
const timestamp = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) ? new Date(time).toISOString() : null;
};
const invalid = (message: string): never => { throw new GbfsNormalizationError("INVALID_DOCUMENT", message); };

export function normalizeGiraStations(loaded: LoadedDocument, source: GbfsSystemSource): GbfsStationBundle {
  if (!Array.isArray(loaded.document)) return invalid("GIRA did not return a station query result.");
  const rows = loaded.document;
  if (rows.some(row => !record(row) || row.error || row.skippedResults)) return invalid("GIRA returned an incomplete query.");
  const documents = rows.filter(row => row.document !== undefined);
  if (!documents.length || documents.length > MAX_STATIONS) return invalid("GIRA station inventory is empty or exceeds its limit.");
  const times = rows.map(row => timestamp(row.readTime));
  if (times.some(time => time === null || Date.parse(time) > Date.parse(loaded.observation.fetched_at) + 60_000)) {
    return invalid("GIRA query has a missing or invalid read timestamp.");
  }
  const readTime = (times as string[]).sort()[0]!;
  const stations: Station[] = [];
  const statuses: StationStatus[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let unknownStatus = 0;
  for (const row of documents) {
    const doc: unknown = row.document;
    if (!record(doc) || !record(doc.fields) || typeof doc.name !== "string" || !doc.name.startsWith(DOCUMENT_PREFIX)) {
      malformed++;
      continue;
    }
    const f = doc.fields;
    // The database is shared by multiple operators. Never accept another tenant.
    if (text(f.Tenant) !== TENANT) return invalid("GIRA query included an unexpected tenant.");
    if (bool(f.IsVirtual) === true) continue;
    const location = record(f.Location) && record(f.Location.geoPointValue) ? f.Location.geoPointValue : {};
    const id = count(f.DockingStationId);
    // Reviewed 2026-10-07: 4552 is "999 - Oficina", the maintenance workshop
    // (177 bikes, two docks), not a public pickup/return station.
    if (id === 4552) continue;
    const station = StationSchema.safeParse({
      system_id: source.systemId, station_id: id === null ? null : String(id), name: text(f.Name),
      latitude: location.latitude, longitude: location.longitude, capacity: count(f.DockLimit),
      station_type: null, region_id: null, rental_methods: [], rental_uris: null,
    });
    if (!station.success || seen.has(station.data.station_id)) { malformed++; continue; }
    seen.add(station.data.station_id);
    const state = text(f.ServiceStatus) ?? "";
    // ServiceStatus controls availability in the official app; IsActive is not that flag.
    // Fail closed for a new status rather than treating every unknown value as open.
    const enabled = OPEN.has(state) ? true : CLOSED.has(state) ? false : null;
    if (enabled === null) unknownStatus++;
    const bikes = count(f.AvailableBikes);
    const free = count(f.FreeDocks);
    const docks = free !== null && station.data.capacity !== null && free > station.data.capacity ? null : free;
    stations.push(station.data);
    statuses.push(StationStatusSchema.parse({
      system_id: source.systemId, station_id: station.data.station_id,
      observed_at: readTime, station_last_reported: null,
      availability: {
        bikes_available: bikes, docks_available: docks, vehicle_type_counts: {},
        is_installed: bool(f.IsVirtual) === false ? true : null,
        is_renting: enabled, is_returning: enabled,
        confidence: bikes !== null || docks !== null ? "medium" : "unavailable",
      },
    }));
  }
  if (!stations.length) return invalid("GIRA returned no valid physical stations.");
  const warnings: Warning[] = [{ code: "SOURCE_TIMESTAMP_MISSING", system_id: source.systemId, retryable: false,
    message: "GIRA exposes a strongly consistent database read time, not station telemetry timestamps. Freshness describes that database snapshot; bike type counts are not published." }];
  if (malformed || unknownStatus) warnings.push({ code: "PARTIAL_RESULTS", system_id: source.systemId, retryable: false,
    message: `${malformed} malformed or duplicate GIRA record(s) ignored; ${unknownStatus} station(s) have unknown service status.` });
  return {
    system: SystemSchema.parse({
      system_id: source.systemId, name: source.name ?? "GIRA", operator: "EMEL",
      city: source.city ?? "Lisbon", region: source.region ?? null, country_code: source.countryCode ?? "PT",
      timezone: "Europe/Lisbon", discovery_url: source.discoveryUrl, detected_version: "GIRA-Firestore",
      languages: ["pt"], license: source.licenseOverride ?? null,
      capabilities: { docked: true, dockless: false, ebike: true, station_status: true },
    }),
    stations, statuses, vehicleTypes: [], warnings,
    discovery: { version: "GIRA-Firestore", languages: ["pt"],
      feeds: { station_information: source.discoveryUrl, station_status: source.discoveryUrl },
      providerLastUpdated: readTime, ttlSeconds: 60 },
    // updateTime records a change, not a heartbeat. Keep it in the raw cached
    // document; never substitute a local fetch time for the server's readTime.
    observations: ["station_information", "station_status"].map(feed_name => ({
      ...loaded.observation, feed_name: feed_name as "station_information" | "station_status",
      provider_last_updated: readTime, ttl_seconds: 60,
    })),
    state: { station_status: loaded.cached },
  };
}

export class GiraClient {
  private readonly transport: FeedTransport;
  constructor(private readonly source: GbfsSystemSource, options: GbfsClientOptions = {}) {
    // Fixed collection and fixed read-only query: no caller-supplied Firestore access.
    if (source.discoveryUrl !== GIRA_QUERY_URL) invalid("Unreviewed GIRA query endpoint.");
    this.transport = new FeedTransport(source, options);
  }
  async fetchStationBundle(): Promise<GbfsStationBundle> {
    const loaded = await this.transport.loadDocument("station_status", this.source.discoveryUrl, undefined, QUERY);
    return withGbfsFeedError("station_status", () => normalizeGiraStations(loaded, this.source));
  }
}
