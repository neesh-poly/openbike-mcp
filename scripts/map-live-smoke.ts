import assert from 'node:assert/strict';
import { BUNDLED_CATALOG_SYSTEMS } from '../src/catalog/seed';
const origin=process.argv[2]||'https://mcp.openbike.neesh.page';
const systems=BUNDLED_CATALOG_SYSTEMS.filter(s=>s.enabled);
let next=0;
async function worker(){while(next<systems.length){
 const system=systems[next++]!;
 const response=await fetch(`${origin}/map-docks/${system.system_id}/snapshot`,{cache:'no-store'});
 assert.equal(response.status,200,system.system_id);
 assert.equal(response.headers.get('access-control-allow-origin'),'*');
 const data=await response.json() as {version:number;stations:[string,number,number,number|null,number|null][]};
 assert.equal(data.version,2);assert(data.stations.length>0);
 const seen=new Set();
 for(const row of data.stations){assert(!seen.has(row[0]));seen.add(row[0]);assert.equal(row.length,5);assert(row[3]===null||row[3]>=0);assert(row[4]===null||row[4]<=Date.now()/1000+60);}
 console.log(`${system.city}: ${data.stations.length} states, ${data.stations.filter(s=>s[3]===0).length} full/closed`);
}}
await Promise.all([worker(),worker(),worker()]);
const abort=new AbortController();
const timeout=setTimeout(()=>abort.abort(),95_000);
const started=Date.now();
let events=0,heartbeats=0,last='';
try{
 const response=await fetch(`${origin}/map-docks/lyft_nyc/events`,{signal:abort.signal});
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/event-stream');
 const reader=response.body!.getReader();const decoder=new TextDecoder();let pending='';
 while(events<2){
  const {value,done}=await reader.read();assert(!done,'Stream closed before an updated observation');
  pending+=decoder.decode(value,{stream:true});
  let split;
  while((split=pending.indexOf('\n\n'))>=0){
   const frame=pending.slice(0,split);pending=pending.slice(split+2);
   if(frame.includes(': heartbeat'))heartbeats++;
   if(!frame.startsWith('event: snapshot'))continue;
   const data=JSON.parse(frame.split('\ndata: ')[1]!);
   assert(data.fetched_at>last);last=data.fetched_at;events++;
   console.log(`Snapshot ${events}: ${last}, elapsed ${Date.now()-started}ms`);
  }
 }
 await reader.cancel();
 console.log(JSON.stringify({ok:true,events,heartbeats,elapsedMs:Date.now()-started}));
}finally{clearTimeout(timeout);abort.abort();}
