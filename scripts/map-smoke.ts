import assert from 'node:assert/strict';
import { BUNDLED_CATALOG_SYSTEMS } from '../src/catalog/seed';
const origin = process.argv[2] || 'https://mcp.openbike.neesh.page';
const results = [];
for (const city of BUNDLED_CATALOG_SYSTEMS.filter(c => c.enabled)) {
  const before = performance.now();
  const response = await fetch(`${origin}/map-docks/${city.system_id}`);
  assert.equal(response.status, 200, `${city.city}: HTTP ${response.status}`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const data = await response.json() as {system_id:string; generated_at:string; docks:number[][]};
  assert.equal(data.system_id, city.system_id);
  assert(data.docks.length > 0, `${city.city}: no current open docks`);
  assert(data.docks.every(d => d.length === 4 && d.every(Number.isFinite) && d[2]! > 0 && d[3]! > Date.parse(data.generated_at) / 1000));
  const warmStart = performance.now();
  const warm = await fetch(`${origin}/map-docks/${city.system_id}`);
  assert.equal(warm.status, 200);
  const warmData = await warm.json();
  if (warm.headers.get('x-openbike-cache') === 'HIT') assert.deepEqual(warmData, data);
  const row = {city:city.city, count:data.docks.length, currentCount:data.docks.filter(d => d[3]! > Date.now()/1000).length, firstMs:Math.round(warmStart-before), warmMs:Math.round(performance.now()-warmStart), cache:warm.headers.get('x-openbike-cache')};
  results.push(row); console.error(JSON.stringify(row));
}
console.log(JSON.stringify({ok:true,origin,results},null,2));
