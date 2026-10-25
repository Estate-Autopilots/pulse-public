import { googleBridge } from './google.js';
import { currentMailBrand } from './brand.js';
import { hostCompany } from './tenant-context.js';
// CI is sink-only even when inherited production sending flags are set.
export const testMail: {from:string;to:string;title:string;body:string}[]=[];
const mailSink=()=>process.env.PULSE_CI==='1'||process.env.NODE_ENV==='test'||process.env.PULSE_AUTH_MAIL_MODE==='sink';
// Configuration only: never inspect a recipient or probe a transport from a public recovery request.
export const authMailAvailable=()=>mailSink()||(process.env.PULSE_GMAIL_SEND_ENABLED==='1'&&!hostCompany());
export async function authMail(to: unknown,title: string,body: string): Promise<boolean> {
 if(typeof to!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))return false;
 if(hostCompany())return false;
 if(!authMailAvailable())return false;
 const from=process.env.PULSE_MAIL_FROM?.trim()||'hr@estateautopilots.com';
 if(mailSink()){
  testMail.push({from,to,title,body});return true;
 }
 // googleBridge('send') enforces the configured production host and non-production allow-list.
 try{const brand=await currentMailBrand();await googleBridge('send',{subject:from,from,to,title,body:body+'\n\n'+(brand?.name??'Pulse')+' HR',...(brand?{brand}:{})});return true;}catch{return false;}
}
export const passwordNotice='Your Pulse password changed. Your other sessions have ended if you selected that option. If this was not you, contact HR immediately.';
