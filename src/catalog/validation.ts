import { CatalogSnapshotSchema } from "./types";
import type { CatalogSnapshot, CatalogSystem } from "./types";
import { createReviewedHostPolicy } from "../security";

export const MAX_CATALOG_REGRESSION_FRACTION = 0.05;

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

const validateSystem = (system: CatalogSystem): void => {
  const discoveryHost = new URL(system.discovery_url).hostname.toLowerCase();
  if (!system.reviewed_hosts.includes(discoveryHost)) {
    throw new CatalogValidationError(
      `System ${system.system_id} does not review its discovery host`,
    );
  }
  if (new Set(system.reviewed_hosts).size !== system.reviewed_hosts.length) {
    throw new CatalogValidationError(
      `System ${system.system_id} repeats a reviewed host`,
    );
  }
  try {
    createReviewedHostPolicy(
      system.reviewed_hosts.map((hostname) => ({
        hostname,
        ...(Object.keys(system.request_headers).length === 0
          ? {}
          : { headers: system.request_headers }),
      })),
    );
  } catch {
    throw new CatalogValidationError(
      `System ${system.system_id} contains an invalid host or header policy`,
    );
  }
};

export const validateCatalogSnapshot = (
  candidate: unknown,
  previous?: CatalogSnapshot,
): CatalogSnapshot => {
  const parsed = CatalogSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CatalogValidationError(
      `Catalog schema validation failed: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    );
  }
  const catalog = parsed.data;
  const ids = new Set<string>();
  for (const system of catalog.systems) {
    if (ids.has(system.system_id)) {
      throw new CatalogValidationError(
        `Catalog repeats system ID ${system.system_id}`,
      );
    }
    ids.add(system.system_id);
    validateSystem(system);
  }

  if (previous !== undefined) {
    const enabledBefore = previous.systems.filter((system) => system.enabled).length;
    const enabledAfter = catalog.systems.filter((system) => system.enabled).length;
    if (enabledBefore > 0) {
      const minimumAllowed = Math.ceil(
        enabledBefore * (1 - MAX_CATALOG_REGRESSION_FRACTION),
      );
      if (enabledAfter < minimumAllowed) {
        throw new CatalogValidationError(
          `Catalog regression blocked: ${enabledBefore} enabled systems became ${enabledAfter}`,
        );
      }
    }
  }

  return catalog;
};
