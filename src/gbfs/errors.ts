import { GbfsNormalizationError } from "./normalize";
import { OutboundRequestError } from "../security/errors";
import type { GbfsFetchFeedName } from "./types";

/** Adds safe feed identity without exposing a provider URL or response body. */
export class GbfsFeedError extends Error {
  readonly feedName: GbfsFetchFeedName;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  readonly httpStatus: number | undefined;

  constructor(feedName: GbfsFetchFeedName, cause: unknown) {
    const safeCause =
      cause instanceof OutboundRequestError ||
      cause instanceof GbfsNormalizationError;
    super(
      safeCause
        ? cause.message
        : "The upstream GBFS feed could not be processed.",
      { cause },
    );
    const details =
      cause !== null && typeof cause === "object"
        ? (cause as Record<string, unknown>)
        : {};
    this.name = "GbfsFeedError";
    this.feedName = feedName;
    this.code = typeof details.code === "string" ? details.code : undefined;
    this.retryable =
      typeof details.retryable === "boolean" ? details.retryable : undefined;
    this.httpStatus =
      typeof details.httpStatus === "number" ? details.httpStatus : undefined;
  }
}

export const withGbfsFeedError = async <T>(
  feedName: GbfsFetchFeedName,
  operation: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GbfsFeedError) throw error;
    throw new GbfsFeedError(feedName, error);
  }
};

export const getGbfsFailureFeedName = (
  error: unknown,
): GbfsFetchFeedName | undefined =>
  error instanceof GbfsFeedError ? error.feedName : undefined;

