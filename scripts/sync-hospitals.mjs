import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpathSync } from 'node:fs';

// Deliberately limited to the Warangal/Hanamkonda urban study area, not the districts.
export const BOUNDS = { south: 17.93, west: 79.48, north: 18.05, east: 79.67 };
export const QUERY = '[out:json][timeout:60];nwr["amenity"="hospital"](17.93,79.48,18.05,79.67);out center tags;';
export const GOVERNMENT_SOURCE = 'https://warangal.telangana.gov.in/health/';
export function stableId(key) {
  const hex = createHash('sha256').update('healthcare-appointments:'+key).digest('hex').slice(0,32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16],16) & 3) | 8).toString(16);
  const s=hex.join(''); return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');
}
export const BASELINE = [
  ['mgm-warangal','MGM Warangal','Sherpura Warangal Telangana 506002'],
  ['ckm-warangal','CKM Warangal','H No 8 Matwada 8-216 Market Street Sri Krishna Colony Girmajipet Warangal 506002'],
  ['regional-eye-warangal','Regional Eye Hospital','Auto Nagar Rd M.G.M Auto Nagar Kothawada Warangal Telangana 506002'],
].map(([key,name,address])=>({ id:stableId('government:'+key),name,city:'Warangal',address,source_url:GOVERNMENT_SOURCE,specializations:[],last_verified_at:'2026-11-13' }));
BASELINE.push({id:stableId('government:government-maternity-warangal'),name:'Govt Maternity Hospital',city:'Warangal',address:'Warangal',source_url:'https://hanumakonda.telangana.gov.in/public-utility-category/govthospitals/',specializations:[],last_verified_at:'2026-11-13'});
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g,' ') : '';
export function explicitCity(tags) {
  // Only address evidence counts. Never infer from hospital name, district or coordinates.
  const city = clean(tags['addr:city']).toLowerCase();
  if (city === 'hanamkonda' || city === 'hanumakonda') return 'Hanamkonda';
  if (city === 'warangal') return 'Warangal';
  if (city) return null; // Conflicting explicit city must not be overridden.
  const full = clean(tags['addr:full']).toLowerCase();
  // A terminal city name in the full address is explicit evidence, unlike a highway,
  // district/mandal label, or the nearby-city description "Near Hanamkonda".
  if (/\b(?:near|mandal|district)\s*[-:]?\s*(?:hanamkonda|hanumakonda|warangal)\b/.test(full)) return null;
  if (/\b(?:hanamkonda|hanumakonda)\s*,\s*(?:near|opposite|beside)\b/.test(full)) return 'Hanamkonda';
  if (/\b(?:hanamkonda|hanumakonda)\s*,?\s*(?:warangal\s*,?\s*)?(?:telangana\s*,?\s*)?(?:\d{6})?\s*[.,]?\s*$/.test(full)) return 'Hanamkonda';
  if (!/\bhighway\b/.test(full) && /\bwarangal\s*,?\s*(?:telangana\s*,?\s*)?(?:\d{6})?\s*[.,]?\s*$/.test(full)) return 'Warangal';
  return null;
}
function baselineMatch(name) {
  const n=name.toLowerCase().replace(/[^a-z0-9]+/g,' ');
  if (/\bmgm\b|mahatma gandhi memorial/.test(n)) return true;
  if (/\bckm\b|chanda kanthaiah/.test(n)) return true;
  return /regional eye/.test(n);
}
export function normalizeOSM(data,checkedAt) {
  if (!data || !Array.isArray(data.elements) || data.remark) throw new Error('Incomplete or invalid Overpass response');
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid check timestamp');
  const hospitals=[]; const seen=new Set();
  for(const element of data.elements) {
    const t=element.tags || {};const name=clean(t.name);const city=explicitCity(t);
    const lat=element.lat ?? element.center?.lat;const lon=element.lon ?? element.center?.lon;
    if(t.amenity!=='hospital' || (t.healthcare && t.healthcare!=='hospital') || /\b(?:clinic|clinics|opticals|diagnostics)\b/i.test(name) || !name || !city || !['node','way','relation'].includes(element.type) || !Number.isSafeInteger(element.id) || element.id<=0) continue;
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<BOUNDS.south||lat>BOUNDS.north||lon<BOUNDS.west||lon>BOUNDS.east) continue;
    // Government records keep their independent reviewed date and source, never OSM freshness.
    if(baselineMatch(name)) continue;
    const address=clean(t['addr:full']) || [t['addr:housenumber'],t['addr:street'],t['addr:suburb'],t['addr:city'],t['addr:state'],t['addr:postcode']].map(clean).filter(Boolean).join(', ');
    const key=city+':'+name.toLowerCase()+':'+address.toLowerCase();if(seen.has(key)) continue;seen.add(key);
    hospitals.push({id:stableId('osm:'+element.type+'/'+element.id),name,city,address,source_url:'https://www.openstreetmap.org/'+element.type+'/'+element.id,specializations:[],last_verified_at:checkedAt});
  }
  return hospitals.sort((a,b)=>(a.city+a.name).localeCompare(b.city+b.name));
}
export async function fetchOSM() {
  const endpoints=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
  const failures=[];
  for(const endpoint of endpoints) {
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','User-Agent':'HealthcareAppointmentsDirectory/1.0 (OpenStreetMap hospital directory)'},body:new URLSearchParams({data:QUERY}),signal:AbortSignal.timeout(90000)});
      if(!response.ok) throw new Error('HTTP '+response.status);
      const data=await response.json();const checkedAt=new Date().toISOString();const hospitals=normalizeOSM(data,checkedAt);
      // A zero accepted result is treated as suspicious: do not erase an existing directory.
      if(!hospitals.length) throw new Error('No hospitals with explicit eligible addr:city inside the bounds; refusing replacement');
      return {hospitals,endpoint,checkedAt};
    }catch(error){failures.push(endpoint+': '+error.message);}
  }
  throw new Error('All Overpass attempts failed. Existing file is unchanged. '+failures.join('; '));
}
export async function upsertSupabase(hospitals) {
  const url=process.env.SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url && !key) return false;
  if(!url || !key) throw new Error('Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const parsed=new URL(url);if(parsed.protocol!=='https:') throw new Error('SUPABASE_URL must use HTTPS');
  const response=await fetch(parsed.origin+'/rest/v1/hospitals?on_conflict=id',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(hospitals),signal:AbortSignal.timeout(30000)});
  // Never log response bodies, request headers, credentials, or environment contents.
  if(!response.ok) throw new Error('Supabase hospital upsert failed (HTTP '+response.status+'); local file not replaced');
  return true;
}
export async function main() {
  const file=fileURLToPath(new URL('../public/hospitals.json',import.meta.url));
  // Fail on unreadable/corrupt existing data rather than overwriting without review.
  const previous=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(previous)) throw new Error('Existing hospitals.json must be an array');
  const result=await fetchOSM();const hospitals=[...BASELINE,...result.hospitals];
  // Any configured database update must succeed before changing the committed snapshot.
  const databaseUpdated=await upsertSupabase(hospitals);
  const content=JSON.stringify(hospitals,null,2)+'\n';const temp=file+'.tmp';await writeFile(temp,content,'utf8');await rename(temp,file);
  console.log(JSON.stringify({total:hospitals.length,government:BASELINE.length,osm:result.hospitals.length,hanamkonda:result.hospitals.filter(h=>h.city==='Hanamkonda').length,checkedAt:result.checkedAt,endpoint:result.endpoint,databaseUpdated}));
}
if(process.argv[1] && realpathSync(path.resolve(process.argv[1])).toLowerCase()===realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) main().catch(error=>{console.error(error.message);process.exitCode=1;});
