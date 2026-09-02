import { OutboundRequestError } from "./errors";

export interface ReviewedHostRule {
  /** Exact DNS hostname. Wildcards and IP literals are intentionally rejected. */
  hostname: string;
  /** Optional normalized path prefixes that this host may serve. */
  pathPrefixes?: readonly string[];
  /** Non-secret provider-required headers, such as ET-Client-Name. */
  headers?: Readonly<Record<string, string>>;
}

export interface ReviewedHostPolicy {
  readonly rules: ReadonlyMap<string, ReviewedHostRule>;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const isIpv4Literal = (hostname: string): boolean => {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
};

export const isIpLiteral = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized.includes(":") || isIpv4Literal(normalized);
};

const validateHeader = (name: string, value: string): void => {
  const normalizedName = name.trim().toLowerCase();
  const credentialLikeName =
    /(?:auth|token|secret|credential|api[-_]?key)/.test(normalizedName) ||
    normalizedName === "key" ||
    normalizedName.endsWith("-key");
  if (
    normalizedName.length === 0 ||
    !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalizedName) ||
    FORBIDDEN_REQUEST_HEADERS.has(normalizedName) ||
    credentialLikeName ||
    value.length > 1_024 ||
    /[\r\n]/.test(value)
  ) {
    throw new OutboundRequestError(
      "INVALID_HEADERS",
      "The configured upstream request headers are not allowed.",
    );
  }
};

const normalizePathPrefix = (prefix: string): string => {
  if (!prefix.startsWith("/") || prefix.includes("?") || prefix.includes("#")) {
    throw new OutboundRequestError(
      "INVALID_URL",
      "The reviewed upstream path policy is invalid.",
    );
  }
  return new URL(prefix, "https://policy.invalid").pathname;
};

export const createReviewedHostPolicy = (
  rules: readonly ReviewedHostRule[],
): ReviewedHostPolicy => {
  const normalizedRules = new Map<string, ReviewedHostRule>();

  for (const rule of rules) {
    const hostname = rule.hostname.trim().toLowerCase().replace(/\.$/, "");
    if (
      hostname.length === 0 ||
      hostname.includes("*") ||
      hostname.includes(":") ||
      hostname.includes("/") ||
      isIpLiteral(hostname)
    ) {
      throw new OutboundRequestError(
        "INVALID_URL",
        "The reviewed upstream host policy is invalid.",
      );
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(rule.headers ?? {})) {
      validateHeader(name, value);
      headers[name] = value;
    }

    const pathPrefixes = rule.pathPrefixes?.map(normalizePathPrefix);
    normalizedRules.set(hostname, {
      hostname,
      ...(pathPrefixes === undefined ? {} : { pathPrefixes }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    });
  }

  if (normalizedRules.size === 0) {
    throw new OutboundRequestError(
      "INVALID_URL",
      "At least one reviewed upstream host is required.",
    );
  }

  return { rules: normalizedRules };
};

const pathMatchesPrefix = (pathname: string, prefix: string): boolean => {
  if (prefix === "/") {
    return true;
  }
  const boundaryPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname === prefix || pathname.startsWith(boundaryPrefix);
};

export interface ValidatedOutboundUrl {
  url: URL;
  headers: Readonly<Record<string, string>>;
}

export const validateOutboundUrl = (
  input: string | URL,
  policy: ReviewedHostPolicy,
): ValidatedOutboundUrl => {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new OutboundRequestError(
      "INVALID_URL",
      "The upstream feed URL is invalid.",
    );
  }

  const hasCredentialLikeParameter = [...url.searchParams.keys()].some((key) =>
    /(?:auth|token|secret|credential|api[-_]?key|password)/i.test(key),
  );

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hash.length > 0 ||
    isIpLiteral(url.hostname) ||
    hasCredentialLikeParameter
  ) {
    throw new OutboundRequestError(
      "BLOCKED_URL",
      "The upstream feed URL is not permitted.",
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const rule = policy.rules.get(hostname);
  if (rule === undefined) {
    throw new OutboundRequestError(
      "BLOCKED_URL",
      "The upstream feed host has not been reviewed.",
    );
  }

  if (
    rule.pathPrefixes !== undefined &&
    !rule.pathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix))
  ) {
    throw new OutboundRequestError(
      "BLOCKED_URL",
      "The upstream feed path has not been reviewed.",
    );
  }

  return { url, headers: rule.headers ?? {} };
};
