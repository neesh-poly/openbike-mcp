import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z, type ZodType } from "zod";

import { runtimeConfig, SERVICE_NAME, SERVICE_VERSION } from "../config";
import {
  FindStationsInputSchema,
  FindStationsOutputSchema,
  FindSystemsInputSchema,
  FindSystemsOutputSchema,
  GetNearbyAvailabilityInputSchema,
  GetNearbyAvailabilityOutputSchema,
  GetStationInputSchema,
  GetStationOutputSchema,
  GetSystemHealthInputSchema,
  GetSystemHealthOutputSchema,
} from "../contracts";
import { failureResult, successResult } from "./results";
import { createOpenBikeMcpService } from "./service";

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const asStructuredOutput = (value: object): Record<string, unknown> =>
  value as Record<string, unknown>;

const asCallToolResult = (
  value: ReturnType<typeof successResult> | ReturnType<typeof failureResult>,
): CallToolResult => value as unknown as CallToolResult;

/**
 * Zod transforms are meaningful to the service validator but cannot be emitted
 * as JSON Schema. MCP still needs a representable schema for tools/list, so use
 * Zod's input view for both advertised directions while retaining the original
 * schema's parse/transform behavior for validation.
 */
const mcpSchema = <Schema extends ZodType>(
  schema: Schema,
): StandardSchemaWithJSON<z.input<Schema>, z.output<Schema>> => ({
  "~standard": {
    version: 1,
    vendor: "openbike-zod",
    validate: (value) => schema["~standard"].validate(value),
    jsonSchema: {
      input: () =>
        z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
      output: () =>
        z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    },
  },
});

/**
 * Creates one isolated MCP server for one HTTP request. The caller must not
 * cache this instance across requests because the request ID is part of every
 * result and error contract.
 */
export function createOpenBikeMcpServer(
  env: Env,
  requestContext: { requestId: string },
): McpServer {
  const service = createOpenBikeMcpService(env, requestContext);
  const { maxMcpResponseBytes } = runtimeConfig(env);
  const server = new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
  });

  server.registerTool(
    "get_nearby_availability",
    {
      title: "Get nearby bikeshare availability",
      description:
        "Find and rank live bikeshare stations near WGS84 coordinates for taking a vehicle, returning one, or either. This service does not geocode place names. Results include freshness, source attribution, and partial-provider warnings.",
      inputSchema: mcpSchema(GetNearbyAvailabilityInputSchema),
      outputSchema: mcpSchema(GetNearbyAvailabilityOutputSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        const output = await service.getNearbyAvailability(input);
        return asCallToolResult(successResult(
          asStructuredOutput(output),
          maxMcpResponseBytes,
        ));
      } catch (error) {
        return asCallToolResult(failureResult(error, requestContext.requestId));
      }
    },
  );

  server.registerTool(
    "find_stations",
    {
      title: "Find bikeshare stations",
      description:
        "Search normalized bikeshare stations near WGS84 coordinates, optionally filtering station names and attaching live status. Supports opaque, query-bound pagination cursors and does not geocode place names.",
      inputSchema: mcpSchema(FindStationsInputSchema),
      outputSchema: mcpSchema(FindStationsOutputSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        const output = await service.findStations(input);
        return asCallToolResult(successResult(
          asStructuredOutput(output),
          maxMcpResponseBytes,
        ));
      } catch (error) {
        return asCallToolResult(failureResult(error, requestContext.requestId));
      }
    },
  );

  server.registerTool(
    "get_station",
    {
      title: "Get a bikeshare station",
      description:
        "Fetch one provider-scoped station by normalized system ID and station ID, optionally including current availability and bounded source links.",
      inputSchema: mcpSchema(GetStationInputSchema),
      outputSchema: mcpSchema(GetStationOutputSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        const output = await service.getStation(input);
        return asCallToolResult(successResult(
          asStructuredOutput(output),
          maxMcpResponseBytes,
        ));
      } catch (error) {
        return asCallToolResult(failureResult(error, requestContext.requestId));
      }
    },
  );

  server.registerTool(
    "find_systems",
    {
      title: "Find bikeshare systems",
      description:
        "Discover indexed bikeshare systems by coordinates, country, text, or capability. Coordinates are WGS84 and must be supplied as a pair; coverage confidence distinguishes exact from inferred coverage.",
      inputSchema: mcpSchema(FindSystemsInputSchema),
      outputSchema: mcpSchema(FindSystemsOutputSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        const output = await service.findSystems(input);
        return asCallToolResult(successResult(
          asStructuredOutput(output),
          maxMcpResponseBytes,
        ));
      } catch (error) {
        return asCallToolResult(failureResult(error, requestContext.requestId));
      }
    },
  );

  server.registerTool(
    "get_system_health",
    {
      title: "Get bikeshare system health",
      description:
        "Return safe feed-level diagnostics for one named bikeshare system, including version, validation, timestamps, rolling success rate, capabilities, and degradation state. Raw provider responses and infrastructure details are never returned.",
      inputSchema: mcpSchema(GetSystemHealthInputSchema),
      outputSchema: mcpSchema(GetSystemHealthOutputSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input) => {
      try {
        const output = await service.getSystemHealth(input);
        return asCallToolResult(successResult(
          asStructuredOutput(output),
          maxMcpResponseBytes,
        ));
      } catch (error) {
        return asCallToolResult(failureResult(error, requestContext.requestId));
      }
    },
  );

  return server;
}
