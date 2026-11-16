import {NextRequest} from 'next/server';
import {admit,createLimiter} from '../../gateway.mjs';
import {hostHeader} from '../../../../lib/host-mode.mjs';
import {isOperatorPath} from '../../../proxy.mjs';
/**
 * The native gateway for the Pulse apps (desktop, phone, Chrome). Token-only: apart from sign-in, pairing and token
 * rotation, every call needs a per-device bearer credential that the person can revoke from Account → Security or
 * Settings → Devices. Access headers are never forwarded, so the outer gate cannot stand in for a device. Rate-limited
 * per address and per credential. PULSE_NATIVE_API_ENABLED=0 switches it off (503). Rules: ../../gateway.mjs.
 */
const limiter=createLimiter();
async function proxy(req:NextRequest,{params}:{params:Promise<{path:string[]}>}){
 const {path}=await params;
 if(isOperatorPath('/api/v0/',path))return Response.json({error:'Not found'},{status:404,headers:{'cache-control':'private, no-store'}});
 const gate=admit({path:path.join('/'),authorization:req.headers.get('authorization'),session:req.headers.get('x-pulse-session'),address:req.headers.get('cf-connecting-ip')??req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'local',enabled:process.env.PULSE_NATIVE_API_ENABLED!=='0',limiter});
 if(!gate.ok)return Response.json({error:gate.error},{status:gate.status,headers:{'cache-control':'private, no-store',...gate.headers}});
 const headers:Record<string,string>={'content-type':'application/json','x-pulse-device-agent':(req.headers.get('x-pulse-client')??req.headers.get('user-agent')??'').slice(0,500),'x-pulse-client-ip':req.headers.get('cf-connecting-ip')??'native',...gate.forward,...hostHeader(req.headers)};
 try{const payload=req.method==='POST'?await req.text():undefined;if(payload&&Buffer.byteLength(payload)>(path.join('/')==='feedback'?6291456:65536))return Response.json({error:'Payload too large'},{status:413});const r=await fetch(`${process.env.PULSE_API_URL??'http://127.0.0.1:8081'}/api/v0/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`,{method:req.method,headers,cache:'no-store',...(payload===undefined?{}:{body:payload}),signal:AbortSignal.timeout(50000)});return new Response(r.body,{status:r.status,headers:{'content-type':r.headers.get('content-type')??'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});}catch{return Response.json({error:'Native data service unavailable'},{status:503});}
}
export const GET=proxy;export const POST=proxy;
