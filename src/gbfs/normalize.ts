import {
  StationSchema,
  StationStatusSchema,
  SystemSchema,
  VehicleTypeSchema,
  type Station,
  type StationStatus,
  type System,
  type VehicleCategory,
  type VehicleType,
  type Warning,
  type WarningCode,
} from "../contracts";
import type {
  GbfsDataFeedName,
  GbfsNormalizationContext,
  NormalizationResult,
  NormalizedGbfsDiscovery,
} from "./types";

type JsonRecord = Record<string, unknown>;

const SUPPORTED_FEEDS = new Set<GbfsDataFeedName>([
  "manifest",
  "system_information",
  "station_information",
  "station_status",
  "vehicle_types",
  "free_bike_status",
  "vehicle_status",
  "geofencing_zones",
]);

const KNOWN_UNUSED_FEEDS = new Set([
  "gbfs",
  "gbfs_versions",
  "system_alerts",
  "system_calendar",
  "system_hours",
  "system_pricing_plans",
  "system_regions",
]);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonnegativeInteger = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  Number.isSafeInteger(value) &&
  value >= 0
    ? value
    : null;

const optionalString = (value: unknown, maxLength = 500): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maxLength);
};

const stableId = (value: unknown, maxLength: number): string | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value).slice(0, maxLength);
  }
  return optionalString(value, maxLength);
};

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

const normalizeLanguage = (value: string): string => value.trim().toLowerCase();

const localizedText = (
  value: unknown,
  preferredLanguages: readonly string[] = [],
  maxLength = 500,
): string | null => {
  const direct = optionalString(value, maxLength);
  if (direct !== null) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const translations = value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const text = optionalString(item.text, maxLength);
    const language = optionalString(item.language, 64);
    return text === null ? [] : [{ text, language: language?.toLowerCase() }];
  });
  if (translations.length === 0) {
    return null;
  }

  for (const preferred of [...preferredLanguages, "en"]) {
    const normalizedPreferred = normalizeLanguage(preferred);
    const match = translations.find(
      ({ language }) => language === normalizedPreferred,
    );
    if (match !== undefined) {
      return match.text;
    }
  }
  return translations[0]?.text ?? null;
};

const toRfc3339 = (
  value: unknown,
  rejectBeforeYear2000 = false,
): string | null => {
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value * 1_000;
  } else if (typeof value === "string" && value.trim().length > 0) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime()) || (rejectBeforeYear2000 && date.getUTCFullYear() < 2000)) {
    return null;
  }
  return date.toISOString();
};

const booleanish = (value: unknown): boolean | null => {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  return null;
};

const makeWarning = (
  code: WarningCode,
  message: string,
  systemId: string,
  retryable = false,
): Warning => ({
  code,
  message,
  system_id: systemId,
  retryable,
});

export type GbfsNormalizationErrorCode =
  | "INVALID_DOCUMENT"
  | "UNSUPPORTED_VERSION"
  | "MISSING_REQUIRED_FEED";

/** Safe, payload-free normalization failure. */
export class GbfsNormalizationError extends Error {
  readonly code: GbfsNormalizationErrorCode;
  readonly retryable: boolean;

  constructor(
    code: GbfsNormalizationErrorCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "GbfsNormalizationError";
    this.code = code;
    this.retryable = retryable;
  }
}

const documentRecord = (document: unknown): JsonRecord => {
  if (!isRecord(document)) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS feed did not contain a JSON object.",
    );
  }
  return document;
};

const supportedVersion = (version: string): boolean =>
  /^1\.(?:0|1)(?:\.\d+)?$/.test(version) || /^2\.(?:1|2|3)(?:\.\d+)?$/.test(version) || /^3(?:\.\d+)+$/.test(version);

const feedVersion = (
  document: JsonRecord,
  fallbackVersion: string | undefined,
  allowLegacyV1 = false,
): string => {
  const version = optionalString(document.version, 32) ?? fallbackVersion;
  if (version === undefined || version.length === 0) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS feed did not declare a version.",
    );
  }
  if (!supportedVersion(version) && !(allowLegacyV1 && /^1\.1(?:\.\d+)?$/.test(version))) {
    throw new GbfsNormalizationError(
      "UNSUPPORTED_VERSION",
      "The GBFS feed version is not supported.",
    );
  }
  return version;
};

const dataRecord = (document: JsonRecord): JsonRecord => {
  if (!isRecord(document.data)) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS feed did not contain a data object.",
    );
  }
  return document.data;
};

export interface GbfsEnvelopeMetadata {
  version: string | null;
  providerLastUpdated: string | null;
  ttlSeconds: number | null;
}

export const readGbfsEnvelopeMetadata = (
  document: unknown,
): GbfsEnvelopeMetadata => {
  if (!isRecord(document)) {
    return { version: null, providerLastUpdated: null, ttlSeconds: null };
  }
  return {
    version: optionalString(document.version, 32),
    providerLastUpdated: toRfc3339(document.last_updated),
    ttlSeconds: nonnegativeInteger(document.ttl),
  };
};

const validHttpsUrl = (value: unknown): string | null => {
  const stringValue = optionalString(value, 4_096);
  if (stringValue === null) {
    return null;
  }
  try {
    const url = new URL(stringValue);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

export const normalizeDiscovery = (
  document: unknown,
  options: { systemId: string; preferredLanguages?: readonly string[] },
): NormalizationResult<NormalizedGbfsDiscovery> => {
  const root = documentRecord(document);
  const version = feedVersion(root, undefined);
  const data = dataRecord(root);
  const preferredLanguages = options.preferredLanguages ?? [];
  let feedItems: unknown[] | null = null;
  let languages: string[] = [];

  if (Array.isArray(data.feeds)) {
    feedItems = data.feeds;
  } else {
    const languageEntries = Object.entries(data).filter(
      (entry): entry is [string, JsonRecord] =>
        isRecord(entry[1]) && Array.isArray(entry[1].feeds),
    );
    languages = languageEntries.map(([language]) => language);
    const languageOrder = uniqueStrings([
      ...preferredLanguages,
      "en",
      ...languages,
    ]).map(normalizeLanguage);
    const selected = languageOrder
      .map((language) =>
        languageEntries.find(
          ([candidate]) => normalizeLanguage(candidate) === language,
        ),
      )
      .find((entry) => entry !== undefined);
    if (selected !== undefined && Array.isArray(selected[1].feeds)) {
      feedItems = selected[1].feeds;
    }
  }

  if (feedItems === null) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS discovery document did not contain a feed list.",
    );
  }

  const feeds: Partial<Record<GbfsDataFeedName, string>> = {};
  let ignoredFeedCount = 0;
  for (const item of feedItems) {
    if (!isRecord(item)) {
      ignoredFeedCount += 1;
      continue;
    }
    const rawName = optionalString(item.name, 128);
    const url = validHttpsUrl(item.url);
    if (rawName !== null && KNOWN_UNUSED_FEEDS.has(rawName) && url !== null) {
      continue;
    }
    const name = rawName as GbfsDataFeedName | null;
    if (name === null || !SUPPORTED_FEEDS.has(name) || url === null) {
      ignoredFeedCount += 1;
      continue;
    }
    feeds[name] ??= url;
  }

  const metadata = readGbfsEnvelopeMetadata(root);
  const warnings: Warning[] = [];
  if (ignoredFeedCount > 0) {
    warnings.push(
      makeWarning(
        "PARTIAL_RESULTS",
        "Some discovery entries were malformed, unsupported, or not HTTPS and were ignored.",
        options.systemId,
      ),
    );
  }

  return {
    value: {
      version,
      languages,
      feeds,
      providerLastUpdated: metadata.providerLastUpdated,
      ttlSeconds: metadata.ttlSeconds,
    },
    warnings,
  };
};

const preferredLanguages = (context: GbfsNormalizationContext): string[] =>
  uniqueStrings([
    ...(context.preferredLanguages ?? []),
    ...(context.languages ?? []),
  ]);

export const normalizeSystemInformation = (
  document: unknown,
  context: GbfsNormalizationContext,
): NormalizationResult<System> => {
  const root = documentRecord(document);
  feedVersion(root, context.detectedVersion);
  const data = dataRecord(root);
  const preferred = preferredLanguages(context);
  const name = optionalString(context.name) ?? localizedText(data.name, preferred);
  if (name === null) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS system-information feed did not contain a system name.",
    );
  }

  const rawLanguages = Array.isArray(data.languages)
    ? data.languages.flatMap((value) => {
        const language = optionalString(value, 64);
        return language === null ? [] : [language];
      })
    : [];
  const singularLanguage = optionalString(data.language, 64);
  const languages = uniqueStrings([
    ...(context.languages ?? []),
    ...rawLanguages,
    ...(singularLanguage === null ? [] : [singularLanguage]),
  ]);

  const license =
    optionalString(context.licenseOverride, 1_000) ??
    optionalString(data.license_id, 1_000) ??
    optionalString(data.license_url, 1_000);
  const capabilities = context.capabilities ?? {
    docked: true,
    dockless: false,
    ebike: false,
    station_status: true,
  };

  const system = SystemSchema.parse({
    system_id: context.systemId,
    name,
    operator: localizedText(data.operator, preferred),
    city: optionalString(context.city, 300),
    region: optionalString(context.region, 300),
    country_code: optionalString(context.countryCode, 2)?.toUpperCase() ?? null,
    timezone: optionalString(data.timezone, 128),
    discovery_url: context.discoveryUrl,
    detected_version: context.detectedVersion,
    languages,
    license,
    capabilities,
  });

  return { value: system, warnings: [] };
};

const rentalUris = (value: unknown): Station["rental_uris"] => {
  if (!isRecord(value)) {
    return null;
  }
  const android = validHttpsUrl(value.android);
  const ios = validHttpsUrl(value.ios);
  const web = validHttpsUrl(value.web);
  if (android === null && ios === null && web === null) {
    return null;
  }
  return {
    ...(android === null ? {} : { android }),
    ...(ios === null ? {} : { ios }),
    ...(web === null ? {} : { web }),
  };
};

const stationType = (station: JsonRecord): string | null => {
  if (booleanish(station.is_virtual_station) === true) {
    return "virtual";
  }
  return (
    optionalString(station.station_type, 128) ??
    optionalString(station._bcycle_station_type, 128)
  );
};

export const normalizeStations = (
  document: unknown,
  context: GbfsNormalizationContext,
): NormalizationResult<Station[]> => {
  const root = documentRecord(document);
  feedVersion(root, context.detectedVersion, true);
  const data = dataRecord(root);
  if (!Array.isArray(data.stations)) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS station-information feed did not contain a station list.",
    );
  }

  const preferred = preferredLanguages(context);
  const stations: Station[] = [];
  let malformedCount = 0;
  let missingCapacityCount = 0;

  for (const item of data.stations) {
    if (!isRecord(item)) {
      malformedCount += 1;
      continue;
    }
    const stationId = stableId(item.station_id, 512);
    const name = localizedText(item.name, preferred);
    const latitude = finiteNumber(item.lat);
    const longitude = finiteNumber(item.lon);
    if (
      stationId === null ||
      name === null ||
      latitude === null ||
      longitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      malformedCount += 1;
      continue;
    }

    const capacity = nonnegativeInteger(item.capacity);
    if (capacity === null) {
      missingCapacityCount += 1;
    }
    const methods = Array.isArray(item.rental_methods)
      ? uniqueStrings(
          item.rental_methods.flatMap((method) => {
            const normalized = optionalString(method, 128);
            return normalized === null ? [] : [normalized];
          }),
        ).slice(0, 32)
      : [];

    stations.push(
      StationSchema.parse({
        system_id: context.systemId,
        station_id: stationId,
        name,
        latitude,
        longitude,
        capacity,
        station_type: stationType(item),
        region_id: stableId(item.region_id, 256),
        rental_methods: methods,
        rental_uris: rentalUris(item.rental_uris),
      }),
    );
  }

  const warnings: Warning[] = [];
  if (malformedCount > 0) {
    warnings.push(
      makeWarning(
        "PARTIAL_RESULTS",
        `${malformedCount} malformed station-information record(s) were ignored.`,
        context.systemId,
      ),
    );
  }
  if (missingCapacityCount > 0) {
    warnings.push(
      makeWarning(
        "AMBIGUOUS_CAPACITY",
        `${missingCapacityCount} station(s) did not provide a usable capacity.`,
        context.systemId,
      ),
    );
  }
  return { value: stations, warnings };
};

const vehicleCategory = (
  formFactor: string | null,
  propulsionType: string | null,
): { category: VehicleCategory; ambiguous: boolean } => {
  const form = formFactor?.toLowerCase() ?? "";
  const propulsion = propulsionType?.toLowerCase() ?? "";
  if (form.includes("cargo")) {
    return { category: "cargo_bike", ambiguous: false };
  }
  if (form.includes("scooter")) {
    return { category: "scooter", ambiguous: false };
  }
  if (
    propulsion.includes("electric") &&
    (form === "" || form.includes("bicycle") || form === "bike")
  ) {
    return { category: "ebike", ambiguous: false };
  }
  if (form.includes("bicycle") || form === "bike") {
    return { category: "bike", ambiguous: false };
  }
  return { category: "other", ambiguous: true };
};

export const normalizeVehicleTypes = (
  document: unknown,
  context: GbfsNormalizationContext,
): NormalizationResult<VehicleType[]> => {
  const root = documentRecord(document);
  feedVersion(root, context.detectedVersion);
  const data = dataRecord(root);
  if (!Array.isArray(data.vehicle_types)) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS vehicle-types feed did not contain a vehicle-type list.",
    );
  }

  const vehicleTypes: VehicleType[] = [];
  let malformedCount = 0;
  let ambiguousCount = 0;
  for (const item of data.vehicle_types) {
    if (!isRecord(item)) {
      malformedCount += 1;
      continue;
    }
    const vehicleTypeId = stableId(item.vehicle_type_id, 256);
    if (vehicleTypeId === null) {
      malformedCount += 1;
      continue;
    }
    const formFactor = optionalString(item.form_factor, 128);
    const propulsionType = optionalString(item.propulsion_type, 128);
    const mapped = vehicleCategory(formFactor, propulsionType);
    if (mapped.ambiguous) {
      ambiguousCount += 1;
    }
    const maxRange = finiteNumber(item.max_range_meters);
    vehicleTypes.push(
      VehicleTypeSchema.parse({
        system_id: context.systemId,
        vehicle_type_id: vehicleTypeId,
        category: mapped.category,
        form_factor: formFactor,
        propulsion_type: propulsionType,
        max_range_meters: maxRange !== null && maxRange >= 0 ? maxRange : null,
      }),
    );
  }

  const warnings: Warning[] = [];
  if (malformedCount > 0) {
    warnings.push(
      makeWarning(
        "PARTIAL_RESULTS",
        `${malformedCount} malformed vehicle-type record(s) were ignored.`,
        context.systemId,
      ),
    );
  }
  if (ambiguousCount > 0) {
    warnings.push(
      makeWarning(
        "VEHICLE_TYPE_AMBIGUOUS",
        `${ambiguousCount} vehicle type(s) could not be mapped precisely.`,
        context.systemId,
      ),
    );
  }
  return { value: vehicleTypes, warnings };
};

const inferLegacyCategory = (
  key: string,
): { category: VehicleCategory; ambiguous: boolean } => {
  const normalized = key.toLowerCase();
  if (normalized.includes("cargo")) {
    return { category: "cargo_bike", ambiguous: false };
  }
  if (normalized.includes("electric") || normalized.includes("ebike")) {
    return { category: "ebike", ambiguous: false };
  }
  if (
    normalized.includes("mechanical") ||
    normalized.includes("classic") ||
    normalized.includes("regular") ||
    normalized.includes("human")
  ) {
    return { category: "bike", ambiguous: false };
  }
  return { category: "other", ambiguous: true };
};

const addCount = (
  counts: Partial<Record<VehicleCategory, number>>,
  category: VehicleCategory,
  count: number,
): void => {
  counts[category] = (counts[category] ?? 0) + count;
};

const availabilityConfidence = (
  bikes: number | null,
  docks: number | null,
  flags: readonly (boolean | null)[],
  stationLastReported: string | null,
): "high" | "medium" | "low" | "unavailable" => {
  if (bikes !== null && docks !== null && flags.every((flag) => flag !== null)) {
    return stationLastReported === null ? "medium" : "high";
  }
  if (bikes !== null || docks !== null) {
    return "medium";
  }
  if (flags.some((flag) => flag !== null)) {
    return "low";
  }
  return "unavailable";
};

export const normalizeStationStatuses = (
  document: unknown,
  context: GbfsNormalizationContext,
): NormalizationResult<StationStatus[]> => {
  const root = documentRecord(document);
  const version = feedVersion(root, context.detectedVersion, true);
  const data = dataRecord(root);
  if (!Array.isArray(data.stations)) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The GBFS station-status feed did not contain a station list.",
    );
  }

  const providerObservedAt = toRfc3339(root.last_updated);
  const fallbackObservedAt = toRfc3339(context.fetchedAt);
  if (fallbackObservedAt === null) {
    throw new GbfsNormalizationError(
      "INVALID_DOCUMENT",
      "The station-status observation time was invalid.",
    );
  }
  const observedAt = providerObservedAt ?? fallbackObservedAt;
  const typeCategories = new Map(
    (context.vehicleTypes ?? []).map((type) => [
      type.vehicle_type_id,
      type.category,
    ]),
  );

  const statuses: StationStatus[] = [];
  let malformedCount = 0;
  let missingTimestampCount = 0;
  let ambiguousTypeCount = 0;

  for (const item of data.stations) {
    if (!isRecord(item)) {
      malformedCount += 1;
      continue;
    }
    const stationId = stableId(item.station_id, 512);
    if (stationId === null) {
      malformedCount += 1;
      continue;
    }

    const counts: Partial<Record<VehicleCategory, number>> = {};
    if (Array.isArray(item.vehicle_types_available)) {
      for (const entry of item.vehicle_types_available) {
        if (!isRecord(entry)) {
          continue;
        }
        const typeId = stableId(entry.vehicle_type_id, 256);
        const count = nonnegativeInteger(entry.count);
        if (typeId === null || count === null) {
          continue;
        }
        const category = typeCategories.get(typeId);
        if (category === undefined) {
          ambiguousTypeCount += 1;
          addCount(counts, "other", count);
        } else {
          addCount(counts, category, count);
        }
      }
    } else if (isRecord(item.num_bikes_available_types) || Array.isArray(item.num_bikes_available_types)) {
      const entries = Array.isArray(item.num_bikes_available_types)
        ? item.num_bikes_available_types.flatMap(entry => isRecord(entry) ? Object.entries(entry) : [])
        : Object.entries(item.num_bikes_available_types);
      for (const [key, value] of entries) {
        const count = nonnegativeInteger(value);
        if (count === null) {
          continue;
        }
        const mapped = inferLegacyCategory(key);
        if (mapped.ambiguous) {
          ambiguousTypeCount += 1;
        }
        addCount(counts, mapped.category, count);
      }
    }

    let bikes = version.startsWith("3.")
      ? (nonnegativeInteger(item.num_vehicles_available) ??
        nonnegativeInteger(item.num_bikes_available))
      : nonnegativeInteger(item.num_bikes_available);
    if (bikes === null && Object.keys(counts).length > 0) {
      bikes = Object.values(counts).reduce<number>(
        (total, count) => total + (count ?? 0),
        0,
      );
    }
    // GBFS 3 calls this total vehicles; never let scooters count as bicycles.
    if (Array.isArray(item.vehicle_types_available) && item.vehicle_types_available.length > 0 &&
        item.vehicle_types_available.every(entry => isRecord(entry) &&
          nonnegativeInteger(entry.count) !== null &&
          typeCategories.has(stableId(entry.vehicle_type_id, 256) ?? ""))) {
      const bicycleCount = (counts.bike ?? 0) + (counts.ebike ?? 0) + (counts.cargo_bike ?? 0);
      const knownTotal = Object.values(counts).reduce((total, count) => total + count, 0);
      if ((counts.other ?? 0) > 0) {
        bikes = null;
        ambiguousTypeCount += 1;
      } else if (counts.bike !== undefined || counts.ebike !== undefined || counts.cargo_bike !== undefined || knownTotal === bikes) {
        bikes = bicycleCount;
      } else {
        bikes = null;
        ambiguousTypeCount += 1;
      }
    }
    const docks = nonnegativeInteger(item.num_docks_available);
    const isRenting = booleanish(item.is_renting);
    const isReturning = booleanish(item.is_returning);
    const isInstalled = booleanish(item.is_installed);
    const stationLastReported = toRfc3339(item.last_reported, true);
    if (stationLastReported === null) {
      missingTimestampCount += 1;
    }

    statuses.push(
      StationStatusSchema.parse({
        system_id: context.systemId,
        station_id: stationId,
        observed_at: observedAt,
        station_last_reported: stationLastReported,
        availability: {
          bikes_available: bikes,
          docks_available: docks,
          vehicle_type_counts: counts,
          is_renting: isRenting,
          is_returning: isReturning,
          is_installed: isInstalled,
          confidence: availabilityConfidence(
            bikes,
            docks,
            [isRenting, isReturning, isInstalled],
            stationLastReported,
          ),
        },
      }),
    );
  }

  const warnings: Warning[] = [];
  if (providerObservedAt === null) {
    warnings.push(
      makeWarning(
        "SOURCE_TIMESTAMP_MISSING",
        "The station-status feed did not provide a usable envelope timestamp; fetch time was used.",
        context.systemId,
      ),
    );
  }
  if (malformedCount > 0) {
    warnings.push(
      makeWarning(
        "PARTIAL_RESULTS",
        `${malformedCount} malformed station-status record(s) were ignored.`,
        context.systemId,
      ),
    );
  }
  if (missingTimestampCount > 0) {
    warnings.push(
      makeWarning(
        "SOURCE_TIMESTAMP_MISSING",
        `${missingTimestampCount} station status record(s) lacked a usable station timestamp.`,
        context.systemId,
      ),
    );
  }
  if (ambiguousTypeCount > 0) {
    warnings.push(
      makeWarning(
        "VEHICLE_TYPE_AMBIGUOUS",
        "Some availability counts referenced vehicle types that could not be mapped precisely.",
        context.systemId,
      ),
    );
  }
  return { value: statuses, warnings };
};
