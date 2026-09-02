const endpoint =
  process.argv[2] ??
  process.env.OPENBIKE_MCP_URL ??
  "https://mcp.openbike.neesh.page/mcp";

const post = async (body: unknown): Promise<Record<string, unknown>> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line.length > 0);
    if (data !== undefined) return JSON.parse(data) as Record<string, unknown>;
  }
  throw new Error(`Expected JSON or SSE response, received ${contentType}`);
};

const initialize = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "openbike-raw-smoke", version: "0.1.0" },
  },
});
if (!("result" in initialize)) throw new Error("initialize did not return a result");

const tools = await post({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
});
if (!("result" in tools)) throw new Error("tools/list did not return a result");

const listedTools = (tools.result as { tools?: unknown } | undefined)?.tools;
if (!Array.isArray(listedTools)) throw new Error("tools/list returned no tool array");
console.log(
  JSON.stringify({
    ok: true,
    endpoint,
    protocol_version: (
      initialize.result as { protocolVersion?: unknown } | undefined
    )?.protocolVersion,
    tools: listedTools.flatMap((tool) =>
      typeof tool === "object" && tool !== null && "name" in tool
        ? [String(tool.name)]
        : [],
    ),
  }),
);

export {};
