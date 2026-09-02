import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";

const endpoint = new URL(
  process.argv[2] ??
    process.env.OPENBIKE_MCP_URL ??
    "https://mcp.openbike.neesh.page/mcp",
);

const REQUIRED_TOOLS = [
  "find_stations",
  "find_systems",
  "get_nearby_availability",
  "get_station",
  "get_system_health",
] as const;

const assertSuccessful = (name: string, result: CallToolResult): void => {
  if (result.isError === true) {
    throw new Error(`${name} returned a tool error: ${JSON.stringify(result.content)}`);
  }
  if (result.structuredContent === undefined) {
    throw new Error(`${name} did not return structured content`);
  }
  const text = result.content.find((item) => item.type === "text")?.text;
  if (text === undefined) {
    throw new Error(`${name} did not return content-only compatible JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} returned non-JSON text content`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(result.structuredContent)) {
    throw new Error(`${name} text content did not match structured content`);
  }
};

const stationIdentity = (
  result: CallToolResult,
): { systemId: string; stationId: string } => {
  const content = result.structuredContent;
  if (typeof content !== "object" || content === null || !("results" in content)) {
    throw new Error("find_stations returned an unexpected result shape");
  }
  const results = (content as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("find_stations returned no stations for the live canary");
  }
  const first = results[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("find_stations returned an invalid station result");
  }
  const station = (first as { station?: unknown }).station;
  if (typeof station !== "object" || station === null) {
    throw new Error("find_stations omitted station identity");
  }
  const { system_id: systemId, station_id: stationId } = station as {
    system_id?: unknown;
    station_id?: unknown;
  };
  if (typeof systemId !== "string" || typeof stationId !== "string") {
    throw new Error("find_stations returned malformed station identity");
  }
  return { systemId, stationId };
};

const exerciseClient = async (
  label: string,
  mode: VersionNegotiationMode,
): Promise<void> => {
  const client = new Client(
    { name: `openbike-${label}-smoke`, version: "0.1.0" },
    { versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(endpoint);
  try {
    await client.connect(transport, { timeout: 30_000 });
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const required of REQUIRED_TOOLS) {
      if (!names.has(required)) throw new Error(`${label} client did not list ${required}`);
    }

    const systems = await client.callTool({
      name: "find_systems",
      arguments: { query: "New York", limit: 4 },
    });
    assertSuccessful("find_systems", systems);

    const nearby = await client.callTool({
      name: "get_nearby_availability",
      arguments: {
        latitude: 40.758,
        longitude: -73.9855,
        mode: "either",
        radius_meters: 1_500,
        limit: 5,
        system_ids: ["lyft_nyc"],
        max_staleness_seconds: 600,
      },
    });
    assertSuccessful("get_nearby_availability", nearby);

    const stations = await client.callTool({
      name: "find_stations",
      arguments: {
        latitude: 40.758,
        longitude: -73.9855,
        radius_meters: 2_000,
        system_ids: ["lyft_nyc"],
        include_status: true,
        operational_only: false,
        limit: 10,
      },
    });
    assertSuccessful("find_stations", stations);
    const identity = stationIdentity(stations);

    const station = await client.callTool({
      name: "get_station",
      arguments: {
        system_id: identity.systemId,
        station_id: identity.stationId,
        include_status: true,
        include_raw_links: true,
      },
    });
    assertSuccessful("get_station", station);

    const health = await client.callTool({
      name: "get_system_health",
      arguments: { system_id: "lyft_nyc" },
    });
    assertSuccessful("get_system_health", health);
  } finally {
    await client.close().catch(() => undefined);
  }
};

await exerciseClient("modern", "auto");
await exerciseClient("legacy", "legacy");

console.log(
  JSON.stringify({
    ok: true,
    endpoint: endpoint.toString(),
    clients: ["modern-auto", "legacy-2025"],
    tools: REQUIRED_TOOLS,
  }),
);
