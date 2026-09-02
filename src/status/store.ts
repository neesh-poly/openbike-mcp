import { sha256Hex, stableJson } from "../catalog/store";
import {
  StatusCycleSchema,
  StatusPointerSchema,
  SystemProbeStatusReferenceSchema,
  SystemProbeStatusSchema,
} from "./types";
import type {
  ProbeDiscoveryMetadata,
  PublicStatus,
  StatusBindings,
  StatusCycle,
  StatusPointer,
  SystemProbeStatus,
} from "./types";

export const STATUS_POINTER_KEY = "status:current";
const STATUS_R2_PREFIX = "status/v1/";

const systemStatusReferenceKey = (cycleId: string, systemId: string): string =>
  `status:cycle:${cycleId}:system:${systemId}`;

const putImmutable = async (
  bucket: Pick<R2Bucket, "get" | "head" | "put">,
  key: string,
  body: string,
): Promise<void> => {
  const existing = await bucket.head(key);
  if (existing === null) {
    await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return;
  }
  const stored = await bucket.get(key);
  if (stored === null || (await stored.text()) !== body) {
    throw new Error("Immutable status object collision");
  }
};

export const beginProbeCycle = async (
  env: StatusBindings,
  cycle: StatusCycle,
): Promise<StatusPointer> => {
  const validated = StatusCycleSchema.parse(cycle);
  const body = stableJson(validated);
  const sha256 = await sha256Hex(body);
  const r2Key = `${STATUS_R2_PREFIX}${validated.cycle_id}/summary-${sha256}.json`;
  await putImmutable(env.CATALOG_R2, r2Key, body);
  const pointer: StatusPointer = {
    schema_version: 1,
    cycle_id: validated.cycle_id,
    catalog_version: validated.catalog_version,
    r2_key: r2Key,
    sha256,
    published_at: validated.started_at,
  };
  await env.CATALOG_KV.put(STATUS_POINTER_KEY, stableJson(pointer));
  return pointer;
};

export const recordProbeStatus = async (
  env: StatusBindings,
  status: SystemProbeStatus,
): Promise<void> => {
  const validated = SystemProbeStatusSchema.parse(status);
  const body = stableJson(validated);
  const sha256 = await sha256Hex(body);
  const key = `${STATUS_R2_PREFIX}${validated.cycle_id}/systems/${validated.system_id}-${sha256}.json`;
  await putImmutable(env.CATALOG_R2, key, body);
  await env.CATALOG_KV.put(
    systemStatusReferenceKey(validated.cycle_id, validated.system_id),
    stableJson({ key, sha256, checked_at: validated.checked_at }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );
};

const readProbeDiscoveryMetadataForSystem = async (
  env: StatusBindings,
  pointer: StatusPointer,
  systemId: string,
): Promise<ProbeDiscoveryMetadata | null> => {
  try {
    const rawReference = await env.CATALOG_KV.get<unknown>(
      systemStatusReferenceKey(pointer.cycle_id, systemId),
      "json",
    );
    const parsedReference = SystemProbeStatusReferenceSchema.safeParse(
      rawReference,
    );
    if (!parsedReference.success) return null;

    const object = await env.CATALOG_R2.get(parsedReference.data.key);
    if (object === null) return null;
    const body = await object.text();
    if ((await sha256Hex(body)) !== parsedReference.data.sha256) return null;

    const parsedStatus = SystemProbeStatusSchema.safeParse(JSON.parse(body));
    if (!parsedStatus.success) return null;
    const status = parsedStatus.data;
    if (
      status.cycle_id !== pointer.cycle_id ||
      status.catalog_version !== pointer.catalog_version ||
      status.system_id !== systemId ||
      status.checked_at !== parsedReference.data.checked_at
    ) {
      return null;
    }
    if (
      status.detected_version === undefined &&
      status.capabilities === undefined &&
      status.last_successful_probe === undefined
    ) {
      return null;
    }
    return {
      cycle_id: status.cycle_id,
      catalog_version: status.catalog_version,
      system_id: status.system_id,
      checked_at: status.checked_at,
      detected_version: status.detected_version ?? null,
      capabilities: status.capabilities ?? null,
      last_successful_probe: status.last_successful_probe ?? null,
    };
  } catch {
    // Discovery metadata is a derived optimization. The immutable catalog is
    // the safe fallback if one status object is missing or corrupt.
    return null;
  }
};

/**
 * Reads the probe-derived overlay for the currently published status cycle.
 * Records from another catalog version are never applied to immutable catalog
 * source data, and individual corrupt/missing records fail closed to fallback.
 */
export const readProbeDiscoveryMetadata = async (
  env: StatusBindings,
  catalogVersion: string,
  systemIds: readonly string[],
): Promise<ReadonlyMap<string, ProbeDiscoveryMetadata>> => {
  const rawPointer = await env.CATALOG_KV.get<unknown>(
    STATUS_POINTER_KEY,
    "json",
  );
  const parsedPointer = StatusPointerSchema.safeParse(rawPointer);
  if (
    !parsedPointer.success ||
    parsedPointer.data.catalog_version !== catalogVersion
  ) {
    return new Map();
  }

  const uniqueIds = [...new Set(systemIds)];
  const records = await Promise.all(
    uniqueIds.map((systemId) =>
      readProbeDiscoveryMetadataForSystem(env, parsedPointer.data, systemId),
    ),
  );
  return new Map(
    records.flatMap((record) =>
      record === null ? [] : [[record.system_id, record] as const],
    ),
  );
};

export const readPublicStatus = async (
  env: StatusBindings,
): Promise<PublicStatus> => {
  const rawPointer = await env.CATALOG_KV.get<unknown>(
    STATUS_POINTER_KEY,
    "json",
  );
  if (rawPointer === null) {
    return {
      service: "openbike-mcp",
      state: "initializing",
      cycle: null,
      last_probe_activity_at: null,
    };
  }
  const pointer = StatusPointerSchema.parse(rawPointer);
  const object = await env.CATALOG_R2.get(pointer.r2_key);
  if (object === null) throw new Error("Current status object is missing");
  const body = await object.text();
  if ((await sha256Hex(body)) !== pointer.sha256) {
    throw new Error("Current status object failed integrity validation");
  }
  const cycle = StatusCycleSchema.parse(JSON.parse(body));
  return {
    service: "openbike-mcp",
    state: "operational",
    cycle,
    last_probe_activity_at: cycle.last_probe_activity_at,
  };
};
