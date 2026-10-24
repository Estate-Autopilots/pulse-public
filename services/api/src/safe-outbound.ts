import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class OutboundError extends Error {
 constructor(public readonly kind:'timeout'|'dns'|'destination'|'redirect'|'response_size'|'network'){super(kind);}
}
// Conservative globally routable ranges; reject mapped/transition IPv6 and IANA special-use space.
const denied=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
 ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],
 ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)denied.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)denied.addSubnet(ip,bits,'ipv6');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
export function publicAddress(ip:string):boolean {
 const family=isIP(ip);return family===4?!denied.check(ip,'ipv4'):family===6&&global6.check(ip,'ipv6')&&!denied.check(ip,'ipv6');
}
export async function safeOutbound(destination:string,body:string,headers:Record<string,string>,timeoutMs=3000,
 resolve=lookup,send=request):Promise<{status:number;host:string}> {
 let url:URL;
 try{url=new URL(destination);}catch{throw new OutboundError('destination');}
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.hash)throw new OutboundError('destination');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(timeoutMs,3000)));
 try {
  const addresses=await Promise.race([isIP(host)?Promise.resolve([{address:host,family:isIP(host)}]):resolve(host,{all:true,verbatim:true}),
   new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new OutboundError('timeout')),{once:true}))]);
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new OutboundError('destination');
  const pinned=addresses[0];
  return await new Promise((accept,reject)=>{
   const req=send(url,{method:'POST',agent:false,rejectUnauthorized:true,family:pinned.family,signal:controller.signal,maxHeaderSize:8192,
    headers:{...headers,'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))},
    lookup:(_hostname,_options,done)=>done(null,pinned.address,pinned.family)},res=>{
     const status=res.statusCode??0;
     if(status>=300&&status<400){res.destroy();reject(new OutboundError('redirect'));return;}
     let bytes=0;
     res.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384){res.destroy();reject(new OutboundError('response_size'));}});
     res.on('end',()=>accept({status,host}));res.on('error',()=>reject(new OutboundError('network')));
    });
   req.on('error',()=>reject(new OutboundError(controller.signal.aborted?'timeout':'network')));req.end(body);
  });
 }catch(error){throw error instanceof OutboundError?error:new OutboundError('dns');}
 finally{clearTimeout(timer);}
}
