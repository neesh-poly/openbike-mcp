import type {
  CircuitRecord,
  ProviderErrorClass,
  RefreshFailure,
} from "./types";

export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_BASE_DELAY_SECONDS = 30;
export const CIRCUIT_MAX_DELAY_SECONDS = 15 * 60;

export const circuitBackoffSeconds = (consecutiveFailures: number): number => {
  const exponent = Math.max(0, consecutiveFailures - CIRCUIT_FAILURE_THRESHOLD);
  return Math.min(
    CIRCUIT_MAX_DELAY_SECONDS,
    CIRCUIT_BASE_DELAY_SECONDS * 2 ** exponent,
  );
};

export const circuitAfterSuccess = (
  prior: CircuitRecord,
  nowMs: number,
): CircuitRecord => ({
  state: "closed",
  consecutiveFailures: 0,
  openedUntilMs: null,
  lastErrorClass: null,
  lastErrorAtMs: null,
  lastSuccessAtMs: nowMs,
  successes: prior.successes + 1,
  failures: prior.failures,
});

export const circuitAfterFailure = (
  prior: CircuitRecord,
  failure: RefreshFailure,
  nowMs: number,
): CircuitRecord => {
  const consecutiveFailures = prior.consecutiveFailures + 1;
  const shouldOpen =
    failure.retryable && consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD;
  return {
    state: shouldOpen ? "open" : "closed",
    consecutiveFailures,
    openedUntilMs: shouldOpen
      ? nowMs + circuitBackoffSeconds(consecutiveFailures) * 1_000
      : null,
    lastErrorClass: failure.errorClass,
    lastErrorAtMs: nowMs,
    lastSuccessAtMs: prior.lastSuccessAtMs,
    successes: prior.successes,
    failures: prior.failures + 1,
  };
};

export const classifyProviderError = (error: unknown): RefreshFailure => {
  const record =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const code = typeof record.code === "string" ? record.code : "";
  const httpStatus =
    typeof record.httpStatus === "number" ? record.httpStatus : undefined;
  const retryable =
    typeof record.retryable === "boolean" ? record.retryable : true;

  let errorClass: ProviderErrorClass;
  if (code === "TIMEOUT") errorClass = "total_timeout";
  else if (code === "RATE_LIMITED") errorClass = "http_429";
  else if (code === "RESPONSE_TOO_LARGE") errorClass = "response_too_large";
  else if (code === "INVALID_CONTENT_TYPE") {
    errorClass = "invalid_content_type";
  } else if (code === "INVALID_JSON" || code === "EMPTY_RESPONSE") {
    errorClass = "invalid_json";
  } else if (code === "BLOCKED_URL") {
    errorClass = "ssrf_blocked";
  } else if (code === "UNSUPPORTED_VERSION") {
    errorClass = "unsupported_version";
  } else if (
    code === "INVALID_DOCUMENT" ||
    code === "MISSING_REQUIRED_FEED"
  ) {
    errorClass = "schema_validation";
  } else if (code === "INVALID_URL" || code === "INVALID_HEADERS") {
    errorClass = "ssrf_blocked";
  } else if (httpStatus === 429) {
    errorClass = "http_429";
  } else if (httpStatus !== undefined && httpStatus >= 500) {
    errorClass = "http_5xx";
  } else if (httpStatus !== undefined && httpStatus >= 400) {
    errorClass = "http_4xx";
  } else if (
    error instanceof Error &&
    /normaliz|schema|validation/i.test(`${error.name} ${error.message}`)
  ) {
    errorClass = "schema_validation";
  } else if (code === "NETWORK_ERROR") {
    errorClass = "dns";
  } else {
    errorClass = "unknown";
  }
  return { errorClass, retryable };
};
