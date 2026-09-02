import { DomainError } from "../contracts/errors";

export type OutboundRequestErrorCode =
  | "INVALID_URL"
  | "BLOCKED_URL"
  | "INVALID_HEADERS"
  | "TOO_MANY_REDIRECTS"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "UPSTREAM_HTTP_ERROR"
  | "RATE_LIMITED"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_JSON"
  | "EMPTY_RESPONSE"
  | "NETWORK_ERROR";

/**
 * An intentionally low-detail error that is safe to cross an MCP boundary.
 * In particular, messages never contain provider URLs, response bodies, or
 * credentials supplied in a rejected URL.
 */
export class OutboundRequestError extends Error {
  readonly code: OutboundRequestErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    code: OutboundRequestErrorCode,
    message: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "OutboundRequestError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
  }
}

export const toDomainError = (error: unknown): DomainError => {
  if (error instanceof DomainError) {
    return error;
  }

  if (!(error instanceof OutboundRequestError)) {
    return new DomainError(
      "INTERNAL_ERROR",
      "The upstream feed could not be processed.",
      false,
    );
  }

  if (error.code === "RATE_LIMITED") {
    return new DomainError("RATE_LIMITED", error.message, true);
  }

  if (
    error.code === "INVALID_JSON" ||
    error.code === "INVALID_CONTENT_TYPE" ||
    error.code === "EMPTY_RESPONSE" ||
    error.code === "RESPONSE_TOO_LARGE"
  ) {
    return new DomainError("UNSUPPORTED_FEED", error.message, error.retryable);
  }

  return new DomainError(
    "SYSTEM_UNAVAILABLE",
    error.message,
    error.retryable,
  );
};
