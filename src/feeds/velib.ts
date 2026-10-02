import type { GbfsFetchFeedName } from "../gbfs/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Vélib documents GBFS 1.0, but omits version and renames the envelope clock. */
export const adaptVelibDocument = (_feed: GbfsFetchFeedName, document: unknown): unknown => {
  if (!isRecord(document)) return document;
  return {
    ...document,
    version: document.version ?? "1.0",
    last_updated: document.last_updated ?? document.lastUpdatedOther,
  };
};
