import { createMcpHandler } from "agents/mcp/server";

import { BUNDLED_CATALOG, loadCatalogPointer } from "./catalog";
import { MCP_ALLOWED_HOSTNAMES, MCP_ALLOWED_ORIGIN_HOSTNAMES, SERVICE_NAME, SERVICE_VERSION } from "./config";
import { SystemFeed } from "./durable";
import { applyHttpRateLimit } from "./http/rate-limit";
import { handleMapDocks } from "./http/map-docks";
import { snapshotResponse } from "./http/map-live";
import { allowMapWork } from "./http/map-budget";
import { createRequestContext } from "./http/request-context";
import {
  jsonResponse,
  methodNotAllowed,
  publicRouteHeaders,
  withPublicSecurityHeaders,
} from "./http/responses";
import { createOpenBikeMcpServer } from "./mcp/server";
import { emitMetric, logEvent } from "./observability";
import { dispatchProbeBatch } from "./queues";
import { readPublicStatus } from "./status";
import { CatalogRefreshWorkflow } from "./workflows";

export { CatalogRefreshWorkflow, SystemFeed };

const MAX_DECLARED_MCP_REQUEST_BYTES = 256 * 1024;

class McpRequestTooLargeError extends Error {}
class McpBatchRequestError extends Error {}

const addRequestId = (response: Response, requestId: string): Response =>
  withPublicSecurityHeaders(response, requestId);

const declaredBodyTooLarge = (request: Request): boolean => {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return false;
  const length = Number(rawLength);
  return Number.isFinite(length) && length > MAX_DECLARED_MCP_REQUEST_BYTES;
};

const boundedMcpRequest = async (request: Request): Promise<Request> => {
  if (request.method !== "POST" || request.body === null) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_DECLARED_MCP_REQUEST_BYTES) {
        await reader.cancel("MCP request body exceeds the configured limit");
        throw new McpRequestTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Decode before inspecting so this matches Request.json() semantics, which
  // ignore an optional leading UTF-8 BOM. Otherwise a BOM-prefixed array could
  // bypass this guard and reach the legacy MCP batch implementation.
  for (const character of new TextDecoder().decode(body)) {
    // JSON permits only these four characters as insignificant whitespace.
    if (
      character === " " ||
      character === "\t" ||
      character === "\n" ||
      character === "\r"
    ) {
      continue;
    }
    if (character === "[") throw new McpBatchRequestError();
    break;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
};

const rootResponse = (env: Env): Response =>
  jsonResponse(
    {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: env.ENVIRONMENT,
      mcp: `${env.PUBLIC_BASE_URL}/mcp`,
      health: `${env.PUBLIC_BASE_URL}/healthz`,
      readiness: `${env.PUBLIC_BASE_URL}/readyz`,
      status: `${env.PUBLIC_BASE_URL}/status`,
      documentation: "https://github.com/neesh-poly/openbike-mcp",
    },
    { headers: publicRouteHeaders(300) },
  );

const routePublicGet = async (
  pathname: string,
  env: Env,
): Promise<Response | null> => {
  if (pathname === "/") return rootResponse(env);
  if (pathname === "/healthz") {
    return jsonResponse(
      {
        ok: true,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        environment: env.ENVIRONMENT,
      },
      { headers: publicRouteHeaders() },
    );
  }
  if (pathname === "/readyz") {
    try {
      // Readiness stays constant-time even when the catalog contains thousands
      // of disabled candidates. A published pointer exists only after the
      // immutable R2 object was written and validated by the publication path.
      const pointer = await loadCatalogPointer(env);
      const catalogVersion = pointer?.version ?? BUNDLED_CATALOG.version;
      const enabledSystemCount =
        pointer?.enabled_system_count ??
        (pointer === null
          ? BUNDLED_CATALOG.systems.filter((system) => system.enabled).length
          : undefined);
      return jsonResponse(
        {
          ready: true,
          catalog_version: catalogVersion,
          ...(enabledSystemCount === undefined
            ? {}
            : { systems: enabledSystemCount }),
        },
        { headers: publicRouteHeaders() },
      );
    } catch {
      return jsonResponse(
        { ready: false, reason: "catalog_unavailable" },
        { status: 503, headers: publicRouteHeaders() },
      );
    }
  }
  if (pathname === "/status") {
    try {
      return jsonResponse(await readPublicStatus(env), {
        headers: publicRouteHeaders(30),
      });
    } catch {
      return jsonResponse(
        { service: SERVICE_NAME, state: "unavailable" },
        { status: 503, headers: publicRouteHeaders() },
      );
    }
  }
  return null;
};

const PUBLIC_GET_PATHS = new Set(["/", "/healthz", "/readyz", "/status"]);
const METERED_PUBLIC_GET_PATHS = new Set(["/readyz", "/status"]);

const handleMcp = async (
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
): Promise<Response> => {
  const requestContext = createRequestContext(request);
  const contentEncoding = request.headers.get("content-encoding");
  if (
    request.method === "POST" &&
    contentEncoding !== null &&
    contentEncoding.toLowerCase() !== "identity"
  ) {
    return addRequestId(
      jsonResponse(
        {
          error: {
            code: "INVALID_ARGUMENT",
            message: "Compressed MCP request bodies are not accepted.",
            retryable: false,
            request_id: requestContext.requestId,
          },
        },
        { status: 415, headers: publicRouteHeaders() },
      ),
      requestContext.requestId,
    );
  }
  if (declaredBodyTooLarge(request)) {
    return addRequestId(
      jsonResponse(
        {
          error: {
            code: "INVALID_ARGUMENT",
            message: "The MCP request body exceeds the configured request-body limit.",
            retryable: false,
            request_id: requestContext.requestId,
          },
        },
        { status: 413, headers: publicRouteHeaders() },
      ),
      requestContext.requestId,
    );
  }

  if (request.method !== "OPTIONS") {
    const rateLimited = await applyHttpRateLimit(request, env);
    if (rateLimited !== null) {
      return addRequestId(rateLimited, requestContext.requestId);
    }
  }

  const startedAt = performance.now();
  const handler = createMcpHandler(
    () => createOpenBikeMcpServer(env, requestContext),
    {
      route: "/mcp",
      corsOptions: {
        origin: "*",
        methods: "GET, POST, DELETE, OPTIONS",
        headers:
          "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id, Mcp-Method, Mcp-Name",
        exposeHeaders: "MCP-Session-Id, X-Request-Id",
        maxAge: 86400,
      },
      allowedHostnames: [...MCP_ALLOWED_HOSTNAMES],
      allowedOriginHostnames: [...MCP_ALLOWED_ORIGIN_HOSTNAMES],
      legacy: "stateless",
      responseMode: "auto",
      onerror(error) {
        logEvent("error", "mcp_transport_error", {
          request_id: requestContext.requestId,
          component: "mcp_transport",
          operation: "serve",
          outcome: "failure",
          error_class: error.name,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      },
    },
  );

  let boundedRequest: Request;
  try {
    boundedRequest = await boundedMcpRequest(request);
  } catch (error) {
    if (error instanceof McpBatchRequestError) {
      return addRequestId(
        jsonResponse(
          {
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "JSON-RPC batch requests are not supported.",
            },
            id: null,
          },
          { status: 400, headers: publicRouteHeaders() },
        ),
        requestContext.requestId,
      );
    }
    if (!(error instanceof McpRequestTooLargeError)) throw error;
    return addRequestId(
      jsonResponse(
        {
          error: {
            code: "INVALID_ARGUMENT",
            message: "The MCP request body exceeds the configured request-body limit.",
            retryable: false,
            request_id: requestContext.requestId,
          },
        },
        { status: 413, headers: publicRouteHeaders() },
      ),
      requestContext.requestId,
    );
  }

  const response = await handler(boundedRequest, env, executionContext);
  emitMetric(env, {
    index: "service",
    event: "mcp_http_request",
    component: "mcp_transport",
    operation: request.method,
    outcome: response.status < 500 ? "success" : "failure",
    durationMs: Math.round(performance.now() - startedAt),
    httpStatus: response.status,
    workerVersion: SERVICE_VERSION,
  });
  return addRequestId(response, requestContext.requestId);
};

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return handleMcp(request, env, executionContext);
    }

    const requestContext = createRequestContext(request);
    if (url.pathname.startsWith("/map-docks/")) {
      return addRequestId(await handleMapDocks(request, env, executionContext), requestContext.requestId);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return addRequestId(
        PUBLIC_GET_PATHS.has(url.pathname)
          ? methodNotAllowed(["GET", "HEAD"])
          : jsonResponse({ error: "NOT_FOUND" }, { status: 404 }),
        requestContext.requestId,
      );
    }

    if (METERED_PUBLIC_GET_PATHS.has(url.pathname)) {
      const rateLimited = await applyHttpRateLimit(request, env);
      if (rateLimited !== null) {
        return addRequestId(rateLimited, requestContext.requestId);
      }
    }

    const response = await routePublicGet(url.pathname, env);
    if (response === null) {
      return addRequestId(
        jsonResponse({ error: "NOT_FOUND" }, { status: 404 }),
        requestContext.requestId,
      );
    }
    if (request.method === "HEAD") {
      return addRequestId(
        new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        requestContext.requestId,
      );
    }
    return addRequestId(response, requestContext.requestId);
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    // Fixed catalog and bounded fan-out: visitor count never changes warmup work.
    const systems = BUNDLED_CATALOG.systems.filter(system => system.enabled);
    for (let i = 0; i < systems.length; i += 2) {
      await Promise.all(systems.slice(i, i + 2).map(async system => {
        const url = `${env.PUBLIC_BASE_URL}/map-docks/${system.system_id}/snapshot`;
        await snapshotResponse(new Request(url), env, context, system.system_id, () => allowMapWork(env), true).catch(() => {});
      }));
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await dispatchProbeBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
