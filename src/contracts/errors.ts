import { z } from "zod";

import { StationIdSchema, SystemIdSchema } from "./entities";

export const ErrorCodeSchema = z.enum([
  "INVALID_ARGUMENT",
  "NO_SYSTEM_COVERAGE",
  "NO_RESULTS",
  "NOT_FOUND",
  "SYSTEM_UNAVAILABLE",
  "STALE_DATA",
  "UNSUPPORTED_FEED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export const SafeErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    request_id: z.string().min(1).max(128),
    system_id: SystemIdSchema.optional(),
    station_id: StationIdSchema.optional(),
  })
  .strict();

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type SafeError = z.infer<typeof SafeErrorSchema>;
