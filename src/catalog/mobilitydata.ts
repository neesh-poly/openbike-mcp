import { SystemIdSchema } from "../contracts";
import {
  createReviewedHostPolicy,
  isIpLiteral,
  validateOutboundUrl,
} from "../security";
import type { MobilityDataSystemRow } from "./csv";
import type { CatalogSystem } from "./types";

export const MOBILITYDATA_CATALOG_MODES = ["reviewed", "candidates"] as const;
export type MobilityDataCatalogMode =
  (typeof MOBILITYDATA_CATALOG_MODES)[number];

export interface MobilityDataAdmissionStats {
  input_rows: number;
  eligible_rows: number;
  candidate_systems: number;
  reviewed_matches: number;
  rejected_authenticated: number;
  rejected_duplicate_id: number;
  rejected_invalid_id: number;
  rejected_invalid_name: number;
  rejected_invalid_url: number;
}

export interface MobilityDataAdmissionResult {
  systems: CatalogSystem[];
  stats: MobilityDataAdmissionStats;
}

const UNKNOWN_CAPABILITIES = {
  docked: false,
  dockless: false,
  ebike: false,
  station_status: false,
} as const;

const FORBIDDEN_CATALOG_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
]);

const FORBIDDEN_CATALOG_HOST_SUFFIXES = [
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".example",
  ".test",
  ".home.arpa",
] as const;

const cleanText = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Converts an upstream identifier to the service's stable ASCII identifier
 * grammar. The original MobilityData value remains in source_system_id.
 */
export const normalizeMobilityDataSystemId = (
  sourceSystemId: string,
): string | null => {
  const normalized = cleanText(sourceSystemId)
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "");
  if (normalized.length === 0 || normalized.length > 128) return null;
  const parsed = SystemIdSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
};

const isAuthenticated = (row: MobilityDataSystemRow): boolean =>
  row.authentication_type.trim().length > 0 ||
  row.authentication_parameter_name.trim().length > 0 ||
  row.authentication_info_url.trim().length > 0;

const normalizedDiscovery = (
  rawUrl: string,
): { url: string; hostname: string } | null => {
  if (rawUrl.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  const hasValidDnsLabels = labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
  if (
    !hostname.includes(".") ||
    hostname.length > 253 ||
    !hasValidDnsLabels ||
    isIpLiteral(hostname) ||
    FORBIDDEN_CATALOG_HOSTS.has(hostname) ||
    FORBIDDEN_CATALOG_HOST_SUFFIXES.some((suffix) =>
      hostname.endsWith(suffix),
    )
  ) {
    return null;
  }

  try {
    const policy = createReviewedHostPolicy([{ hostname }]);
    const validated = validateOutboundUrl(parsed, policy);
    validated.url.hostname = hostname;
    return { url: validated.url.href, hostname };
  } catch {
    return null;
  }
};

const locationHintForCountry = (
  countryCode: string | null,
): CatalogSystem["location_hint"] => {
  if (countryCode === null) return "enam";
  if (["AR", "BO", "BR", "CL", "CO", "EC", "PE", "PY", "UY", "VE"].includes(countryCode)) {
    return "sam";
  }
  if (["AU", "FJ", "NZ", "PG"].includes(countryCode)) return "oc";
  if (["CN", "JP", "KR", "MN", "TW"].includes(countryCode)) return "apac-ne";
  if (["ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "VN"].includes(countryCode)) {
    return "apac-se";
  }
  if (["BD", "IN", "LK", "NP", "PK"].includes(countryCode)) return "apac";
  if (["AE", "BH", "IL", "IQ", "JO", "KW", "LB", "OM", "PS", "QA", "SA", "TR"].includes(countryCode)) {
    return "me";
  }
  if (["BG", "BY", "CZ", "EE", "GR", "HR", "HU", "LT", "LV", "MD", "PL", "RO", "RS", "RU", "SI", "SK", "UA"].includes(countryCode)) {
    return "eeur";
  }
  if (["AT", "BE", "CH", "DE", "DK", "ES", "FI", "FR", "GB", "IE", "IS", "IT", "LU", "NL", "NO", "PT", "SE"].includes(countryCode)) {
    return "weur";
  }
  if (["CA", "MX", "US"].includes(countryCode)) return "enam";
  if (["DZ", "EG", "GH", "KE", "MA", "NG", "RW", "SN", "TN", "TZ", "UG", "ZA"].includes(countryCode)) {
    return "afr";
  }
  return "enam";
};

const emptyStats = (inputRows: number): MobilityDataAdmissionStats => ({
  input_rows: inputRows,
  eligible_rows: 0,
  candidate_systems: 0,
  reviewed_matches: 0,
  rejected_authenticated: 0,
  rejected_duplicate_id: 0,
  rejected_invalid_id: 0,
  rejected_invalid_name: 0,
  rejected_invalid_url: 0,
});

/**
 * Turns the signed-off upstream catalog into inert admission candidates. A
 * candidate is intentionally disabled and carries no inferred version,
 * capabilities, license, or geographic coverage. Promotion remains an
 * explicit operator review step.
 */
export const normalizeMobilityDataCatalogRows = (
  rows: readonly MobilityDataSystemRow[],
  reviewedSystems: readonly CatalogSystem[],
): MobilityDataAdmissionResult => {
  const stats = emptyStats(rows.length);
  const normalizedIds = rows.map((row) =>
    normalizeMobilityDataSystemId(row.system_id),
  );
  const idCounts = new Map<string, number>();
  for (const id of normalizedIds) {
    if (id !== null) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const reviewedIds = new Set(
    reviewedSystems.flatMap((system) => [
      system.system_id,
      normalizeMobilityDataSystemId(system.source_system_id) ?? system.system_id,
    ]),
  );
  const systems: CatalogSystem[] = [];

  rows.forEach((row, index) => {
    const systemId = normalizedIds[index] ?? null;
    if (systemId === null) {
      stats.rejected_invalid_id += 1;
      return;
    }
    if ((idCounts.get(systemId) ?? 0) > 1) {
      stats.rejected_duplicate_id += 1;
      return;
    }
    if (isAuthenticated(row)) {
      stats.rejected_authenticated += 1;
      return;
    }

    const sourceSystemId = cleanText(row.system_id);
    const name = cleanText(row.name);
    if (
      sourceSystemId.length === 0 ||
      sourceSystemId.length > 256 ||
      name.length === 0 ||
      name.length > 500
    ) {
      stats.rejected_invalid_name += 1;
      return;
    }

    const discovery = normalizedDiscovery(row.auto_discovery_url.trim());
    if (discovery === null) {
      stats.rejected_invalid_url += 1;
      return;
    }
    stats.eligible_rows += 1;
    if (reviewedIds.has(systemId)) {
      stats.reviewed_matches += 1;
      return;
    }

    const location = cleanText(row.location);
    const rawCountryCode = cleanText(row.country_code).toUpperCase();
    const countryCode = /^[A-Z]{2}$/.test(rawCountryCode)
      ? rawCountryCode
      : null;
    systems.push({
      system_id: systemId,
      source_system_id: sourceSystemId,
      name,
      operator: null,
      city: location.length > 0 && location.length <= 300 ? location : null,
      region: null,
      country_code: countryCode,
      timezone: null,
      discovery_url: discovery.url,
      // Supported Versions is a catalog declaration, not probe evidence.
      detected_version: null,
      languages: [],
      license: { id: null, name: null, url: null, status: "unknown" },
      capabilities: UNKNOWN_CAPABILITIES,
      coverage: {
        bounds: null,
        centroid: null,
        confidence: "unknown",
        buffer_meters: 0,
      },
      location_hint: locationHintForCountry(countryCode),
      reviewed_hosts: [discovery.hostname],
      request_headers: {},
      preferred_languages: [],
      enabled: false,
    });
  });

  systems.sort((left, right) => left.system_id.localeCompare(right.system_id));
  stats.candidate_systems = systems.length;
  return { systems, stats };
};

export const parseMobilityDataCatalogMode = (
  rawMode: string,
): MobilityDataCatalogMode => {
  if ((MOBILITYDATA_CATALOG_MODES as readonly string[]).includes(rawMode)) {
    return rawMode as MobilityDataCatalogMode;
  }
  throw new Error(
    `Unsupported MobilityData catalog mode; expected ${MOBILITYDATA_CATALOG_MODES.join(" or ")}`,
  );
};
