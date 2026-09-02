import { describe, expect, it, vi } from "vitest";

import {
  logEvent,
  metricDataPoint,
  sanitizeLogFields,
} from "../../src/observability";

describe("privacy-safe observability", () => {
  it("drops coordinates, prompts, query text, auth, URLs, and payloads", () => {
    expect(
      sanitizeLogFields({
        request_id: "req_1",
        system_id: "lyft_nyc",
        latitude: 40.7,
        longitude: -74,
        prompt: "find my bike",
        query: "home address",
        authorization: "Bearer secret",
        url: "https://provider.example/private",
        payload: { secret: true },
      }),
    ).toEqual({ request_id: "req_1", system_id: "lyft_nyc" });
  });

  it("writes a stable Analytics Engine slot layout", () => {
    expect(
      metricDataPoint({
        index: "lyft_nyc",
        event: "provider_refresh",
        component: "system_feed",
        operation: "refresh",
        outcome: "success",
        errorClass: "none",
        cacheStatus: "fresh",
        circuitState: "closed",
        catalogVersion: "v1",
        workerVersion: "0.1.0",
        durationMs: 125,
        resultCount: 50,
        ageSeconds: 3,
        httpStatus: 200,
        attempt: 1,
        consecutiveFailures: 0,
        partial: false,
      }),
    ).toEqual({
      indexes: ["lyft_nyc"],
      blobs: [
        "provider_refresh",
        "system_feed",
        "refresh",
        "success",
        "none",
        "fresh",
        "closed",
        "v1",
        "0.1.0",
      ],
      doubles: [125, 50, 3, 200, 1, 0, 0],
    });
  });

  it("never emits an unapproved field", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logEvent("info", "request_complete", {
      system_id: "lyft_nyc",
      query: "sensitive place",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain('"system_id":"lyft_nyc"');
    expect(spy.mock.calls[0]?.[0]).not.toContain("sensitive place");
    spy.mockRestore();
  });
});
