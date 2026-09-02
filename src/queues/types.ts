import { z } from "zod";

export const ProbeMessageSchema = z
  .object({
    schema_version: z.literal(1),
    cycle_id: z.string().min(1).max(256),
    catalog_version: z.string().min(1).max(256),
    catalog_published_at: z.string().datetime({ offset: true }),
    system_id: z.string().min(1).max(128),
    idempotency_key: z.string().min(1).max(512),
    enqueued_at: z.string().datetime({ offset: true }),
    systems_scheduled: z.number().int().nonnegative(),
  })
  .strict();

export type ProbeMessage = z.infer<typeof ProbeMessageSchema>;
