import { describe, expect, it, vi } from "vitest";

import {
  BUNDLED_CATALOG,
  normalizeMobilityDataCatalogRows,
  parseMobilityDataSystemsCsv,
  type MobilityDataSystemRow,
} from "../../src/catalog";
import {
  buildCatalogCandidate,
  probeMessage,
  reconcileCatalogProbeCycle,
  validateMobilityDataRows,
} from "../../src/workflows";
import { queueRetryDelaySeconds } from "../../src/queues";

const sourceRows: MobilityDataSystemRow[] = BUNDLED_CATALOG.systems.map(
  (system) => ({
    system_id: system.source_system_id,
    name: system.name,
    location: system.city ?? "",
    country_code: system.country_code ?? "",
    url: "",
    auto_discovery_url: system.discovery_url,
    supported_versions: system.detected_version ?? "",
    authentication_info_url: "",
    authentication_type: "",
    authentication_parameter_name: "",
  }),
);

describe("catalog refresh workflow helpers", () => {
  it("builds a deterministic reviewed candidate without onboarding URLs", () => {
    const timestamp = new Date("2026-09-02T04:00:00.000Z");
    const candidate = buildCatalogCandidate(
      sourceRows.map((row) =>
        row.system_id === "lyft_nyc"
          ? {
              ...row,
              name: "Upstream Citi Name",
              auto_discovery_url: "https://unreviewed.example/gbfs.json",
            }
          : row,
      ),
      timestamp,
      "a".repeat(64),
      '"etag"',
    );
    expect(candidate.version).toBe("md-20260902T040000000Z-aaaaaaaaaaaaaaaa");
    expect(candidate.systems[0]).toMatchObject({
      name: "Upstream Citi Name",
      discovery_url: BUNDLED_CATALOG.systems[0]!.discovery_url,
      reviewed_hosts: BUNDLED_CATALOG.systems[0]!.reviewed_hosts,
    });
  });

  it("does not let duplicate upstream rows mutate a reviewed system", () => {
    const original = sourceRows[0]!;
    const candidate = buildCatalogCandidate(
      [
        ...sourceRows,
        { ...original, name: "Ambiguous duplicate name" },
      ],
      new Date("2026-09-02T04:00:00.000Z"),
      "c".repeat(64),
      null,
    );
    expect(candidate.systems[0]?.name).toBe(
      BUNDLED_CATALOG.systems[0]?.name,
    );
  });

  it("rejects truncated and duplicate upstream catalogs", () => {
    expect(() => validateMobilityDataRows(sourceRows)).toThrow(/too few/);
    expect(() =>
      validateMobilityDataRows([sourceRows[0]!, sourceRows[0]!], 1),
    ).not.toThrow();
    const duplicateAdmission = normalizeMobilityDataCatalogRows(
      [sourceRows[0]!, sourceRows[0]!],
      [],
    );
    expect(duplicateAdmission.systems).toEqual([]);
    expect(duplicateAdmission.stats.rejected_duplicate_id).toBe(2);
  });

  it("parses MobilityData's canonical headings and keeps malformed rows visible", () => {
    const rows = parseMobilityDataSystemsCsv(
      [
        "\uFEFFCountry Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL,Authentication Type,Authentication Parameter Name",
        "US,Public Bikes,Example City,Public Bikes,https://example.com,https://feeds.example.com/gbfs.json,2.3,,,",
        "US,Missing ID,Example City,,https://example.com,https://feeds.example.com/gbfs.json,2.3,, ,",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      country_code: "US",
      system_id: "Public Bikes",
      auto_discovery_url: "https://feeds.example.com/gbfs.json",
      supported_versions: "2.3",
    });
    expect(rows[1]?.system_id).toBe("");
    expect(() =>
      parseMobilityDataSystemsCsv(
        "Country Code,Name,Location,System ID,Auto-Discovery URL\nUS,Bikes,City,bikes,https://feeds.example.com/gbfs.json",
      ),
    ).toThrow(/missing required columns/);
  });

  it("stages eligible catalog rows as inert candidates with unknown semantics", () => {
    const candidateRows: MobilityDataSystemRow[] = [
      {
        ...sourceRows[0]!,
        system_id: "Biké Sample City",
        name: "Sample Bikes",
        location: "Sample City",
        country_code: "FR",
        auto_discovery_url: "https://feeds.example.com/v2/gbfs.json",
      },
      {
        ...sourceRows[0]!,
        system_id: "private-system",
        authentication_type: "2",
        authentication_info_url: "https://docs.example.com/access",
        authentication_parameter_name: "Authorization",
      },
      {
        ...sourceRows[0]!,
        system_id: "internal-system",
        auto_discovery_url: "https://gbfs.service.internal/gbfs.json",
      },
      {
        ...sourceRows[0]!,
        system_id: "credential-system",
        auto_discovery_url:
          "https://feeds.example.com/gbfs.json?api_key=do-not-admit",
      },
      {
        ...sourceRows[0]!,
        system_id: "plain-http",
        auto_discovery_url: "http://feeds.example.com/gbfs.json",
      },
    ];
    const admission = normalizeMobilityDataCatalogRows(candidateRows, []);
    expect(admission.systems).toHaveLength(1);
    expect(admission.systems[0]).toMatchObject({
      system_id: "bike-sample-city",
      source_system_id: "Biké Sample City",
      country_code: "FR",
      discovery_url: "https://feeds.example.com/v2/gbfs.json",
      detected_version: null,
      capabilities: {
        docked: false,
        dockless: false,
        ebike: false,
        station_status: false,
      },
      coverage: {
        bounds: null,
        centroid: null,
        confidence: "unknown",
        buffer_meters: 0,
      },
      reviewed_hosts: ["feeds.example.com"],
      enabled: false,
    });
    expect(admission.stats).toMatchObject({
      input_rows: 5,
      eligible_rows: 1,
      candidate_systems: 1,
      rejected_authenticated: 1,
      rejected_invalid_url: 3,
    });
  });

  it("includes disabled candidates only behind the candidates phase gate", () => {
    const extra: MobilityDataSystemRow = {
      ...sourceRows[0]!,
      system_id: "sample-extra",
      name: "Sample Extra",
      auto_discovery_url: "https://feeds.example.com/gbfs.json",
    };
    const reviewedOnly = buildCatalogCandidate(
      [...sourceRows, extra],
      new Date("2026-09-02T04:00:00.000Z"),
      "b".repeat(64),
      null,
    );
    const withCandidates = buildCatalogCandidate(
      [...sourceRows, extra],
      new Date("2026-09-02T04:00:00.000Z"),
      "b".repeat(64),
      null,
      { mode: "candidates", minimumEligibleRows: 1 },
    );
    expect(reviewedOnly.systems).toHaveLength(BUNDLED_CATALOG.systems.length);
    expect(withCandidates.systems).toHaveLength(
      BUNDLED_CATALOG.systems.length + 1,
    );
    expect(withCandidates.systems.at(-1)).toMatchObject({
      system_id: "sample-extra",
      enabled: false,
      coverage: { confidence: "unknown" },
    });
  });

  it("uses deterministic at-least-once message keys and bounded retry", () => {
    expect(
      probeMessage(
        "catalog-v1",
        "cycle-v1",
        "lyft_nyc",
        new Date("2026-09-02T04:00:00.000Z"),
        "2026-09-02T04:00:00.000Z",
        4,
      ),
    ).toEqual({
      schema_version: 1,
      cycle_id: "cycle-v1",
      catalog_version: "catalog-v1",
      catalog_published_at: "2026-09-02T04:00:00.000Z",
      system_id: "lyft_nyc",
      idempotency_key: "catalog-v1:lyft_nyc",
      enqueued_at: "2026-09-02T04:00:00.000Z",
      systems_scheduled: 4,
    });
    expect(queueRetryDelaySeconds(1)).toBe(60);
    expect(queueRetryDelaySeconds(10)).toBe(900);
  });

  it("reconciles exactly the enabled systems through the status coordinator", async () => {
    const catalog = buildCatalogCandidate(
      sourceRows,
      new Date("2026-09-02T04:00:00.000Z"),
      "d".repeat(64),
      null,
    );
    const systemIds = catalog.systems
      .filter((system) => system.enabled)
      .map((system) => system.system_id);
    const cycle = {
      schema_version: 1 as const,
      cycle_id: "cycle-reconcile",
      catalog_version: catalog.version,
      catalog_published_at: "2026-09-02T04:00:00.000Z",
      started_at: "2026-09-02T04:00:00.000Z",
      systems_scheduled: systemIds.length,
      systems_completed: 0,
      systems_healthy: 0,
      systems_degraded: 0,
      systems_unavailable: 0,
      last_probe_activity_at: null,
      state: systemIds.length === 0 ? ("complete" as const) : ("probing" as const),
    };
    const expected = { ...cycle, state: "complete" as const };
    const reconcileProbeCycle = vi.fn(async () => expected);
    const getByName = vi.fn(() => ({ reconcileProbeCycle }));
    const checkedAt = new Date("2026-09-02T04:30:00.000Z");

    await expect(
      reconcileCatalogProbeCycle(
        { SYSTEM_FEEDS: { getByName } } as unknown as Pick<
          Env,
          "SYSTEM_FEEDS"
        >,
        catalog,
        cycle,
        checkedAt,
      ),
    ).resolves.toEqual(expected);
    expect(getByName).toHaveBeenCalledWith("__openbike_status__", {
      locationHint: "enam",
    });
    expect(reconcileProbeCycle).toHaveBeenCalledWith(
      cycle,
      systemIds,
      checkedAt.toISOString(),
    );
  });
});
