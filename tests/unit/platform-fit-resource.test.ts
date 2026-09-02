import { describe, expect, it } from "vitest";

import { parseLocalProcessTreeUsage } from "../../scripts/platform-fit-resource";

describe("platform-fit resource reporting", () => {
  it("parses macOS /usr/bin/time output as byte RSS", () => {
    const result = parseLocalProcessTreeUsage(
      `        1.20 real         0.70 user         0.30 sys\n` +
        `           123456789  maximum resident set size\n`,
      "darwin",
    );

    expect(result).toMatchObject({
      supported: true,
      user_cpu_ms: 700,
      system_cpu_ms: 300,
      total_cpu_ms: 1_000,
      peak_rss_bytes: 123_456_789,
    });
  });

  it("parses GNU time output and converts KiB RSS to bytes", () => {
    const result = parseLocalProcessTreeUsage(
      `User time (seconds): 0.70\n` +
        `System time (seconds): 0.30\n` +
        `Maximum resident set size (kbytes): 120000\n`,
      "linux",
    );

    expect(result).toMatchObject({
      supported: true,
      user_cpu_ms: 700,
      system_cpu_ms: 300,
      total_cpu_ms: 1_000,
      peak_rss_bytes: 122_880_000,
    });
  });

  it("marks unsupported hosts instead of inventing measurements", () => {
    expect(parseLocalProcessTreeUsage("", "win32")).toMatchObject({
      supported: false,
      user_cpu_ms: null,
      system_cpu_ms: null,
      total_cpu_ms: null,
      peak_rss_bytes: null,
    });
  });
});
