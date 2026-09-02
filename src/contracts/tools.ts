import { z } from "zod";

import {
  AvailabilitySchema,
  CoverageConfidenceSchema,
  FeedNameSchema,
  FreshnessSchema,
  HttpsUrlSchema,
  LatitudeSchema,
  LongitudeSchema,
  Rfc3339Schema,
  SourceAttributionSchema,
  StationIdSchema,
  StationSchema,
  SystemCapabilitiesSchema,
  SystemIdSchema,
  SystemSchema,
  SystemSummarySchema,
  VehicleCategorySchema,
} from "./entities";
import { ErrorCodeSchema } from "./errors";
import { WarningSchema } from "./warnings";

const uniqueSorted = <T extends string>(values: T[]): T[] =>
  [...new Set(values)].sort();

const SystemIdsSchema = z
  .array(SystemIdSchema)
  .max(4)
  .transform(uniqueSorted);

const VehicleCategoriesSchema = z
  .array(VehicleCategorySchema)
  .max(5)
  .transform(uniqueSorted);

const QueryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value) => value.normalize("NFC"));

export const AvailabilityModeSchema = z.enum(["take", "return", "either"]);

export const GetNearbyAvailabilityInputSchema = z
  .object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    mode: AvailabilityModeSchema,
    radius_meters: z.number().int().min(50).max(5_000).default(800),
    limit: z.number().int().min(1).max(25).default(5),
    system_ids: SystemIdsSchema.optional(),
    vehicle_types: VehicleCategoriesSchema.optional(),
    minimum_available: z.number().int().min(0).max(100_000).default(1),
    include_unavailable: z.boolean().default(false),
    max_staleness_seconds: z
      .number()
      .int()
      .min(0)
      .max(86_400)
      .default(300),
  })
  .strict();

export const FindStationsInputSchema = z
  .object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    radius_meters: z.number().int().min(50).max(10_000).default(1_000),
    system_ids: SystemIdsSchema.optional(),
    query: QueryTextSchema.optional(),
    include_status: z.boolean().default(true),
    operational_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();

export const GetStationInputSchema = z
  .object({
    system_id: SystemIdSchema,
    station_id: StationIdSchema,
    include_status: z.boolean().default(true),
    include_raw_links: z.boolean().default(true),
  })
  .strict();

export const SystemCapabilityFilterSchema = z.enum([
  "docked",
  "dockless",
  "ebike",
  "station_status",
]);

export const FindSystemsInputSchema = z
  .object({
    latitude: LatitudeSchema.optional(),
    longitude: LongitudeSchema.optional(),
    radius_km: z.number().finite().min(1).max(500).default(50),
    query: QueryTextSchema.optional(),
    country_code: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    capability: SystemCapabilityFilterSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.latitude === undefined) !== (value.longitude === undefined)) {
      context.addIssue({
        code: "custom",
        message: "latitude and longitude must be provided together",
        path: value.latitude === undefined ? ["latitude"] : ["longitude"],
      });
    }
  });

export const GetSystemHealthInputSchema = z
  .object({
    system_id: SystemIdSchema,
  })
  .strict();

export const ToolMetadataSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    catalog_version: z.string().min(1).max(256),
    generated_at: Rfc3339Schema,
    worker_version: z.string().min(1).max(256),
  })
  .strict();

export const FailedSystemSchema = z
  .object({
    system_id: SystemIdSchema,
    code: ErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

export const NearbyAvailabilityResultSchema = z
  .object({
    system: SystemSummarySchema,
    station: StationSchema,
    distance_meters: z.number().finite().nonnegative(),
    availability: AvailabilitySchema,
    freshness: FreshnessSchema,
    sources: z.array(SourceAttributionSchema).min(1).max(16),
  })
  .strict();

export const NearbyAvailabilityQuerySchema = z
  .object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    mode: AvailabilityModeSchema,
    radius_meters: z.number().int().min(50).max(5_000),
    limit: z.number().int().min(1).max(25),
    system_ids: z.array(SystemIdSchema).max(4),
    vehicle_types: z.array(VehicleCategorySchema).max(5),
    minimum_available: z.number().int().min(0).max(100_000),
    include_unavailable: z.boolean(),
    max_staleness_seconds: z.number().int().min(0).max(86_400),
  })
  .strict();

export const GetNearbyAvailabilityOutputSchema = z
  .object({
    query: NearbyAvailabilityQuerySchema,
    systems_considered: z.array(SystemSummarySchema).max(4),
    systems_failed: z.array(FailedSystemSchema).max(4),
    results: z.array(NearbyAvailabilityResultSchema).max(25),
    warnings: z.array(WarningSchema).max(100),
    metadata: ToolMetadataSchema,
  })
  .strict();

export const StationSearchResultSchema = z
  .object({
    system: SystemSummarySchema,
    station: StationSchema,
    distance_meters: z.number().finite().nonnegative(),
    availability: AvailabilitySchema.optional(),
    freshness: FreshnessSchema.optional(),
    sources: z.array(SourceAttributionSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.availability === undefined) !== (value.freshness === undefined)) {
      context.addIssue({
        code: "custom",
        message: "availability and freshness must either both be present or both be absent",
      });
    }
  });

export const FindStationsOutputSchema = z
  .object({
    results: z.array(StationSearchResultSchema).max(100),
    next_cursor: z.string().max(2_048).nullable(),
    systems_considered: z.array(SystemSummarySchema).max(4),
    systems_failed: z.array(FailedSystemSchema).max(4),
    warnings: z.array(WarningSchema).max(100),
    metadata: ToolMetadataSchema,
  })
  .strict();

export const GetStationOutputSchema = z
  .object({
    system: SystemSummarySchema,
    station: StationSchema,
    availability: AvailabilitySchema.optional(),
    freshness: FreshnessSchema.optional(),
    sources: z.array(SourceAttributionSchema).max(16),
    warnings: z.array(WarningSchema).max(100),
    metadata: ToolMetadataSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.availability === undefined) !== (value.freshness === undefined)) {
      context.addIssue({
        code: "custom",
        message: "availability and freshness must either both be present or both be absent",
      });
    }
  });

export const SystemSearchResultSchema = SystemSchema.extend({
  distance_meters: z.number().finite().nonnegative().nullable(),
  coverage_confidence: CoverageConfidenceSchema,
  last_successful_probe: Rfc3339Schema.nullable(),
});

export const FindSystemsOutputSchema = z
  .object({
    results: z.array(SystemSearchResultSchema).max(100),
    warnings: z.array(WarningSchema).max(100),
    metadata: ToolMetadataSchema,
  })
  .strict();

export const ProviderErrorClassSchema = z.enum([
  "none",
  "dns",
  "connect_timeout",
  "total_timeout",
  "http_4xx",
  "http_429",
  "http_5xx",
  "invalid_content_type",
  "invalid_json",
  "schema_validation",
  "unsupported_version",
  "response_too_large",
  "ssrf_blocked",
  "unknown",
]);

export const FeedHealthSchema = z
  .object({
    feed_name: FeedNameSchema,
    present: z.boolean(),
    last_successful_fetch: Rfc3339Schema.nullable(),
    provider_last_updated: Rfc3339Schema.nullable(),
    ttl_seconds: z.number().int().nonnegative().nullable(),
    validation_status: z.enum(["valid", "invalid", "unsupported", "unknown"]),
    last_error_class: ProviderErrorClassSchema,
  })
  .strict();

export const GetSystemHealthOutputSchema = z
  .object({
    system_id: SystemIdSchema,
    discovery_url: HttpsUrlSchema,
    detected_version: z.string().min(1).max(32).nullable(),
    feeds: z.array(FeedHealthSchema).max(32),
    rolling_success_rate: z.number().finite().min(0).max(1).nullable(),
    rolling_window_seconds: z.number().int().positive(),
    capabilities: SystemCapabilitiesSchema,
    degradation_state: z.enum(["healthy", "degraded", "unavailable", "unknown"]),
    last_successful_probe: Rfc3339Schema.nullable(),
    warnings: z.array(WarningSchema).max(100),
    metadata: ToolMetadataSchema,
  })
  .strict();

export const ToolInputs = {
  find_stations: FindStationsInputSchema,
  find_systems: FindSystemsInputSchema,
  get_nearby_availability: GetNearbyAvailabilityInputSchema,
  get_station: GetStationInputSchema,
  get_system_health: GetSystemHealthInputSchema,
} as const;

export const ToolOutputs = {
  find_stations: FindStationsOutputSchema,
  find_systems: FindSystemsOutputSchema,
  get_nearby_availability: GetNearbyAvailabilityOutputSchema,
  get_station: GetStationOutputSchema,
  get_system_health: GetSystemHealthOutputSchema,
} as const;

export type AvailabilityMode = z.infer<typeof AvailabilityModeSchema>;
export type GetNearbyAvailabilityInput = z.infer<
  typeof GetNearbyAvailabilityInputSchema
>;
export type GetNearbyAvailabilityOutput = z.infer<
  typeof GetNearbyAvailabilityOutputSchema
>;
export type FindStationsInput = z.infer<typeof FindStationsInputSchema>;
export type FindStationsOutput = z.infer<typeof FindStationsOutputSchema>;
export type GetStationInput = z.infer<typeof GetStationInputSchema>;
export type GetStationOutput = z.infer<typeof GetStationOutputSchema>;
export type FindSystemsInput = z.infer<typeof FindSystemsInputSchema>;
export type FindSystemsOutput = z.infer<typeof FindSystemsOutputSchema>;
export type GetSystemHealthInput = z.infer<typeof GetSystemHealthInputSchema>;
export type GetSystemHealthOutput = z.infer<typeof GetSystemHealthOutputSchema>;
export type NearbyAvailabilityResult = z.infer<
  typeof NearbyAvailabilityResultSchema
>;
export type StationSearchResult = z.infer<typeof StationSearchResultSchema>;
