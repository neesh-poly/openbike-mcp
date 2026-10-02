import { getSystemFeedStub, loadCatalog } from "../catalog";
import type { SystemFeedAvailabilityResult } from "../durable/types";
import { applyHttpRateLimit } from "./rate-limit";
import { jsonResponse } from "./responses";

const CORS = { "access-control-allow-origin": "*" };
const CACHE_SECONDS = 10;
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

async function snapshotResponse(request: Request, env: Env, context: ExecutionContext, id: string) {
  const key = new Request(`${new URL(request.url).origin}/map-docks/${id}/snapshot`);
  const cached = await caches.default.match(key);
  if (cached) return cached;
  const system = (await loadCatalog(env)).systems.find(entry => entry.system_id === id && entry.enabled);
  if (!system) throw new Error("Unknown system");
  // The shared per-system object honors provider TTLs and coalesces refreshes,
  // including requests from other visitors and the MCP. No per-viewer polling upstream.
  const snapshot = await getSystemFeedStub(env, system).getAvailability({
    catalogSystem: system, maxStalenessSeconds: RETAIN_SECONDS,
  });
  const response = jsonResponse(liveMapSnapshot(snapshot), { headers: {
    ...CORS, "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
  } });
  context.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function mapEventStream(read: () => Promise<LiveSnapshot>, signal: AbortSignal,
  intervalMs = 10_000, lifetimeMs = 120_000) {
  const stop = new AbortController();
  const abort = () => stop.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const run = async () => {
        let last = "";
        const until = Date.now() + lifetimeMs;
        const send = (value: string) => {
          if (stop.signal.aborted || (controller.desiredSize ?? 0) <= 0) return false;
          controller.enqueue(encoder.encode(value));
          return true;
        };
        try {
          send("retry: 3000\n\n");
          while (!stop.signal.aborted && Date.now() < until) {
            try {
              const snapshot = await read();
              if (snapshot.fetched_at !== last) {
                if (send(`event: snapshot\nid: ${snapshot.fetched_at}\ndata: ${JSON.stringify(snapshot)}\n\n`)) last = snapshot.fetched_at;
              } else send(": heartbeat\n\n");
            } catch { send('event: unavailable\ndata: {"retry":true}\n\n'); }
            await delay(intervalMs, stop.signal);
          }
        } finally {
          signal.removeEventListener("abort", abort);
          try { controller.close(); } catch { /* The reader may have already cancelled. */ }
        }
      };
      void run().catch(error => { try { controller.error(error); } catch { /* Already closed. */ } });
    },
    cancel() { stop.abort(); },
  }, { highWaterMark: 2 });
}

export async function handleMapLive(request: Request, env: Env, context: ExecutionContext, id: string, events: boolean) {
  const limited = await applyHttpRateLimit(request, env);
  if (limited) return new Response(limited.body, { status: limited.status, headers: {
    ...CORS, "retry-after": "60", "cache-control": "no-store",
  } });
  if (events) return new Response(request.method === "HEAD" ? null : mapEventStream(async () =>
    await (await snapshotResponse(request, env, context, id)).json<LiveSnapshot>(), request.signal), { headers: {
    ...CORS, "content-type": "text/event-stream", "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff",
  } });
  try {
    const response = await snapshotResponse(request, env, context, id);
    return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
  } catch {
    return jsonResponse({ error: "AVAILABILITY_UNAVAILABLE", system_id: id }, {
      status: 503, headers: { ...CORS, "cache-control": "no-store", "retry-after": "10" },
    });
  }
}
