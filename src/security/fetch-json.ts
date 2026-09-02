import { OutboundRequestError } from "./errors";
import {
  type ReviewedHostPolicy,
  validateOutboundUrl,
} from "./url-policy";

export const DEFAULT_MAX_FEED_BYTES = 4_194_304;
export const DEFAULT_MAX_JSON_DEPTH = 64;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_REDIRECTS = 3;

export interface ConditionalRequestMetadata {
  etag?: string;
  lastModified?: string;
}

export interface ResponseMetadata extends ConditionalRequestMetadata {
  contentHash?: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchBoundedJsonOptions {
  policy: ReviewedHostPolicy;
  fetcher?: FetchLike;
  conditional?: ConditionalRequestMetadata;
  maxBytes?: number;
  maxJsonDepth?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  now?: () => Date;
}

interface FetchResultBase {
  status: number;
  fetchedAt: string;
  metadata: ResponseMetadata;
}

export interface FreshJsonResult extends FetchResultBase {
  kind: "fresh";
  document: unknown;
}

export interface NotModifiedJsonResult extends FetchResultBase {
  kind: "not_modified";
}

export type FetchBoundedJsonResult = FreshJsonResult | NotModifiedJsonResult;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const nonnegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
};

const boundedHeader = (value: string | null): string | undefined => {
  if (value === null) {
    return undefined;
  }
  return value.slice(0, 1_024);
};

const responseMetadata = (response: Response): ResponseMetadata => {
  const etag = boundedHeader(response.headers.get("etag"));
  const lastModified = boundedHeader(response.headers.get("last-modified"));
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
};

const contentLengthExceeds = (
  contentLength: string | null,
  maxBytes: number,
): boolean => {
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) {
    return false;
  }
  try {
    return BigInt(contentLength.trim()) > BigInt(maxBytes);
  } catch {
    return false;
  }
};

const isJsonContentType = (value: string | null): boolean => {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    /^application\/[a-z0-9!#$%&'*+.^_`|~-]+\+json$/.test(mediaType ?? "")
  );
};

const assertJsonContentType = (response: Response): void => {
  if (isJsonContentType(response.headers.get("content-type"))) return;
  throw new OutboundRequestError(
    "INVALID_CONTENT_TYPE",
    "The upstream feed did not return a JSON content type.",
  );
};

/**
 * Reject deeply nested documents before JSON.parse creates a value that later
 * recursive consumers cannot safely traverse. This lexical pass deliberately
 * ignores structural characters inside JSON strings; JSON.parse remains the
 * source of truth for all other syntax validation.
 */
const assertJsonNesting = (json: string, maxDepth: number): void => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const character of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maxDepth) {
        throw new OutboundRequestError(
          "INVALID_JSON",
          "The upstream feed JSON exceeded the configured nesting limit.",
        );
      }
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
};

const readBoundedBody = async (
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> => {
  if (contentLengthExceeds(response.headers.get("content-length"), maxBytes)) {
    await response.body?.cancel();
    throw new OutboundRequestError(
      "RESPONSE_TOO_LARGE",
      "The upstream feed exceeded the configured size limit.",
    );
  }

  if (response.body === null) {
    throw new OutboundRequestError(
      "EMPTY_RESPONSE",
      "The upstream feed returned an empty response.",
    );
  }

  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        totalBytes += result.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new OutboundRequestError(
            "RESPONSE_TOO_LARGE",
            "The upstream feed exceeded the configured size limit.",
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }

    if (totalBytes === 0) {
      throw new OutboundRequestError(
        "EMPTY_RESPONSE",
        "The upstream feed returned an empty response.",
      );
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  };

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(
        new OutboundRequestError(
          "TIMEOUT",
          "The upstream feed response timed out.",
          { retryable: true },
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const sha256 = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", body);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
};

const fetchWithDeadline = async (
  fetcher: FetchLike,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new OutboundRequestError(
          "TIMEOUT",
          "The upstream feed request timed out.",
          { retryable: true },
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      throw error;
    }
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      throw new OutboundRequestError(
        "TIMEOUT",
        "The upstream feed request timed out.",
        { retryable: true },
      );
    }
    throw new OutboundRequestError(
      "NETWORK_ERROR",
      "The upstream feed request failed.",
      { retryable: true },
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const makeHeaders = (
  policyHeaders: Readonly<Record<string, string>>,
  conditional: ConditionalRequestMetadata | undefined,
): Headers => {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(policyHeaders)) {
    headers.set(name, value);
  }
  if (conditional?.etag !== undefined) {
    if (conditional.etag.length > 1_024 || /[\r\n]/.test(conditional.etag)) {
      throw new OutboundRequestError(
        "INVALID_HEADERS",
        "The cached upstream validator is invalid.",
      );
    }
    headers.set("if-none-match", conditional.etag);
  }
  if (conditional?.lastModified !== undefined) {
    if (
      conditional.lastModified.length > 1_024 ||
      /[\r\n]/.test(conditional.lastModified)
    ) {
      throw new OutboundRequestError(
        "INVALID_HEADERS",
        "The cached upstream validator is invalid.",
      );
    }
    headers.set("if-modified-since", conditional.lastModified);
  }
  return headers;
};

export const fetchBoundedJson = async (
  input: string | URL,
  options: FetchBoundedJsonOptions,
): Promise<FetchBoundedJsonResult> => {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_FEED_BYTES,
    "maxBytes",
  );
  const maxJsonDepth = positiveInteger(
    options.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
    "maxJsonDepth",
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxRedirects = nonnegativeInteger(
    options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    "maxRedirects",
  );
  const now = options.now ?? (() => new Date());
  const deadline = Date.now() + timeoutMs;
  const remainingTimeout = (): number => {
    const remaining = deadline - Date.now();
    if (remaining < 1) {
      throw new OutboundRequestError(
        "TIMEOUT",
        "The upstream feed request timed out.",
        { retryable: true },
      );
    }
    return remaining;
  };

  let current = validateOutboundUrl(input, options.policy);
  let conditional = options.conditional;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchWithDeadline(
      fetcher,
      current.url,
      {
        method: "GET",
        redirect: "manual",
        // Workers has no ambient browser cookie jar. Credential-bearing headers
        // and URL user-info are rejected by the reviewed-host policy.
        headers: makeHeaders(current.headers, conditional),
      },
      remainingTimeout(),
    );

    if (redirectStatuses.has(response.status)) {
      if (redirectCount >= maxRedirects) {
        await response.body?.cancel();
        throw new OutboundRequestError(
          "TOO_MANY_REDIRECTS",
          "The upstream feed redirected too many times.",
          { retryable: true },
        );
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) {
        throw new OutboundRequestError(
          "UPSTREAM_HTTP_ERROR",
          "The upstream feed returned an invalid redirect.",
          { retryable: true, httpStatus: response.status },
        );
      }

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, current.url);
      } catch {
        throw new OutboundRequestError(
          "BLOCKED_URL",
          "The upstream feed redirected to an invalid destination.",
        );
      }
      const next = validateOutboundUrl(redirectUrl, options.policy);
      if (next.url.origin !== current.url.origin) {
        conditional = undefined;
      }
      current = next;
      continue;
    }

    const metadata = responseMetadata(response);
    const fetchedAt = now().toISOString();
    if (response.status === 304) {
      await response.body?.cancel();
      return { kind: "not_modified", status: 304, fetchedAt, metadata };
    }

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      if (response.status === 429) {
        throw new OutboundRequestError(
          "RATE_LIMITED",
          "The upstream feed rate limit was reached.",
          { retryable: true, httpStatus: response.status },
        );
      }
      throw new OutboundRequestError(
        "UPSTREAM_HTTP_ERROR",
        "The upstream feed returned an unsuccessful response.",
        { retryable: response.status >= 500, httpStatus: response.status },
      );
    }

    try {
      assertJsonContentType(response);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }

    let body: Uint8Array;
    try {
      body = await readBoundedBody(response, maxBytes, remainingTimeout());
    } catch (error) {
      if (error instanceof OutboundRequestError) {
        throw error;
      }
      throw new OutboundRequestError(
        "NETWORK_ERROR",
        "The upstream feed response could not be read.",
        { retryable: true },
      );
    }

    let document: unknown;
    try {
      const json = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(body);
      assertJsonNesting(json, maxJsonDepth);
      document = JSON.parse(json);
    } catch (error) {
      if (error instanceof OutboundRequestError) throw error;
      throw new OutboundRequestError(
        "INVALID_JSON",
        "The upstream feed did not return valid JSON.",
      );
    }

    return {
      kind: "fresh",
      status: response.status,
      fetchedAt,
      metadata: { ...metadata, contentHash: await sha256(body) },
      document,
    };
  }
};
