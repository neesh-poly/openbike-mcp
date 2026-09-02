import { BUNDLED_CATALOG } from "./seed";
import {
  CatalogOverridesSchema,
  CatalogPointerSchema,
  CatalogSnapshotSchema,
} from "./types";
import type {
  CatalogBindings,
  CatalogLoadOptions,
  CatalogOverrides,
  CatalogPointer,
  CatalogSnapshot,
} from "./types";
import { validateCatalogSnapshot } from "./validation";

export const CATALOG_POINTER_KEY = "catalog:current";
export const CATALOG_OVERRIDES_KEY = "catalog:overrides";
const CATALOG_POINTER_HISTORY_PREFIX = "catalog:pointer:";
const CATALOG_R2_PREFIX = "catalog/v1/";

const textEncoder = new TextEncoder();

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

export const stableJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const getJson = async <T>(
  namespace: Pick<KVNamespace, "get">,
  key: string,
): Promise<T | null> => namespace.get<T>(key, "json");

export const loadCatalogPointer = async (
  env: Pick<CatalogBindings, "CATALOG_KV">,
  version?: string,
): Promise<CatalogPointer | null> => {
  const key =
    version === undefined
      ? CATALOG_POINTER_KEY
      : `${CATALOG_POINTER_HISTORY_PREFIX}${version}`;
  const raw = await getJson<unknown>(env.CATALOG_KV, key);
  if (raw === null) return null;
  return CatalogPointerSchema.parse(raw);
};

export const loadCatalogByPointer = async (
  env: Pick<CatalogBindings, "CATALOG_R2">,
  pointer: CatalogPointer,
): Promise<CatalogSnapshot> => {
  const object = await env.CATALOG_R2.get(pointer.r2_key);
  if (object === null) {
    throw new Error(`Catalog object ${pointer.r2_key} is missing`);
  }
  const body = await object.text();
  const digest = await sha256Hex(body);
  if (digest !== pointer.sha256) {
    throw new Error(`Catalog object ${pointer.r2_key} failed integrity validation`);
  }
  const catalog = validateCatalogSnapshot(JSON.parse(body));
  if (
    catalog.version !== pointer.version ||
    catalog.systems.length !== pointer.system_count
  ) {
    throw new Error("Catalog object does not match its pointer");
  }
  return catalog;
};

export const loadCatalog = async (
  env: CatalogBindings,
  options: CatalogLoadOptions = {},
): Promise<CatalogSnapshot> => {
  const pointer = await loadCatalogPointer(env, options.version);
  if (pointer === null) {
    if (options.version === undefined && options.allowBundledFallback !== false) {
      return CatalogSnapshotSchema.parse(BUNDLED_CATALOG);
    }
    throw new Error(
      options.version === undefined
        ? "No current catalog has been published"
        : `Catalog version ${options.version} is unavailable`,
    );
  }
  return loadCatalogByPointer(env, pointer);
};

export const loadCatalogOverrides = async (
  env: Pick<CatalogBindings, "CATALOG_KV">,
): Promise<CatalogOverrides> => {
  const raw = await getJson<unknown>(env.CATALOG_KV, CATALOG_OVERRIDES_KEY);
  return raw === null ? {} : CatalogOverridesSchema.parse(raw);
};

export const applyCatalogOverrides = (
  catalog: CatalogSnapshot,
  overrides: CatalogOverrides,
): CatalogSnapshot => ({
  ...catalog,
  systems: catalog.systems.map((system) => {
    const override = overrides[system.system_id];
    if (override === undefined) return system;
    if (
      override.enabled === true &&
      !system.enabled &&
      override.reviewed_hosts === undefined
    ) {
      throw new Error(
        `Enabling ${system.system_id} requires an explicit reviewed-host override`,
      );
    }
    return {
      ...system,
      enabled: override.enabled ?? system.enabled,
      discovery_url: override.discovery_url ?? system.discovery_url,
      reviewed_hosts: override.reviewed_hosts ?? system.reviewed_hosts,
      request_headers: override.request_headers ?? system.request_headers,
      preferred_languages:
        override.preferred_languages ?? system.preferred_languages,
      coverage: override.coverage ?? system.coverage,
      location_hint: override.location_hint ?? system.location_hint,
    };
  }),
});

export interface PublishCatalogResult {
  catalog: CatalogSnapshot;
  pointer: CatalogPointer;
  published: boolean;
}

export const publishCatalog = async (
  env: CatalogBindings,
  candidate: CatalogSnapshot,
  now = new Date(),
): Promise<PublishCatalogResult> => {
  const priorPointer = await loadCatalogPointer(env);
  const previous =
    priorPointer === null ? undefined : await loadCatalogByPointer(env, priorPointer);
  const catalog = validateCatalogSnapshot(candidate, previous);
  const body = stableJson(catalog);
  const sha256 = await sha256Hex(body);
  const versionPointer = await loadCatalogPointer(env, catalog.version);
  if (versionPointer !== null && versionPointer.sha256 !== sha256) {
    throw new Error(
      `Catalog version ${catalog.version} is already bound to immutable content`,
    );
  }
  const r2Key = `${CATALOG_R2_PREFIX}${catalog.version}-${sha256}.json`;
  const existing = await env.CATALOG_R2.head(r2Key);
  if (existing === null) {
    await env.CATALOG_R2.put(r2Key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        schema_version: String(catalog.schema_version),
        version: catalog.version,
        sha256,
      },
    });
  } else {
    const stored = await env.CATALOG_R2.get(r2Key);
    if (stored === null || (await sha256Hex(await stored.text())) !== sha256) {
      throw new Error("Immutable catalog key collision");
    }
  }

  const pointer: CatalogPointer = {
    schema_version: 1,
    version: catalog.version,
    r2_key: r2Key,
    published_at: now.toISOString(),
    system_count: catalog.systems.length,
    enabled_system_count: catalog.systems.filter((system) => system.enabled)
      .length,
    sha256,
    previous_version: priorPointer?.version ?? null,
  };
  const pointerJson = stableJson(pointer);
  if (versionPointer === null) {
    await env.CATALOG_KV.put(
      `${CATALOG_POINTER_HISTORY_PREFIX}${pointer.version}`,
      pointerJson,
    );
  }
  await env.CATALOG_KV.put(CATALOG_POINTER_KEY, pointerJson);
  return {
    catalog,
    pointer,
    published: priorPointer?.sha256 !== pointer.sha256,
  };
};

export const ensureBundledCatalog = async (
  env: CatalogBindings,
  now = new Date(),
): Promise<PublishCatalogResult | null> => {
  const pointer = await loadCatalogPointer(env);
  return pointer === null ? publishCatalog(env, BUNDLED_CATALOG, now) : null;
};

export const rollbackCatalog = async (
  env: CatalogBindings,
  version: string,
  now = new Date(),
): Promise<CatalogPointer> => {
  const target = await loadCatalogPointer(env, version);
  if (target === null) throw new Error(`Catalog version ${version} is unavailable`);
  await loadCatalogByPointer(env, target);
  const current = await loadCatalogPointer(env);
  const rolledBack: CatalogPointer = {
    ...target,
    published_at: now.toISOString(),
    previous_version: current?.version ?? null,
  };
  await env.CATALOG_KV.put(CATALOG_POINTER_KEY, stableJson(rolledBack));
  return rolledBack;
};
