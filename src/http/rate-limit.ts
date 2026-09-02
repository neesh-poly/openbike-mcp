import { jsonResponse } from "./responses";

function clientRateKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "anonymous"
  );
}

export async function applyHttpRateLimit(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const outcome = await env.EDGE_RATE_LIMITER.limit({
    key: clientRateKey(request),
  });
  if (outcome.success) return null;

  return jsonResponse(
    {
      error: {
        code: "RATE_LIMITED",
        message: "The service request limit was reached. Try again shortly.",
        retryable: true,
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": "60",
        "cache-control": "no-store",
      },
    },
  );
}
