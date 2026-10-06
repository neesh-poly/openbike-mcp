import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMapDocks, mapDockSnapshot } from '../../src/http/map-docks';
import type { SystemFeedAvailabilityResult } from '../../src/durable/types';

const now = Date.parse('2026-10-02T12:00:00Z');
const stamp = (seconds: number) => new Date(now + seconds * 1000).toISOString();
function snapshot(): SystemFeedAvailabilityResult {
  const cases = [
    { id: 'open', spaces: 5, reported: stamp(-10), installed: true, returning: true },
    { id: 'full', spaces: 0, reported: stamp(-10), installed: true, returning: true },
    { id: 'old', spaces: 8, reported: stamp(-181), installed: true, returning: true },
    { id: 'closed', spaces: 8, reported: stamp(-10), installed: true, returning: false },
    { id: 'unknown', spaces: null, reported: stamp(-10), installed: true, returning: true },
    { id: 'removed', spaces: 8, reported: stamp(-10), installed: false, returning: true },
    { id: 'missing-clock', spaces: 8, reported: null, installed: true, returning: true },
    { id: 'future', spaces: 8, reported: stamp(61), installed: true, returning: true },
  ];
  return {
    system: { system_id: 'lyft_nyc' }, fetched_at: stamp(-5),
    source_observations: { station_status: { fetched_at: stamp(-5), provider_last_updated: null } },
    stations: cases.map(c => ({ station_id: c.id, latitude: 40.7, longitude: -74 })),
    statuses: cases.map(c => ({ station_id: c.id, station_last_reported: c.reported,
      availability: { docks_available: c.spaces, is_installed: c.installed, is_returning: c.returning } })),
  } as SystemFeedAvailabilityResult;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('public map availability', () => {
  it('only publishes open, installed, current return stations with an absolute expiry', () => {
    expect(mapDockSnapshot(snapshot(), now).docks).toEqual([[-74, 40.7, 5, now / 1000 + 170]]);
    expect(mapDockSnapshot(snapshot(), now + 170_000).docks).toEqual([]);
  });
  it('uses status-feed clocks for missing station clocks and caps expiry by fetch time', () => {
    const data = snapshot();
    data.source_observations!.station_status!.provider_last_updated = stamp(-30);
    data.fetched_at = stamp(-60);
    const result = mapDockSnapshot(data, now);
    expect(result.docks).toHaveLength(2);
    expect(result.docks.every(row => row[3] === now / 1000 + 120)).toBe(true);
  });
  it('caches one normalized snapshot and shares the cache across query variants', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const storage = new Map<string, Response>();
    const cache = { match: vi.fn(async (request: Request) => storage.get(request.url)?.clone()),
      put: vi.fn(async (request: Request, response: Response) => { storage.set(request.url, response); }) };
    vi.stubGlobal('caches', { default: cache });
    const getAvailability = vi.fn(async () => snapshot());
    const env = { CATALOG_KV: { get: vi.fn(async () => null) },
      SYSTEM_FEEDS: { getByName: vi.fn(() => ({ getAvailability, claimMapBudget: async () => true })) },
      EDGE_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } } as unknown as Env;
    const tasks: Promise<unknown>[] = [];
    const context = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } as unknown as ExecutionContext;
    const first = await handleMapDocks(new Request('https://example.test/map-docks/lyft_nyc?a=1'), env, context);
    await Promise.all(tasks);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('max-age=30');
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    const second = await handleMapDocks(new Request('https://example.test/map-docks/lyft_nyc?b=2', { method: 'HEAD' }), env, context);
    expect(second.headers.get('x-openbike-cache')).toBe('HIT');
    expect(await second.text()).toBe('');
    expect(getAvailability).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown or disabled systems before touching a feed', async () => {
    for (const id of ['unknown', 'paris', 'biketown_pdx', '../mcp']) {
      const response = await handleMapDocks(new Request(`https://example.test/map-docks/${id}`), {} as Env, {} as ExecutionContext);
      expect(response.status).toBe(404);
    }
  });
  it('does not cache upstream failures or fabricate empty availability', async () => {
    const put = vi.fn();
    vi.stubGlobal('caches', { default: { match: async () => undefined, put } });
    const env = { CATALOG_KV: { get: async () => null },
      SYSTEM_FEEDS: { getByName: () => ({ claimMapBudget: async () => true, getAvailability: async () => { throw new Error('provider payload'); } }) },
      EDGE_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
    const response = await handleMapDocks(new Request('https://example.test/map-docks/lyft_nyc'), env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('provider payload');
    expect(put).not.toHaveBeenCalled();
  });
});
