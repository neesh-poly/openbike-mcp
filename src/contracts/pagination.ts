import { z } from "zod";

import { DomainError } from "./errors";

const MAX_CURSOR_LENGTH = 2_048;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export const CursorPayloadSchema = z
  .object({
    version: z.literal(1),
    catalog_version: z.string().min(1).max(256),
    query_fingerprint: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/),
    offset: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

export interface CursorExpectations {
  catalogVersion: string;
  queryFingerprint: string;
}

const canonicalize = (value: unknown): CanonicalJson => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Query fingerprint values must be finite JSON values");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : canonicalize(entry),
    );
  }

  if (typeof value === "object") {
    const output: { [key: string]: CanonicalJson } = {};
    for (const [key, entry] of Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (entry !== undefined) {
        output[key] = canonicalize(entry);
      }
    }
    return output;
  }

  throw new TypeError("Query fingerprint values must be JSON-compatible");
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const fingerprintQuery = (value: unknown): string => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DomainError("INVALID_ARGUMENT", "Invalid pagination cursor");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const encodeCursor = (
  payload: z.input<typeof CursorPayloadSchema>,
): string => {
  const parsed = CursorPayloadSchema.parse(payload);
  return bytesToBase64Url(new TextEncoder().encode(canonicalJson(parsed)));
};

export const decodeCursor = (
  cursor: string,
  expectations: CursorExpectations,
): CursorPayload => {
  try {
    if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
      throw new Error("invalid length");
    }
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(
      base64UrlToBytes(cursor),
    );
    const payload = CursorPayloadSchema.parse(JSON.parse(json));

    if (payload.catalog_version !== expectations.catalogVersion) {
      throw new Error("catalog changed");
    }
    if (payload.query_fingerprint !== expectations.queryFingerprint) {
      throw new Error("query changed");
    }
    return payload;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError("INVALID_ARGUMENT", "Invalid pagination cursor");
  }
};

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;
