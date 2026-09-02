import { z } from "zod";

import { StationIdSchema, SystemIdSchema } from "./entities";

export const WarningCodeSchema = z.enum([
  "PARTIAL_RESULTS",
  "PROVIDER_UNAVAILABLE",
  "STALE_DATA",
  "SOURCE_TIMESTAMP_MISSING",
  "MISSING_STATION_STATUS",
  "ORPHAN_STATION_STATUS",
  "DUPLICATE_STATION_STATUS",
  "MISSING_OPTIONAL_FIELD",
  "AMBIGUOUS_CAPACITY",
  "VEHICLE_TYPE_AMBIGUOUS",
  "UNSUPPORTED_EXTENSION",
  "CATALOG_STALE",
  "STATUS_UNKNOWN",
  "WARNINGS_TRUNCATED",
]);

export const WarningSchema = z
  .object({
    code: WarningCodeSchema,
    message: z.string().min(1).max(500),
    system_id: SystemIdSchema.optional(),
    station_id: StationIdSchema.optional(),
    retryable: z.boolean(),
  })
  .strict();

export type WarningCode = z.infer<typeof WarningCodeSchema>;
export type Warning = z.infer<typeof WarningSchema>;
