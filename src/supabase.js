import {createClient} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL;const key=import.meta.env.VITE_SUPABASE_ANON_KEY;
export const demoMode=import.meta.env.VITE_DEMO_MODE==='true';
if(demoMode && url!=='https://vqrkzjymfoinfeurwgtl.supabase.co')throw new Error('Demo mode must use the isolated Careway test project.');
export const configured=Boolean(url && key && /^https:\/\//.test(url));
export const supabase=configured?createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):null;