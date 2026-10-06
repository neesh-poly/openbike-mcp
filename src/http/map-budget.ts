// This is an application-work ceiling, not a provider billing cap: requests
// rejected at this layer still reach Cloudflare's Worker.
const leases = new WeakMap<object, { day: string; left: number; denied: boolean; retryAt?: number; pending?: Promise<void> }>();
export async function allowMapWork(env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  let lease = leases.get(env.SYSTEM_FEEDS);
  if (!lease || lease.day !== day) {
    lease = { day, left: 0, denied: false };
    leases.set(env.SYSTEM_FEEDS, lease);
  }
  if (lease.retryAt && Date.now() < lease.retryAt) return false;
  if (!lease.left && !lease.denied) {
    const current = lease;
    current.pending ??= env.SYSTEM_FEEDS.getByName('__public-map-budget').claimMapBudget(128)
      .then(allowed => { if (allowed) current.left += 128; else current.denied = true; })
      .catch(() => { current.retryAt = Date.now() + 60_000; })
      .finally(() => { delete current.pending; });
    await current.pending;
  }
  if (!lease.left) return false;
  lease.left--;
  return true;
}
