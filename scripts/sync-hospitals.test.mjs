import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BASELINE, stableId, normalizeOSM, explicitCity, main } from './sync-hospitals.mjs';
const stamp='2026-11-13T10:30:00.000Z';
const fixture=(overrides={})=>({type:'node',id:123,lat:18.01,lon:79.56,tags:{amenity:'hospital',name:'Test hospital','addr:city':'Hanamkonda','addr:street':'Test road'},...overrides});
test('stable UUID, government provenance and review date',()=>{
  assert.equal(stableId('one'),stableId('one')); assert.notEqual(stableId('one'),stableId('two'));
  assert.match(stableId('one'),/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(BASELINE.length,4);assert.ok(BASELINE.every(h=>h.last_verified_at==='2026-11-13' && h.specializations.length===0));
});
test('city must be explicitly mapped, not guessed',()=>{
  assert.equal(explicitCity({'addr:city':'Hanumakonda'}),'Hanamkonda');
  assert.equal(explicitCity({'addr:district':'Hanamkonda',name:'Hanamkonda hospital'}),null);
  assert.equal(explicitCity({'addr:city':'Warangal Rural'}),null);
});
test('only in-bound named hospitals with explicit city, retaining source and check time',()=>{
  const results=normalizeOSM({elements:[fixture(),fixture({id:124,lat:18.5}),fixture({id:125,tags:{amenity:'clinic',name:'Clinic','addr:city':'Hanamkonda'}}),fixture({id:126,tags:{amenity:'hospital',name:'No city'}})]},stamp);
  assert.equal(results.length,1);assert.equal(results[0].city,'Hanamkonda');assert.equal(results[0].last_verified_at,stamp);assert.equal(results[0].source_url,'https://www.openstreetmap.org/node/123');assert.deepEqual(results[0].specializations,[]);
});
test('government records cannot acquire OSM verification date',()=>{
  assert.deepEqual(normalizeOSM({elements:[fixture({tags:{amenity:'hospital',name:'MGM Hospital','addr:city':'Warangal'}})]},stamp),[]);
});
test('reject partial/error payloads',()=>{
  assert.throws(()=>normalizeOSM({elements:[],remark:'timed out'},stamp));assert.throws(()=>normalizeOSM({},stamp));
});
test('failed API requests preserve file bytes and reject',async()=>{
  const file=new URL('../public/hospitals.json',import.meta.url);const before=await readFile(file,'utf8');const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('Simulated network failure')};
  try { await assert.rejects(main(),/All Overpass attempts failed/);assert.equal(await readFile(file,'utf8'),before); }finally{globalThis.fetch=original;}
});

test('configured database failure preserves snapshot without exposing secrets',async()=>{
  const file=new URL('../public/hospitals.json',import.meta.url);const before=await readFile(file,'utf8');const original=globalThis.fetch;
  const oldUrl=process.env.SUPABASE_URL; const oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-not-real';
  globalThis.fetch=async(url)=>String(url).includes('/rest/v1/') ? {ok:false,status:403} : {ok:true,json:async()=>({elements:[fixture()]})};
  try {await assert.rejects(main(),/Supabase hospital upsert failed \(HTTP 403\)/);assert.equal(await readFile(file,'utf8'),before);}
  finally{globalThis.fetch=original;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
});

test('explicit terminal full-address city accepted; proximity, highway and mandal not inferred',()=>{
  assert.equal(explicitCity({'addr:full':'Subedari, Hanamkonda'}),'Hanamkonda');
  assert.equal(explicitCity({'addr:full':'Subedari, Hanumakonda, Warangal'}),'Hanamkonda');
  assert.equal(explicitCity({'addr:full':'Near Hanamkonda'}),null);
  assert.equal(explicitCity({'addr:full':'Village-Arepally, Mandal-Hanamkonda'}),null);
  assert.equal(explicitCity({'addr:full':'Hyderabad - Warangal Highway'}),null);
  assert.equal(explicitCity({'addr:city':'Kazipet','addr:full':'Hanamkonda'}),null);
});
