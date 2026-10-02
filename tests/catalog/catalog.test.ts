import { describe, expect, it } from "vitest";

import {
  BUNDLED_CATALOG,
  CatalogValidationError,
  findCatalogSystems,
  getCatalogSystem,
  validateCatalogSnapshot,
} from "../../src/catalog";
import type { CatalogSnapshot } from "../../src/catalog";

const expandedCatalog = (count: number, version: string): CatalogSnapshot => ({
  ...BUNDLED_CATALOG,
  version,
  systems: Array.from({ length: count }, (_, index) => ({
    ...BUNDLED_CATALOG.systems[0]!,
    system_id: `system-${index}`,
    source_system_id: `System-${index}`,
    name: `System ${index}`,
  })),
});

describe("catalog validation and lookup", () => {
  it("ships seven validated reviewed systems", () => {
    const catalog = validateCatalogSnapshot(BUNDLED_CATALOG);
    expect(catalog.systems.map((system) => system.system_id)).toEqual([
      "lyft_nyc",
      "mobibikes_ca_vancouver",
      "oslobysykkel",
      "nextbike_wr",
      "lyft_bay",
      "bluebikes",
      "lyft_chi",
    ]);
    expect(getCatalogSystem(catalog, "Mobibikes_CA_Vancouver")?.system_id).toBe(
      "mobibikes_ca_vancouver",
    );
    expect(
      getCatalogSystem(catalog, "oslobysykkel")?.request_headers,
    ).toEqual({ "ET-Client-Name": "openbike-mcp" });
  });

  it("selects geographic candidates using buffered bounds", () => {
    const newYork = findCatalogSystems(BUNDLED_CATALOG, {
      latitude: 40.7128,
      longitude: -74.006,
      radiusMeters: 1_000,
    });
    expect(newYork).toHaveLength(1);
    expect(newYork[0]).toMatchObject({
      system: { system_id: "lyft_nyc" },
      distance_meters: 0,
      matched_by: "coverage",
    });

    expect(
      findCatalogSystems(BUNDLED_CATALOG, {
        query: "Vancouver",
        countryCode: "ca",
      })[0]?.system.system_id,
    ).toBe("mobibikes_ca_vancouver");
  });

  it("does not treat unknown coverage as a coordinate match", () => {
    const unknown = {
      ...BUNDLED_CATALOG.systems[0]!,
      system_id: "metadata-only",
      source_system_id: "metadata-only",
      name: "Metadata Only Bikes",
      coverage: {
        bounds: null,
        centroid: null,
        confidence: "unknown" as const,
        buffer_meters: 0,
      },
    };
    const catalog = {
      ...BUNDLED_CATALOG,
      systems: [unknown],
    };
    expect(
      findCatalogSystems(catalog, { query: "Metadata Only" }),
    ).toHaveLength(1);
    expect(
      findCatalogSystems(catalog, {
        latitude: 40.7128,
        longitude: -74.006,
      }),
    ).toEqual([]);
  });

  it("blocks catalog regressions greater than five percent", () => {
    const previous = expandedCatalog(20, "previous");
    expect(() =>
      validateCatalogSnapshot(expandedCatalog(18, "bad"), previous),
    ).toThrow(CatalogValidationError);
    expect(() =>
      validateCatalogSnapshot(expandedCatalog(19, "allowed"), previous),
    ).not.toThrow();
  });

  it("rejects discovery hosts that were not manually reviewed", () => {
    const candidate = structuredClone(BUNDLED_CATALOG);
    candidate.systems[0]!.reviewed_hosts = ["example.com"];
    expect(() => validateCatalogSnapshot(candidate)).toThrow(
      /does not review its discovery host/,
    );
  });

  it("rejects unpaired or invalid geographic input", () => {
    expect(() =>
      findCatalogSystems(BUNDLED_CATALOG, { latitude: 40.7 }),
    ).toThrow(/supplied together/);
    expect(() =>
      findCatalogSystems(BUNDLED_CATALOG, {
        latitude: 91,
        longitude: 0,
      }),
    ).toThrow(/WGS84/);
  });
});
