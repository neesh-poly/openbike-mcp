// This is an application-work ceiling, not a provider billing cap: requests
// rejected at this layer still reach Cloudflare's Worker.
const budgets = new WeakMap<object, { day: string; denied: boolean; retryAt?: number }>();
export async function allowMapWork(env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  let state = budgets.get(env.SYSTEM_FEEDS);
  if (!state || state.day !== day) {
    state = { day, denied: false };
    budgets.set(env.SYSTEM_FEEDS, state);
  }
  if (state.denied || (state.retryAt && Date.now() < state.retryAt)) return false;
  try {
    // Reserve one unit per operation, including concurrent operations. Isolates
    // can disappear after one request; prepaid batches waste the unused units.
    const allowed = await env.SYSTEM_FEEDS.getByName('__public-map-budget').claimMapBudget(1);
    if (!allowed) state.denied = true;
    return allowed;
  } catch {
    state.retryAt = Date.now() + 60_000;
    return false;
  }
}
