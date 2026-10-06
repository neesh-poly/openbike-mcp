import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveMapSnapshot, snapshotResponse } from '../../src/http/map-live';
import { handleMapDocks } from '../../src/http/map-docks';
import type { SystemFeedAvailabilityResult } from '../../src/durable/types';

const now = Date.parse('2026-10-02T12:00:00Z');
const stamp = (seconds: number) => new Date(now + seconds * 1000).toISOString();
function fixture(): SystemFeedAvailabilityResult {
 const cases = [
  ['open', 5, -10, true], ['full', 0, -10, true], ['closed', 8, -10, false],
  ['late', 3, -240, true], ['old', 6, -1000, true], ['missing', 4, null, true],
  ['future', 2, 61, true], ['unknown', null, -10, true],
 ] as const;
 return {
  system:{system_id:'lyft_nyc'}, fetched_at:stamp(0),
  source_observations:{station_status:{fetched_at:stamp(-5),provider_last_updated:stamp(-8)}},
  stations:cases.map(([id])=>({station_id:id,longitude:-74,latitude:40.7})),
  statuses:cases.map(([id,spaces,age,returning])=>({station_id:id,station_last_reported:age===null?null:stamp(age),
   availability:{docks_available:spaces,is_installed:true,is_returning:returning}})),
 } as SystemFeedAvailabilityResult;
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('live map snapshots',()=>{
 it('keeps full, closed, delayed and unknown states distinct with their original clocks',()=>{
  const result=liveMapSnapshot(fixture(),now);
  expect(result.version).toBe(2);
  expect(result.stations.find(s=>s[0]==='full')?.[3]).toBe(0);
  expect(result.stations.find(s=>s[0]==='closed')?.[3]).toBe(0);
  expect(result.stations.find(s=>s[0]==='unknown')?.[3]).toBeNull();
  expect(result.stations.find(s=>s[0]==='late')?.[4]).toBe(now/1000-240);
  expect(result.stations.find(s=>s[0]==='old')?.[4]).toBe(now/1000-1000);
  expect(result.stations.find(s=>s[0]==='missing')?.[4]).toBe(now/1000-8);
  expect(result.stations.find(s=>s[0]==='future')?.[4]).toBeNull();
  expect(result.fetched_at).toBe(stamp(-5));
 });
 it('does not re-date observations when the snapshot is fetched again',()=>{
  const first=liveMapSnapshot(fixture(),now);
  const second=liveMapSnapshot({...fixture(),fetched_at:stamp(120)},now+120000);
  expect(second.stations).toEqual(first.stations);
  expect(second.fetched_at).toEqual(first.fetched_at);
 });
 it('does not turn an empty inventory into an all-full city',()=>{
  expect(()=>liveMapSnapshot({...fixture(),stations:[]},now)).toThrow();
 });
});
describe('cached map delivery', () => {
 function setup(allowed = true) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const storage = new Map<string, Response>();
  vi.stubGlobal('caches', { default: {
   match: async (r: Request) => storage.get(r.url)?.clone(),
   put: async (r: Request, v: Response) => { storage.set(r.url, v); },
  } });
  const getAvailability = vi.fn(async () => fixture());
  const claimMapBudget = vi.fn(async () => allowed);
  const env = { CATALOG_KV: { get: async () => null },
   SYSTEM_FEEDS: { getByName: () => ({ getAvailability, claimMapBudget }) },
   EDGE_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext;
  const request = new Request('https://test.local/map-docks/lyft_nyc/snapshot');
  return { env, ctx, request, getAvailability, claimMapBudget, tasks, storage };
 }
 it('uses shared cached snapshots while forcing browser revalidation', async () => {
  const s = setup();
  const response = await handleMapDocks(s.request, s.env, s.ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('cdn-cache-control')).toContain('max-age=15');
  expect((await response.json() as { version: number }).version).toBe(2);
  await handleMapDocks(s.request, s.env, s.ctx);
  expect(s.getAvailability).toHaveBeenCalledTimes(1);
  expect(s.claimMapBudget).toHaveBeenCalledTimes(1);
  expect(s.getAvailability).toHaveBeenCalledWith(expect.objectContaining({ staleWhileRevalidate: true }));
 });
 it('returns a stale cached response without waiting for a blocked provider', async () => {
  const s = setup();
  await handleMapDocks(s.request, s.env, s.ctx);
  vi.setSystemTime(now + 16_000);
  let resolve!: (value: SystemFeedAvailabilityResult) => void;
  s.getAvailability.mockImplementation(() => new Promise(done => { resolve = done; }));
  const response = await handleMapDocks(s.request, s.env, s.ctx);
  expect(response.headers.get('x-openbike-cache')).toBe('STALE');
  expect((await response.json() as { fetched_at: string }).fetched_at).toBe(stamp(-5));
  resolve(fixture()); await Promise.all(s.tasks);
 });
 it('coalesces a concurrent cold cache miss', async () => {
  const s = setup();
  await Promise.all(Array.from({ length: 20 }, () => handleMapDocks(s.request, s.env, s.ctx)));
  expect(s.getAvailability).toHaveBeenCalledTimes(1);
  expect(s.claimMapBudget).toHaveBeenCalledTimes(1);
 });
 it('charges only cache refresh work and lets scheduled warming wait for fresh data', async () => {
  const s = setup();
  const allow = vi.fn(async () => true);
  await snapshotResponse(s.request, s.env, s.ctx, 'lyft_nyc', allow, true);
  await snapshotResponse(s.request, s.env, s.ctx, 'lyft_nyc', allow, true);
  expect(allow).toHaveBeenCalledTimes(1);
  expect(s.getAvailability).toHaveBeenCalledWith(expect.objectContaining({ staleWhileRevalidate: false }));
 });
 it('denies new backend work at the shared budget while preserving cached responses', async () => {
  const s = setup(false);
  expect((await handleMapDocks(s.request, s.env, s.ctx)).status).toBe(503);
  expect(s.getAvailability).not.toHaveBeenCalled();
  const key = new Request('https://test.local/map-docks/lyft_nyc/snapshot-v3');
  s.storage.set(key.url, Response.json(liveMapSnapshot(fixture(), now), { headers: { 'x-openbike-stored-at': String(now - 60_000) } }));
  expect((await snapshotResponse(s.request, s.env, s.ctx, 'lyft_nyc', false)).status).toBe(200);
  await Promise.all(s.tasks);
  expect(s.getAvailability).not.toHaveBeenCalled();
 });
 it('retires long-lived streams without reconnecting and still rejects unknown cities', async () => {
  const s = setup();
  expect((await handleMapDocks(new Request('https://test.local/map-docks/lyft_nyc/events'), s.env, s.ctx)).status).toBe(204);
  expect((await handleMapDocks(new Request('https://test.local/map-docks/nope/events'), s.env, s.ctx)).status).toBe(404);
  expect(s.getAvailability).not.toHaveBeenCalled();
 });
});
