import { z } from "zod";

import {
  HttpsUrlSchema,
  SystemCapabilitiesSchema,
  SystemIdSchema,
} from "../contracts/entities";

export const CATALOG_SCHEMA_VERSION = 1 as const;

export const CatalogBoundsSchema = z
  .object({
    south: z.number().finite().min(-90).max(90),
    west: z.number().finite().min(-180).max(180),
    north: z.number().finite().min(-90).max(90),
    east: z.number().finite().min(-180).max(180),
  })
  .strict()
  .refine((bounds) => bounds.south <= bounds.north, {
    message: "Catalog bounds must have south <= north",
  });

export const CatalogCoordinateSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export const CatalogLicenseSchema = z
  .object({
    id: z.string().min(1).max(128).nullable(),
    name: z.string().min(1).max(500).nullable(),
    url: HttpsUrlSchema.nullable(),
    status: z.enum(["declared", "unknown"]),
  })
  .strict();

export const CatalogCoverageSchema = z
  .object({
    bounds: CatalogBoundsSchema.nullable(),
    centroid: CatalogCoordinateSchema.nullable(),
    confidence: z.enum([
      "geofence",
      "station_bounds",
      "catalog_metadata",
      "unknown",
    ]),
    buffer_meters: z.number().int().nonnegative().max(100_000),
  })
  .strict();

const LocationHintSchema = z.enum([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
]);

export const CatalogSystemSchema = z
  .object({
    system_id: SystemIdSchema,
    source_system_id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(500),
    operator: z.string().trim().max(500).nullable(),
    city: z.string().trim().max(300).nullable(),
    region: z.string().trim().max(300).nullable(),
    country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
    timezone: z.string().trim().min(1).max(128).nullable(),
    feed_format: z.enum(["gbfs", "velib", "tfl"]).optional(),
    discovery_url: HttpsUrlSchema,
    detected_version: z.string().trim().min(1).max(32).nullable(),
    languages: z.array(z.string().trim().min(1).max(64)).max(64),
    license: CatalogLicenseSchema,
    capabilities: SystemCapabilitiesSchema,
    coverage: CatalogCoverageSchema,
    location_hint: LocationHintSchema,
    reviewed_hosts: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(253)
          .transform((value) => value.toLowerCase()),
      )
      .min(1)
      .max(16),
    request_headers: z.record(z.string(), z.string().max(1_024)),
    preferred_languages: z.array(z.string().min(1).max(64)).max(16),
    enabled: z.boolean(),
  })
  .strict();

export const CatalogSnapshotSchema = z
  .object({
    schema_version: z.literal(CATALOG_SCHEMA_VERSION),
    version: z.string().min(1).max(256),
    generated_at: z.string().datetime({ offset: true }),
    source_url: HttpsUrlSchema,
    source_etag: z.string().max(1_024).nullable(),
    systems: z.array(CatalogSystemSchema).min(1).max(10_000),
  })
  .strict();

export const CatalogPointerSchema = z
  .object({
    schema_version: z.literal(CATALOG_SCHEMA_VERSION),
    version: z.string().min(1).max(256),
    r2_key: z.string().min(1).max(1_024),
    published_at: z.string().datetime({ offset: true }),
    system_count: z.number().int().positive(),
    // Optional so pointers published by pre-canary Workers remain readable.
    enabled_system_count: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    previous_version: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const CatalogOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    discovery_url: HttpsUrlSchema.optional(),
    reviewed_hosts: z.array(z.string().min(1).max(253)).min(1).max(16).optional(),
    request_headers: z.record(z.string(), z.string().max(1_024)).optional(),
    preferred_languages: z.array(z.string().min(1).max(64)).max(16).optional(),
    coverage: CatalogCoverageSchema.optional(),
    location_hint: LocationHintSchema.optional(),
  })
  .strict();

export const CatalogOverridesSchema = z.record(
  SystemIdSchema,
  CatalogOverrideSchema,
);

export interface CatalogSearchInput {
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  query?: string;
  countryCode?: string;
  systemIds?: readonly string[];
  limit?: number;
}

export interface CatalogCandidate {
  system: CatalogSystem;
  distance_meters: number | null;
  matched_by: "explicit" | "coverage" | "metadata";
}

export interface CatalogLoadOptions {
  version?: string;
  allowBundledFallback?: boolean;
}

export type CatalogBounds = z.infer<typeof CatalogBoundsSchema>;
export type CatalogCoordinate = z.infer<typeof CatalogCoordinateSchema>;
export type CatalogLicense = z.infer<typeof CatalogLicenseSchema>;
export type CatalogCoverage = z.infer<typeof CatalogCoverageSchema>;
export type CatalogSystem = z.infer<typeof CatalogSystemSchema>;
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;
export type CatalogPointer = z.infer<typeof CatalogPointerSchema>;
export type CatalogOverride = z.infer<typeof CatalogOverrideSchema>;
export type CatalogOverrides = z.infer<typeof CatalogOverridesSchema>;

export interface CatalogBindings {
  CATALOG_KV: Pick<KVNamespace, "get" | "put">;
  CATALOG_R2: Pick<R2Bucket, "get" | "head" | "put">;
}
