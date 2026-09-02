import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const input =
  process.argv[2] ??
  process.env.OPENBIKE_MCP_URL ??
  "https://mcp.openbike.neesh.page/mcp";
const mcpUrl = new URL(input.endsWith("/mcp") ? input : `${input.replace(/\/$/, "")}/mcp`);
const baseUrl = new URL("/", mcpUrl);

const percentile = (samples: readonly number[], fraction: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return Math.round((sorted[index] ?? 0) * 10) / 10;
};

const summarize = (samples: readonly number[]) => ({
  samples: samples.length,
  min_ms: Math.round(Math.min(...samples) * 10) / 10,
  p50_ms: percentile(samples, 0.5),
  p95_ms: percentile(samples, 0.95),
  max_ms: Math.round(Math.max(...samples) * 10) / 10,
});

const timedFetch = async (path: string): Promise<number> => {
  const started = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(15_000),
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return performance.now() - started;
};

const healthSamples: number[] = [];
const readinessSamples: number[] = [];
for (let index = 0; index < 10; index += 1) {
  healthSamples.push(await timedFetch("/healthz"));
  readinessSamples.push(await timedFetch("/readyz"));
}

const client = new Client(
  { name: "openbike-platform-fit", version: "0.1.0" },
  { versionNegotiation: { mode: "auto" } },
);
const transport = new StreamableHTTPClientTransport(mcpUrl);
const toolSamples: number[] = [];
try {
  await client.connect(transport, { timeout: 30_000 });
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    const result = await client.callTool(
      { name: "find_systems", arguments: { query: "bike", limit: 20 } },
      { timeout: 30_000 },
    );
    if (result.isError === true) throw new Error("find_systems failed");
    toolSamples.push(performance.now() - started);
  }
} finally {
  await client.close().catch(() => undefined);
}

console.log(
  JSON.stringify(
    {
      measured_at: new Date().toISOString(),
      endpoint: mcpUrl.toString(),
      note: "Client-side wall time from one machine; not an availability SLO measurement.",
      healthz: summarize(healthSamples),
      readyz: summarize(readinessSamples),
      find_systems_warm: summarize(toolSamples),
    },
    null,
    2,
  ),
);
