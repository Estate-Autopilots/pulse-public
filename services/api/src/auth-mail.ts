import { hostCompany, requestCompany } from './tenant-context.js';
import { resendConfigured } from './mail-provider.js';
import { mailSink, sendMail, testMail } from './mail-send.js';
// CI is sink-only even when inherited production sending flags are set (mail-send.ts).
export { testMail };
// MAIL-IDENTITY (owner, 4 Nov 2026): sign-in and sign-up codes, links, resets and account notices are platform mail:
// from "Pulse by Vitals" <no-reply@org-9912dc.example> through Resend (mail-identity.ts), in Pulse's look, never a company's
// logo or the install's HR mailbox. Without Resend the existing provider is the fallback, as before: the install's
// sender on its own addresses, a company's own mailbox on that company's address (MAILBOX), else nothing is sent.
// Configuration only: never inspect a recipient or probe a transport from a public recovery request.
export const authMailAvailable=()=>mailSink()||(process.env.PULSE_GMAIL_SEND_ENABLED==='1'&&(!hostCompany()||resendConfigured()));
/** `_sign` was the old sign-off ("<company> HR"); platform mail is signed by Pulse in its footer. */
export async function authMail(to: unknown,title: string,body: string,_sign='HR'): Promise<boolean> {
 if(typeof to!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))return false;
 if(!authMailAvailable()&&!hostCompany())return false;
 return sendMail({kind:'platform',to,title,body});
}
export const passwordNotice='Your Pulse password changed. Your other sessions have ended if you selected that option. If this was not you, contact HR immediately.';
/** ONBOARD-SELF (1462): Pulse's own e-mails about a Pulse account (a code to prove an address, an invitation into a
 *  company that started itself) are platform mail, like the sign-up code (MAIL-IDENTITY: from the platform's sender).
 *  On a company's own address they are about that company (Reply-To it). Sink in CI. */
const ownAddress=()=>{const r=requestCompany();return !!r?.hostOrg&&r.hostOrg!==r.installOrg;};
export const pulseMailAvailable=()=>ownAddress()?authMailAvailable():mailSink()||process.env.PULSE_GMAIL_SEND_ENABLED==='1';
export async function pulseMail(to: unknown, title: string, body: string): Promise<boolean> {
 if(ownAddress())return authMail(to,title,body,'');
 if(typeof to!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)||!pulseMailAvailable())return false;
 return sendMail({kind:'platform',to,title,body,org:null});
}
