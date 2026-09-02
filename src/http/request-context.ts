export interface RequestContext {
  requestId: string;
  startedAt: number;
}

export function createRequestContext(request: Request): RequestContext {
  return {
    requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    startedAt: performance.now(),
  };
}
