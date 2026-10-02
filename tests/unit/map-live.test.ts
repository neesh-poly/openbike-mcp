import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveMapSnapshot, mapEventStream } from '../../src/http/map-live';
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
describe('visible-city event stream',()=>{
 it('pushes changed snapshots, heartbeats unchanged data, and stops when cancelled',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const snapshot=liveMapSnapshot(fixture(),now);
  const read=vi.fn().mockResolvedValue(snapshot);
  const reader=mapEventStream(read,new AbortController().signal,10,100).getReader();
  const text=async()=>new TextDecoder().decode((await reader.read()).value);
  expect(await text()).toContain('retry: 3000');
  expect(await text()).toContain('event: snapshot');
  await vi.advanceTimersByTimeAsync(10);
  expect(await text()).toContain('heartbeat');
  read.mockResolvedValue({...snapshot,fetched_at:stamp(1)});
  await vi.advanceTimersByTimeAsync(10);
  expect(await text()).toContain('id: '+stamp(1));
  await reader.cancel();
  const count=read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
 });
 it('reports upstream failure without replacing the map with empty data',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const read=vi.fn().mockRejectedValue(new Error('private upstream detail'));
  const abort=new AbortController();
  const reader=mapEventStream(read,abort.signal,10,100).getReader();
  await reader.read();
  const message=new TextDecoder().decode((await reader.read()).value);
  expect(message).toContain('event: unavailable');
  expect(message).not.toContain('private');
  abort.abort();
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
 });
 it('routes snapshot and event requests, shares snapshots, and rejects unknown cities',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const storage=new Map<string,Response>();
  vi.stubGlobal('caches',{default:{match:async(r:Request)=>storage.get(r.url)?.clone(),put:async(r:Request,v:Response)=>{storage.set(r.url,v);}}});
  const getAvailability=vi.fn(async()=>fixture());
  const env={CATALOG_KV:{get:async()=>null},SYSTEM_FEEDS:{getByName:()=>({getAvailability})},EDGE_RATE_LIMITER:{limit:async()=>({success:true})}} as unknown as Env;
  const tasks:Promise<unknown>[]=[];
  const ctx={waitUntil:(p:Promise<unknown>)=>tasks.push(p)} as unknown as ExecutionContext;
  const response=await handleMapDocks(new Request('https://test.local/map-docks/lyft_nyc/snapshot'),env,ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('max-age=10');
  expect((await response.json() as {version:number}).version).toBe(2);
  await Promise.all(tasks);
  const stream=await handleMapDocks(new Request('https://test.local/map-docks/lyft_nyc/events'),env,ctx);
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  expect(stream.headers.get('access-control-allow-origin')).toBe('*');
  const reader=stream.body!.getReader();await reader.read();await reader.read();await reader.cancel();
  expect(getAvailability).toHaveBeenCalledTimes(1);
  expect((await handleMapDocks(new Request('https://test.local/map-docks/nope/events'),env,ctx)).status).toBe(404);
 });
});
