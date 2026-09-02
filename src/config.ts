export const SERVICE_NAME = "openbike-mcp";
export const SERVICE_VERSION = "0.1.0";

export const MCP_ALLOWED_HOSTNAMES = [
  "mcp.openbike.neesh.page",
  "openbike-mcp-staging.ilios.workers.dev",
  "localhost",
  "127.0.0.1",
  "[::1]",
] as const;

export const MCP_ALLOWED_ORIGIN_HOSTNAMES = [
  "mcp.openbike.neesh.page",
  "chatgpt.com",
  "claude.ai",
  "claude.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
] as const;

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeConfig(env: Env) {
  return {
    environment: env.ENVIRONMENT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    contactEmail: env.CONTACT_EMAIL,
    maxCandidateSystems: Math.min(
      4,
      positiveInteger(env.MAX_CANDIDATE_SYSTEMS, 4),
    ),
    maxFeedBytes: Math.min(
      8 * 1024 * 1024,
      positiveInteger(env.MAX_FEED_BYTES, 4 * 1024 * 1024),
    ),
    maxMcpResponseBytes: Math.min(
      2 * 1024 * 1024,
      positiveInteger(env.MAX_MCP_RESPONSE_BYTES, 1024 * 1024),
    ),
  } as const;
}
