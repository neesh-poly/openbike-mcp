import { getSystemFeedStub, loadCatalog } from "../catalog";
import type { SystemFeedAvailabilityResult } from "../durable/types";
import { applyHttpRateLimit } from "./rate-limit";
import { allowMapWork } from "./map-budget";
import { jsonResponse } from "./responses";

const CORS = { "access-control-allow-origin": "*" };
const CACHE_SECONDS = 15;
const FALLBACK_SECONDS = 86_400;
// GBFS allows up to five minutes of reporting latency. Retained readings are
// explicitly shown as delayed by the client, never re-dated by a fresh fetch.
const FRESH_SECONDS = 300;
const RETAIN_SECONDS = 900;
type MapStation = [id: string, longitude: number, latitude: number, spaces: number | null, observed: number | null];

const epoch = (value: string | null | undefined): number | null => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
};

export function liveMapSnapshot(snapshot: SystemFeedAvailabilityResult, now = Date.now()) {
  if (!snapshot.stations.length || snapshot.stations.length > 10_000) throw new Error("Invalid station inventory");
  const source = snapshot.source_observations?.station_status;
  const fetched = epoch(source?.fetched_at ?? snapshot.fetched_at);
  const provider = epoch(source?.provider_last_updated);
  if (fetched === null || fetched > now / 1000 + 60) throw new Error("Invalid snapshot clock");
  const latestClock = Math.min(now / 1000, fetched) + 60;
  const statuses = new Map(snapshot.statuses.map(status => [status.station_id, status]));
  const stations: MapStation[] = snapshot.stations.map(station => {
    const status = statuses.get(station.station_id);
    const reported = epoch(status?.station_last_reported) ?? provider;
    const a = status?.availability;
    // Preserve explicit full/closed states; absence or unknown data is not zero.
    const spaces = !a ? null : a.is_installed === false || a.is_returning === false ? 0
      : a.is_installed === true && a.is_returning === true ? a.docks_available : null;
    const observed = reported !== null && reported <= latestClock &&
      (provider === null || provider <= latestClock)
      ? Math.min(reported, fetched, provider ?? fetched) : null;
    return [station.station_id, station.longitude, station.latitude, spaces, observed];
  });
  return {
    version: 2, system_id: snapshot.system.system_id,
    generated_at: new Date(now).toISOString(), fetched_at: new Date(fetched * 1000).toISOString(),
    fresh_for_seconds: FRESH_SECONDS, retain_for_seconds: RETAIN_SECONDS, stations,
  };
}

type LiveSnapshot = ReturnType<typeof liveMapSnapshot>;

const pending = new Map<string, Promise<Response>>();
let catalog: { expires: number; value: Awaited<ReturnType<typeof loadCatalog>> } | undefined;
async function currentCatalog(env: Env) {
  if (!catalog || Date.now() > catalog.expires)
    catalog = { value: await loadCatalog(env), expires: Date.now() + 60_000 };
  return catalog.value;
}

function browserResponse(response: Response, state: string) {
  const headers = new Headers(response.headers);
  // Explicit client revalidation and independent shared-cache lifetime. The
  // client's cache:no-store also avoids pre-existing four-hour browser entries.
  headers.set("cache-control", "no-store");
  headers.set("cdn-cache-control", `public, max-age=${CACHE_SECONDS}`);
  headers.set("cloudflare-cdn-cache-control", `public, max-age=${CACHE_SECONDS}`);
  headers.set("x-openbike-cache", state);
  return new Response(response.body, { status: response.status, headers });
}

export async function snapshotResponse(request: Request, env: Env, context: ExecutionContext, id: string,
  allowed: boolean | (() => Promise<boolean>) = true, waitForFresh = false) {
  const key = new Request(`${new URL(request.url).origin}/map-docks/${id}/snapshot-v3`);
  const cached = await caches.default.match(key);
  const update = () => {
    let task = pending.get(key.url);
    if (!task) {
      task = (async () => {
        if (!(typeof allowed === "function" ? await allowed() : allowed)) throw new Error("Map work budget reached");
        const system = (await currentCatalog(env)).systems.find(entry => entry.system_id === id && entry.enabled);
        if (!system) throw new Error("Unknown system");
        const snapshot = await getSystemFeedStub(env, system).getAvailability({
          catalogSystem: system, maxStalenessSeconds: FALLBACK_SECONDS, staleWhileRevalidate: !waitForFresh,
        });
        const data = liveMapSnapshot(snapshot);
        const remaining = Math.max(1, FALLBACK_SECONDS - Math.floor((Date.now() - Date.parse(data.fetched_at)) / 1000));
        const response = jsonResponse(data, { headers: {
          ...CORS, "cache-control": `public, max-age=${remaining}`,
          "x-openbike-stored-at": String(Date.now()),
        } });
        await caches.default.put(key, response.clone());
        return response;
      })().finally(() => pending.delete(key.url));
      pending.set(key.url, task);
    }
    return task.then(response => response.clone());
  };
  if (cached) {
    const stale = Date.now() - Number(cached.headers.get("x-openbike-stored-at")) >= CACHE_SECONDS * 1000;
    if (stale) context.waitUntil(update().catch(() => {}));
    return browserResponse(cached, stale ? "STALE" : "HIT");
  }
  return browserResponse(await update(), "MISS");
}

export async function handleMapLive(request: Request, env: Env, context: ExecutionContext, id: string, events: boolean) {
  // Retired public SSE route: 204 stops EventSource reconnects. Existing site
  // versions already fall back to snapshots; new clients use bounded polling.
  if (events) return new Response(null, { status: 204, headers: { ...CORS, "cache-control": "no-store" } });
  const limited = await applyHttpRateLimit(request, env);
  if (limited) return new Response(limited.body, { status: limited.status, headers: {
    ...CORS, "retry-after": "60", "cache-control": "no-store",
  } });
  try {
    const response = await snapshotResponse(request, env, context, id, () => allowMapWork(env));
    return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
  } catch {
    return jsonResponse({ error: "AVAILABILITY_UNAVAILABLE", system_id: id }, {
      status: 503, headers: { ...CORS, "cache-control": "no-store", "retry-after": "60" },
    });
  }
}
