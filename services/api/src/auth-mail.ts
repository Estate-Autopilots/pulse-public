import { googleBridge } from './google.js';
import { currentMailBrand } from './brand.js';
import { hostCompany } from './tenant-context.js';
import { platformMail } from './platform-config.js';
import { companyMail, hostedMailCompany } from './mailbox.js';
// CI is sink-only even when inherited production sending flags are set.
export const testMail: {from:string;to:string;title:string;body:string;replyTo?:string;fromName?:string}[]=[];
const mailSink=()=>process.env.PULSE_CI==='1'||process.env.NODE_ENV==='test'||process.env.PULSE_AUTH_MAIL_MODE==='sink';
// Configuration only: never inspect a recipient or probe a transport from a public recovery request.
export const authMailAvailable=()=>mailSink()||(process.env.PULSE_GMAIL_SEND_ENABLED==='1'&&!hostCompany());
export async function authMail(to: unknown,title: string,body: string,sign='HR'): Promise<boolean> {
 if(typeof to!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))return false;
 // MAILBOX: another company on the platform sends from its own mailbox (Settings → Mail, mailbox.ts), never the install's;
 // none connected, nothing is sent and the admin sees how many could not go out.
 const own=hostedMailCompany();
 if(own){const brand=await currentMailBrand();return (await companyMail(own,to,title,body+'\n\n'+(brand?.name??'Pulse')+(sign?' '+sign:'')))==='sent';}
 if(hostCompany())return false;
 if(!authMailAvailable())return false;
 // DE-EA: the install's sender (platform-config.ts); none set up, no mail.
 const from=platformMail().mailFrom;
 if(mailSink()){
  testMail.push({from:from??'pulse@mail.invalid',to,title,body});return true;
 }
 if(!from)return false;
 // googleBridge('send') enforces the configured production host and non-production allow-list.
 try{const brand=await currentMailBrand();await googleBridge('send',{subject:from,from,to,title,body:body+'\n\n'+(brand?.name??'Pulse')+(sign?' '+sign:''),...(brand?{brand}:{})});return true;}catch{return false;}
}
export const passwordNotice='Your Pulse password changed. Your other sessions have ended if you selected that option. If this was not you, contact HR immediately.';
