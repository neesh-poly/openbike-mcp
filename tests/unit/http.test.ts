import { describe, expect, it, vi } from "vitest";

import { MCP_ALLOWED_HOSTNAMES, runtimeConfig } from "../../src/config";
import { DomainError } from "../../src/contracts";
import { applyHttpRateLimit } from "../../src/http/rate-limit";
import { jsonResponse } from "../../src/http/responses";
import { failureResult, successResult } from "../../src/mcp/results";

const configEnv = {
  ENVIRONMENT: "staging",
  PUBLIC_BASE_URL: "https://example.test",
  CONTACT_EMAIL: "maintainer@example.test",
  MAX_CANDIDATE_SYSTEMS: "999",
  MAX_FEED_BYTES: "999999999",
  MAX_MCP_RESPONSE_BYTES: "0",
} as unknown as Env;

describe("runtime config", () => {
  it("applies defensive maximums and defaults", () => {
    const config = runtimeConfig(configEnv);
    expect(config.maxCandidateSystems).toBe(4);
    expect(config.maxFeedBytes).toBe(8 * 1024 * 1024);
    expect(config.maxMcpResponseBytes).toBe(1024 * 1024);
  });

  it("does not admit a production workers.dev bypass hostname", () => {
    expect(MCP_ALLOWED_HOSTNAMES).not.toContain(
      "openbike-mcp-production.ilios.workers.dev",
    );
  });
});

describe("HTTP responses", () => {
  it("sets defensive JSON headers", async () => {
    const response = jsonResponse({ ok: true });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns a stable public rate-limit error", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = { EDGE_RATE_LIMITER: { limit } } as unknown as Env;
    const response = await applyHttpRateLimit(
      new Request("https://example.test/mcp", {
        headers: { "cf-connecting-ip": "192.0.2.1" },
      }),
      env,
    );

    expect(limit).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
  });
});

describe("MCP result shaping", () => {
  it("enforces the encoded response budget", () => {
    expect(() => successResult({ value: "too long" }, 2)).toThrow(
      DomainError,
    );
  });

  it("duplicates structured output as parseable text for content-only clients", () => {
    const output = { value: "usable", nested: { count: 2 } };
    const result = successResult(output, 1_024);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual(output);
    expect(result.structuredContent).toEqual(output);
  });

  it("does not expose unexpected exception messages", () => {
    const result = failureResult(new Error("secret upstream payload"), "req-1");
    expect(result.content[0]?.text).not.toContain("secret upstream payload");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      error: { code: "INTERNAL_ERROR", request_id: "req-1" },
    });
  });
});
