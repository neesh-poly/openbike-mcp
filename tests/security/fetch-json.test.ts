import { gzipSync, gunzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_FEED_BYTES,
  DEFAULT_MAX_JSON_DEPTH,
  OutboundRequestError,
  createReviewedHostPolicy,
  fetchBoundedJson,
  type FetchLike,
} from "../../src/security";

const policy = createReviewedHostPolicy([
  {
    hostname: "one.example.test",
    pathPrefixes: ["/gbfs/"],
    headers: { "ET-Client-Name": "openbike-mcp" },
  },
  {
    hostname: "two.example.test",
    pathPrefixes: ["/gbfs/"],
    headers: { "X-Feed-Client": "openbike" },
  },
]);

describe("bounded JSON fetching", () => {
  it("uses a 4 MiB upstream default", () => {
    expect(DEFAULT_MAX_FEED_BYTES).toBe(4_194_304);
    expect(DEFAULT_MAX_JSON_DEPTH).toBe(64);
  });

  it("sends validators and returns safe response metadata", async () => {
    const fetcher = vi.fn<FetchLike>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(headers.get("if-none-match")).toBe('"feed-v1"');
      expect(headers.get("if-modified-since")).toBe(
        "Wed, 02 Sep 2026 14:00:00 GMT",
      );
      expect(headers.get("et-client-name")).toBe("openbike-mcp");
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag: '"feed-v2"',
          "last-modified": "Wed, 02 Sep 2026 14:30:00 GMT",
        },
      });
    });

    const result = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher,
        conditional: {
          etag: '"feed-v1"',
          lastModified: "Wed, 02 Sep 2026 14:00:00 GMT",
        },
        now: () => new Date("2026-09-02T14:30:00Z"),
      },
    );

    expect(result.kind).toBe("fresh");
    if (result.kind === "fresh") {
      expect(result.document).toEqual({ ok: true });
      expect(result.metadata.etag).toBe('"feed-v2"');
      expect(result.metadata.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("returns a not-modified result without trying to parse a body", async () => {
    const result = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher: async () =>
          new Response(null, { status: 304, headers: { etag: '"v1"' } }),
      },
    );
    expect(result).toMatchObject({
      kind: "not_modified",
      status: 304,
      metadata: { etag: '"v1"' },
    });
  });

  it("rejects an oversized declared content length before reading", async () => {
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        maxBytes: 10,
        fetcher: async () =>
          new Response("{}", {
            headers: {
              "content-length": "11",
              "content-type": "application/json",
            },
          }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("RESPONSE_TOO_LARGE");
  });

  it("enforces the actual streaming byte cap when length is absent or wrong", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too large"}'));
        controller.close();
      },
    });
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        maxBytes: 12,
        fetcher: async () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("RESPONSE_TOO_LARGE");
  });

  it("manually validates redirects and strips validators across origins", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = input.toString();
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("one.example.test")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://two.example.test/gbfs/status.json",
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await fetchBoundedJson("https://one.example.test/gbfs/status.json", {
      policy,
      fetcher,
      conditional: { etag: '"origin-specific"' },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("if-none-match")).toBe('"origin-specific"');
    expect(requests[1]?.headers.get("if-none-match")).toBeNull();
    expect(requests[1]?.headers.get("et-client-name")).toBeNull();
    expect(requests[1]?.headers.get("x-feed-client")).toBe("openbike");
  });

  it("blocks redirects to unreviewed hosts before making the second request", async () => {
    const fetcher = vi.fn<FetchLike>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://internal.invalid/secret" },
      }),
    );
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      { policy, fetcher },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("BLOCKED_URL");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out even when a test fetcher does not observe abort", async () => {
    const never: FetchLike = async () => new Promise<Response>(() => undefined);
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      { policy, fetcher: never, timeoutMs: 5 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("TIMEOUT");
    expect((error as OutboundRequestError).retryable).toBe(true);
  });

  it("also times out a response body that stops streaming", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      pull: async () => new Promise<void>(() => undefined),
    });
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher: async () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
        timeoutMs: 5,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("TIMEOUT");
  });

  it("rejects poisoned cached validators before fetching", async () => {
    const fetcher = vi.fn<FetchLike>();
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher,
        conditional: { etag: '"v1"\r\nAuthorization: secret' },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("INVALID_HEADERS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never includes provider response bodies in parse errors", async () => {
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher: async () =>
          new Response("secret provider diagnostic", {
            headers: { "content-type": "application/json" },
          }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as Error).message).not.toContain("secret provider diagnostic");
    expect((error as OutboundRequestError).code).toBe("INVALID_JSON");
  });

  it("requires a JSON media type on successful responses", async () => {
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher: async () =>
          new Response('{"looks":"json"}', {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe(
      "INVALID_CONTENT_TYPE",
    );
  });

  it("accepts structured JSON media types", async () => {
    const result = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        fetcher: async () =>
          new Response('{"ok":true}', {
            headers: { "content-type": "application/gbfs+json" },
          }),
      },
    );

    expect(result).toMatchObject({ kind: "fresh", document: { ok: true } });
  });

  it("rejects JSON that exceeds the configured nesting limit", async () => {
    const nested = `${"[".repeat(5)}0${"]".repeat(5)}`;
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        maxJsonDepth: 4,
        fetcher: async () =>
          new Response(nested, {
            headers: { "content-type": "application/json" },
          }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("INVALID_JSON");
    expect((error as Error).message).toContain("nesting limit");
  });

  it("does not count structural characters inside JSON strings as nesting", async () => {
    const result = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        maxJsonDepth: 1,
        fetcher: async () =>
          new Response('{"value":"[[{\\\"deep-looking\\\":true}]]"}', {
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(result).toMatchObject({
      kind: "fresh",
      document: { value: '[[{"deep-looking":true}]]' },
    });
  });

  it("caps decompression-expanded bytes, not only compressed content length", async () => {
    const expanded = new TextEncoder().encode(
      JSON.stringify({ value: "x".repeat(4_096) }),
    );
    const compressed = gzipSync(expanded);
    expect(compressed.byteLength).toBeLessThan(512);

    // Worker fetch bodies are decoded when consumed. Keep the origin's smaller
    // encoded Content-Length to ensure the stream cap measures decoded bytes.
    const decoded = new Uint8Array(gunzipSync(compressed));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(decoded.subarray(0, 256));
        controller.enqueue(decoded.subarray(256));
        controller.close();
      },
    });
    const error = await fetchBoundedJson(
      "https://one.example.test/gbfs/status.json",
      {
        policy,
        maxBytes: 512,
        fetcher: async () =>
          new Response(body, {
            headers: {
              "content-encoding": "gzip",
              "content-length": String(compressed.byteLength),
              "content-type": "application/json",
            },
          }),
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundRequestError);
    expect((error as OutboundRequestError).code).toBe("RESPONSE_TOO_LARGE");
  });
});
