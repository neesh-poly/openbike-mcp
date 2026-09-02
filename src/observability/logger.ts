export type LogLevel = "debug" | "info" | "warn" | "error";

const SAFE_FIELD_NAMES = new Set([
  "request_id",
  "system_id",
  "station_id",
  "catalog_version",
  "component",
  "operation",
  "outcome",
  "error_class",
  "cache_status",
  "circuit_state",
  "duration_ms",
  "result_count",
  "attempt",
  "environment",
  "worker_version",
  "http_status",
  "age_seconds",
]);

const safeScalar = (value: unknown): string | number | boolean | null => {
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean" || value === null) return value;
  return "[redacted]";
};

export const sanitizeLogFields = (
  fields: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> => {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SAFE_FIELD_NAMES.has(key)) sanitized[key] = safeScalar(value);
  }
  return sanitized;
};

export const logEvent = (
  level: LogLevel,
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void => {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event: event.slice(0, 128),
    ...sanitizeLogFields(fields),
  });
  console[level](entry);
};
