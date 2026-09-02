import { describe, expect, it } from "vitest";

import {
  OutboundRequestError,
  createReviewedHostPolicy,
  validateOutboundUrl,
} from "../../src/security";

describe("reviewed outbound URL policy", () => {
  const policy = createReviewedHostPolicy([
    {
      hostname: "feeds.example.test",
      pathPrefixes: ["/gbfs/provider/"],
      headers: { "ET-Client-Name": "openbike-mcp" },
    },
  ]);

  it("accepts an exact reviewed HTTPS host and path", () => {
    const result = validateOutboundUrl(
      "https://feeds.example.test/gbfs/provider/station_status.json?locale=en",
      policy,
    );

    expect(result.url.hostname).toBe("feeds.example.test");
    expect(result.headers).toEqual({ "ET-Client-Name": "openbike-mcp" });
  });

  it.each([
    "http://feeds.example.test/gbfs/provider/status.json",
    "https://user:secret@feeds.example.test/gbfs/provider/status.json",
    "https://feeds.example.test:8443/gbfs/provider/status.json",
    "https://feeds.example.test/gbfs/provider/status.json#fragment",
    "https://feeds.example.test/gbfs/provider/status.json?api_key=secret",
    "https://unreviewed.example.test/gbfs/provider/status.json",
    "https://feeds.example.test/gbfs/provider-escape/status.json",
    "https://127.0.0.1/gbfs/provider/status.json",
    "https://[::1]/gbfs/provider/status.json",
    "https://2130706433/gbfs/provider/status.json",
  ])("rejects an unsafe destination without echoing it: %s", (url) => {
    let thrown: unknown;
    try {
      validateOutboundUrl(url, policy);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OutboundRequestError);
    expect((thrown as Error).message).not.toContain("secret");
    expect((thrown as Error).message).not.toContain("127.0.0.1");
  });

  it("rejects credential and header-injection policy entries", () => {
    expect(() =>
      createReviewedHostPolicy([
        {
          hostname: "feeds.example.test",
          headers: { Authorization: "Bearer secret" },
        },
      ]),
    ).toThrowError(OutboundRequestError);

    expect(() =>
      createReviewedHostPolicy([
        {
          hostname: "feeds.example.test",
          headers: { "ET-Client-Name": "openbike\r\nX-Injected: yes" },
        },
      ]),
    ).toThrowError(OutboundRequestError);

    expect(() =>
      createReviewedHostPolicy([
        {
          hostname: "feeds.example.test",
          headers: { "X-API-Key": "secret" },
        },
      ]),
    ).toThrowError(OutboundRequestError);
  });
});
