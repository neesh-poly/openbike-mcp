import { z } from "zod";

export const Rfc3339Schema = z.string().datetime({ offset: true });

export const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "URL must use HTTPS",
  });

export const SystemIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Invalid normalized system ID")
  .transform((value) => value.toLowerCase());

export const StationIdSchema = z.string().trim().min(1).max(512);
export const VehicleTypeIdSchema = z.string().trim().min(1).max(256);

export const LatitudeSchema = z.number().finite().min(-90).max(90);
export const LongitudeSchema = z.number().finite().min(-180).max(180);

export const VehicleCategorySchema = z.enum([
  "bike",
  "ebike",
  "cargo_bike",
  "scooter",
  "other",
]);

export const AvailabilityConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
  "unavailable",
]);

export const CoverageConfidenceSchema = z.enum([
  "geofence",
  "station_bounds",
  "catalog_metadata",
  "unknown",
]);

export const SystemCapabilitiesSchema = z
  .object({
    docked: z.boolean(),
    dockless: z.boolean(),
    ebike: z.boolean(),
    station_status: z.boolean(),
  })
  .strict();

export const SystemSchema = z
  .object({
    system_id: SystemIdSchema,
    name: z.string().min(1).max(500),
    operator: z.string().max(500).nullable(),
    city: z.string().max(300).nullable(),
    region: z.string().max(300).nullable(),
    country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
    timezone: z.string().min(1).max(128).nullable(),
    discovery_url: HttpsUrlSchema,
    detected_version: z.string().min(1).max(32).nullable(),
    languages: z.array(z.string().min(1).max(64)).max(64),
    license: z.string().max(1_000).nullable(),
    capabilities: SystemCapabilitiesSchema,
  })
  .strict();

export const SystemSummarySchema = SystemSchema.pick({
  system_id: true,
  name: true,
  operator: true,
  city: true,
  region: true,
  country_code: true,
  capabilities: true,
});

export const RentalUrisSchema = z
  .object({
    android: HttpsUrlSchema.optional(),
    ios: HttpsUrlSchema.optional(),
    web: HttpsUrlSchema.optional(),
  })
  .strict();

export const StationSchema = z
  .object({
    system_id: SystemIdSchema,
    station_id: StationIdSchema,
    name: z.string().min(1).max(500),
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    capacity: z.number().int().nonnegative().nullable(),
    station_type: z.string().max(128).nullable(),
    region_id: z.string().max(256).nullable(),
    rental_methods: z.array(z.string().min(1).max(128)).max(32),
    rental_uris: RentalUrisSchema.nullable(),
  })
  .strict();

export const VehicleTypeCountsSchema = z
  .object({
    bike: z.number().int().nonnegative().optional(),
    ebike: z.number().int().nonnegative().optional(),
    cargo_bike: z.number().int().nonnegative().optional(),
    scooter: z.number().int().nonnegative().optional(),
    other: z.number().int().nonnegative().optional(),
  })
  .strict();

export const AvailabilitySchema = z
  .object({
    bikes_available: z.number().int().nonnegative().nullable(),
    docks_available: z.number().int().nonnegative().nullable(),
    vehicle_type_counts: VehicleTypeCountsSchema,
    is_renting: z.boolean().nullable(),
    is_returning: z.boolean().nullable(),
    is_installed: z.boolean().nullable(),
    confidence: AvailabilityConfidenceSchema,
  })
  .strict();

export const StationStatusSchema = z
  .object({
    system_id: SystemIdSchema,
    station_id: StationIdSchema,
    observed_at: Rfc3339Schema,
    station_last_reported: Rfc3339Schema.nullable(),
    availability: AvailabilitySchema,
  })
  .strict();

export const VehicleTypeSchema = z
  .object({
    system_id: SystemIdSchema,
    vehicle_type_id: VehicleTypeIdSchema,
    category: VehicleCategorySchema,
    form_factor: z.string().max(128).nullable(),
    propulsion_type: z.string().max(128).nullable(),
    max_range_meters: z.number().nonnegative().nullable(),
  })
  .strict();

export const FreshnessSchema = z
  .object({
    provider_last_updated: Rfc3339Schema.nullable(),
    station_last_reported: Rfc3339Schema.nullable(),
    fetched_at: Rfc3339Schema,
    age_seconds: z.number().int().nonnegative(),
    ttl_seconds: z.number().int().nonnegative(),
    is_stale: z.boolean(),
  })
  .strict();

export const FeedNameSchema = z.enum([
  "gbfs",
  "manifest",
  "system_information",
  "station_information",
  "station_status",
  "vehicle_types",
  "free_bike_status",
  "vehicle_status",
  "geofencing_zones",
]);

export const SourceAttributionSchema = z
  .object({
    system_id: SystemIdSchema,
    feed_name: FeedNameSchema,
    url: HttpsUrlSchema.optional(),
    provider_last_updated: Rfc3339Schema.nullable(),
    fetched_at: Rfc3339Schema,
  })
  .strict();

export const FeedObservationSchema = z
  .object({
    system_id: SystemIdSchema,
    feed_name: FeedNameSchema,
    fetched_at: Rfc3339Schema,
    http_status: z.number().int().min(100).max(599).nullable(),
    etag: z.string().max(1_024).nullable(),
    last_modified: z.string().max(1_024).nullable(),
    provider_last_updated: Rfc3339Schema.nullable(),
    ttl_seconds: z.number().int().nonnegative().nullable(),
    validation_status: z.enum(["valid", "invalid", "unsupported"]),
    content_hash: z.string().max(256).nullable(),
  })
  .strict();

export type System = z.infer<typeof SystemSchema>;
export type SystemSummary = z.infer<typeof SystemSummarySchema>;
export type SystemCapabilities = z.infer<typeof SystemCapabilitiesSchema>;
export type Station = z.infer<typeof StationSchema>;
export type StationStatus = z.infer<typeof StationStatusSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type AvailabilityConfidence = z.infer<
  typeof AvailabilityConfidenceSchema
>;
export type Freshness = z.infer<typeof FreshnessSchema>;
export type VehicleCategory = z.infer<typeof VehicleCategorySchema>;
export type VehicleType = z.infer<typeof VehicleTypeSchema>;
export type FeedObservation = z.infer<typeof FeedObservationSchema>;
export type SourceAttribution = z.infer<typeof SourceAttributionSchema>;
export type CoverageConfidence = z.infer<typeof CoverageConfidenceSchema>;
