import { BUNDLED_CATALOG_SYSTEMS } from "../catalog/seed";
import { catalogSource } from "../feeds/source";

/** Compatibility export; all reviewed city configuration lives in catalog/seed.ts. */
export const INITIAL_GBFS_SYSTEMS = BUNDLED_CATALOG_SYSTEMS
  .filter(system => !system.feed_format || ["gbfs", "velib"].includes(system.feed_format))
  .map(catalogSource);

export const findInitialGbfsSystem = (systemId: string) =>
  INITIAL_GBFS_SYSTEMS.find(source => source.systemId === systemId.trim().toLowerCase());
