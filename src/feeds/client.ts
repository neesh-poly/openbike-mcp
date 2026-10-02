import { GbfsClient } from "../gbfs/client";
import type { GbfsClientOptions, GbfsSystemSource } from "../gbfs/types";
import { adaptVelibDocument } from "./velib";
import { TflClient } from "./tfl";

/** A small format boundary; caching, storage, search, and MCP stay provider-agnostic. */
export const createStationFeedClient = (
  source: GbfsSystemSource,
  options: GbfsClientOptions = {},
): Pick<GbfsClient, "fetchStationBundle"> => {
  switch (source.format ?? "gbfs") {
    case "gbfs":
      return new GbfsClient(source, options);
    case "velib":
      return new GbfsClient(source, { ...options, adaptDocument: adaptVelibDocument });
    case "tfl":
      return new TflClient(source, options);
    default:
      throw new Error("Unsupported station feed format");
  }
};
