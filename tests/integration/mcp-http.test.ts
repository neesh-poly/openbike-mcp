import { describe, expect, it, vi } from "vitest";

import worker from "../../src/index";

const testContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe("MCP HTTP transport", () => {
  it("allows modern browser MCP request headers in CORS preflight", async () => {
    const requestedHeaders = [
      "authorization",
      "content-type",
      "mcp-method",
      "mcp-name",
      "mcp-protocol-version",
      "mcp-session-id",
    ];
    const response = await worker.fetch(
      new Request("https://openbike-mcp-staging.ilios.workers.dev/mcp", {
        method: "OPTIONS",
        headers: {
          host: "openbike-mcp-staging.ilios.workers.dev",
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": requestedHeaders.join(", "),
        },
      }),
      {
        METRICS: { writeDataPoint: vi.fn() },
      } as unknown as Env,
      testContext,
    );

    expect(response.status).toBe(200);
    const allowedHeaders = new Set(
      (response.headers.get("access-control-allow-headers") ?? "")
        .toLowerCase()
        .split(",")
        .map((header) => header.trim()),
    );
    for (const header of requestedHeaders) {
      expect(allowedHeaders.has(header), `${header} should be allowed`).toBe(true);
    }
  });

  it("answers GET and HEAD readiness from KV without reading the R2 catalog", async () => {
    const getR2 = vi.fn(() => {
      throw new Error("readiness must not read R2");
    });
    const limit = vi.fn(async () => ({ success: true }));
    const getKv = vi.fn(async () => ({
      schema_version: 1,
      version: "catalog-pointer-only",
      r2_key: "catalog/v1/pointer-only.json",
      published_at: "2026-09-02T16:00:00.000Z",
      system_count: 500,
      enabled_system_count: 4,
      sha256: "a".repeat(64),
      previous_version: null,
    }));
    const testEnv = {
      CATALOG_KV: { get: getKv },
      CATALOG_R2: { get: getR2 },
      EDGE_RATE_LIMITER: { limit },
    } as unknown as Env;
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request("https://openbike-mcp-staging.ilios.workers.dev/readyz", {
          method,
        }),
        testEnv,
        testContext,
      );
      expect(response.status).toBe(200);
      if (method === "GET") {
        await expect(response.json()).resolves.toMatchObject({
          ready: true,
          catalog_version: "catalog-pointer-only",
          systems: 4,
        });
      } else {
        expect(await response.text()).toBe("");
      }
    }
    expect(getKv).toHaveBeenCalledTimes(2);
    expect(getR2).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("rate-limits billable status reads before touching storage", async () => {
    const getKv = vi.fn();
    const getR2 = vi.fn();
    const response = await worker.fetch(
      new Request("https://openbike-mcp-staging.ilios.workers.dev/status", {
        headers: { "cf-connecting-ip": "192.0.2.44" },
      }),
      {
        EDGE_RATE_LIMITER: {
          limit: vi.fn(async () => ({ success: false })),
        },
        CATALOG_KV: { get: getKv },
        CATALOG_R2: { get: getR2 },
      } as unknown as Env,
      testContext,
    );

    expect(response.status).toBe(429);
    expect(getKv).not.toHaveBeenCalled();
    expect(getR2).not.toHaveBeenCalled();
  });

  it.each([
    ["plain", ""],
    ["UTF-8 BOM-prefixed", "\uFEFF"],
  ])(
    "rejects a %s JSON-RPC batch before any tool call can execute",
    async (_description, prefix) => {
      const getCatalog = vi.fn();
      const limit = vi.fn(async () => ({ success: true }));
      const response = await worker.fetch(
        new Request("https://openbike-mcp-staging.ilios.workers.dev/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            host: "openbike-mcp-staging.ilios.workers.dev",
          },
          body:
            prefix +
            JSON.stringify([
              {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "find_systems", arguments: { limit: 4 } },
              },
              {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "find_systems", arguments: { limit: 4 } },
              },
            ]),
        }),
        {
          EDGE_RATE_LIMITER: { limit },
          CATALOG_KV: { get: getCatalog },
        } as unknown as Env,
        testContext,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "JSON-RPC batch requests are not supported.",
        },
        id: null,
      });
      expect(limit).toHaveBeenCalledOnce();
      expect(getCatalog).not.toHaveBeenCalled();
    },
  );
});
