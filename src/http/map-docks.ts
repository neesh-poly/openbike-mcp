import { BUNDLED_CATALOG, getSystemFeedStub, loadCatalog } from "../catalog";
import type { SystemFeedAvailabilityResult } from "../durable/types";
import { applyHttpRateLimit } from "./rate-limit";
import { jsonResponse, methodNotAllowed } from "./responses";
import { handleMapLive } from "./map-live";
import { allowMapWork } from "./map-budget";

const MAX_AGE_SECONDS = 180;
const CACHE_SECONDS = 30;
const CORS = { "access-control-allow-origin": "*" };

export function mapDockSnapshot(snapshot: SystemFeedAvailabilityResult, now = Date.now()) {
  const statuses = new Map(snapshot.statuses.map(status => [status.station_id, status]));
  const providerTime = snapshot.source_observations?.station_status?.provider_last_updated;
  const fetchedTime = Date.parse(snapshot.fetched_at);
  // Compact tuples: longitude, latitude, open spaces, valid-until Unix seconds.
  // Per-point expiry lets browsers discard old dots even from an HTTP cache.
  const docks: [number, number, number, number][] = [];
  if (snapshot.stations.length > 10_000) throw new Error("Map snapshot exceeds station budget");
  for (const station of snapshot.stations) {
    const status = statuses.get(station.station_id);
    if (!status) continue;
    const a = status.availability;
    const reported = status.station_last_reported ?? providerTime;
    if (!reported || a.is_installed !== true || a.is_returning !== true ||
        a.docks_available === null || a.docks_available <= 0) continue;
    const reportedTime = Date.parse(reported);
    const validUntil = Math.floor((Math.min(reportedTime, fetchedTime) + MAX_AGE_SECONDS * 1000) / 1000);
    if (!Number.isFinite(validUntil) || reportedTime > Math.min(now, fetchedTime) + 60_000 || validUntil * 1000 <= now) continue;
    docks.push([station.longitude, station.latitude, a.docks_available, validUntil]);
  }
  return {
    system_id: snapshot.system.system_id,
    generated_at: new Date(now).toISOString(),
    fetched_at: snapshot.fetched_at,
    max_age_seconds: MAX_AGE_SECONDS,
    docks,
  };
}

export async function handleMapDocks(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/map-docks\/([a-z0-9_-]{1,80})(?:\/(snapshot|events))?$/.exec(url.pathname);
  const id = match?.[1];
  if (!id || !BUNDLED_CATALOG.systems.some(system => system.system_id === id && system.enabled)) {
    return jsonResponse({ error: "NOT_FOUND" }, { status: 404, headers: CORS });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    ...CORS, "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-max-age": "86400",
  } });
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD", "OPTIONS"]);
  if (match?.[2]) return handleMapLive(request, env, context, id, match[2] === "events");
  // Ignore query strings so callers cannot create arbitrary cache variants.
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-openbike-cache", "HIT");
    return new Response(request.method === "HEAD" ? null : cached.body, { headers });
  }
  const limited = await applyHttpRateLimit(request, env);
  if (limited) return new Response(limited.body, { status: limited.status, headers: { ...CORS, "retry-after": "60", "cache-control": "no-store" } });
  try {
    if (!await allowMapWork(env)) throw new Error("Map work budget reached");
    const catalog = await loadCatalog(env);
    const system = catalog.systems.find(entry => entry.system_id === id && entry.enabled);
    if (!system) return jsonResponse({ error: "NOT_FOUND" }, { status: 404, headers: CORS });
    const snapshot = await getSystemFeedStub(env, system).getAvailability({
      catalogSystem: system, maxStalenessSeconds: MAX_AGE_SECONDS,
    });
    const response = jsonResponse(mapDockSnapshot(snapshot), { headers: {
      ...CORS, "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      "x-openbike-cache": "MISS",
    } });
    context.waitUntil(caches.default.put(cacheKey, response.clone()));
    return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
  } catch {
    return jsonResponse({ error: "AVAILABILITY_UNAVAILABLE", system_id: id }, {
      status: 503, headers: { ...CORS, "cache-control": "no-store", "retry-after": "30" },
    });
  }
}
