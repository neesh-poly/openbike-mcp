import { z } from "zod";

import { SystemCapabilitiesSchema } from "../contracts";

export const StatusCycleSchema = z
  .object({
    schema_version: z.literal(1),
    cycle_id: z.string().min(1).max(256),
    catalog_version: z.string().min(1).max(256),
    catalog_published_at: z.string().datetime({ offset: true }),
    started_at: z.string().datetime({ offset: true }),
    systems_scheduled: z.number().int().nonnegative(),
    systems_completed: z.number().int().nonnegative(),
    systems_healthy: z.number().int().nonnegative(),
    systems_degraded: z.number().int().nonnegative(),
    systems_unavailable: z.number().int().nonnegative(),
    last_probe_activity_at: z.string().datetime({ offset: true }).nullable(),
    state: z.enum(["probing", "complete"]),
  })
  .strict()
  .refine(
    (cycle) =>
      cycle.systems_completed ===
      cycle.systems_healthy +
        cycle.systems_degraded +
        cycle.systems_unavailable,
    { message: "Status outcome counts must equal systems_completed" },
  )
  .refine((cycle) => cycle.systems_completed <= cycle.systems_scheduled, {
    message: "Status completion cannot exceed scheduled systems",
  })
  .refine(
    (cycle) => {
      const expectedState =
        cycle.systems_completed >= cycle.systems_scheduled
          ? "complete"
          : "probing";
      return cycle.state === expectedState;
    },
    { message: "Status state must match completion counts" },
  );

export const StatusPointerSchema = z
  .object({
    schema_version: z.literal(1),
    cycle_id: z.string().min(1).max(256),
    catalog_version: z.string().min(1).max(256),
    r2_key: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    published_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const SystemProbeStatusSchema = z
  .object({
    schema_version: z.literal(1),
    cycle_id: z.string().min(1).max(256),
    catalog_version: z.string().min(1).max(256),
    system_id: z.string().min(1).max(128),
    checked_at: z.string().datetime({ offset: true }),
    outcome: z.enum(["healthy", "degraded", "unavailable"]),
    cache_status: z.enum(["fresh", "stale", "miss", "unknown"]),
    circuit_state: z.enum(["closed", "open", "half_open", "unknown"]),
    age_seconds: z.number().int().nonnegative().nullable(),
    retryable: z.boolean(),
    error_class: z
      .enum([
        "connect_timeout",
        "total_timeout",
        "dns",
        "tls",
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
        "none",
      ])
      .nullable(),
    // Optional for backward compatibility with status objects written before
    // probe-derived discovery metadata was introduced.
    detected_version: z.string().trim().min(1).max(32).nullable().optional(),
    capabilities: SystemCapabilitiesSchema.nullable().optional(),
    last_successful_probe: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
  })
  .strict();

export const SystemProbeStatusReferenceSchema = z
  .object({
    key: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    checked_at: z.string().datetime({ offset: true }),
  })
  .strict();

export interface PublicStatus {
  service: "openbike-mcp";
  state: "initializing" | "operational";
  cycle: z.infer<typeof StatusCycleSchema> | null;
  last_probe_activity_at: string | null;
}

export type StatusCycle = z.infer<typeof StatusCycleSchema>;
export type StatusPointer = z.infer<typeof StatusPointerSchema>;
export type SystemProbeStatus = z.infer<typeof SystemProbeStatusSchema>;
export type SystemProbeStatusReference = z.infer<
  typeof SystemProbeStatusReferenceSchema
>;

export interface ProbeDiscoveryMetadata {
  cycle_id: string;
  catalog_version: string;
  system_id: string;
  checked_at: string;
  detected_version: string | null;
  capabilities: z.infer<typeof SystemCapabilitiesSchema> | null;
  last_successful_probe: string | null;
}

export interface StatusBindings {
  CATALOG_KV: Pick<KVNamespace, "get" | "put">;
  CATALOG_R2: Pick<R2Bucket, "get" | "head" | "put">;
}
