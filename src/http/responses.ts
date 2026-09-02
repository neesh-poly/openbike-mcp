const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(BASE_HEADERS);
  for (const [key, value] of new Headers(init.headers)) {
    headers.set(key, value);
  }
  return Response.json(body, { ...init, headers });
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return jsonResponse(
    { error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}

export function publicRouteHeaders(maxAgeSeconds = 0): HeadersInit {
  return {
    "cache-control":
      maxAgeSeconds > 0
        ? `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`
        : "no-store",
  };
}

export function withPublicSecurityHeaders(
  response: Response,
  requestId?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (requestId !== undefined) headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
