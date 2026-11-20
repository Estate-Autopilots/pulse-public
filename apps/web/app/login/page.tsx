import { cookies, headers } from 'next/headers';
import { LoginForm } from './form';
import { getBranding } from '../lib/branding';
import { ShellSignedOut } from '../shell-bridge';
import { shellFromUserAgent } from '../lib/native-shell';
import { hostMode, requestHost } from '../lib/host-mode.mjs';
import { platformBrand } from '../lib/host-families.mjs';
import { safeNext } from '../lib/safe-next.mjs';
import { appNameFor } from '../lib/app-name';
export default async function Login({searchParams}:{searchParams:Promise<{change?:string;next?:string;google?:string;out?:string;with?:string;idp?:string;reason?:string}>}) {
 const [q,branding]=await Promise.all([searchParams,getBranding()]);
 // Only a page inside Pulse can be the place to return to after signing in (EST-1392 §3: one check for every return).
 const next=safeNext(q.next);
 const app=!!shellFromUserAgent((await headers()).get('user-agent'));
 // UX-TENANT: a company's own address has no "Continue with company Google" (that is the install's Access), and is
 // named after that company; the install's own addresses use the install's name (EST-655).
 const mode=await hostMode(requestHost(await headers()));
 // LOGIN-VITALS (owner, 13 Nov 2026): the platform's own addresses (app., staging., dev.vitalsos.ai) are Vitals OS: its
 // name and icon, and no company's logo or name (the address is nobody's company; EA's stays on EA's own address).
 const vitals=platformBrand(requestHost(await headers()));
 // EST-1399: the one quiet Google attempt is for a signed-out entry only. Never inside the Pulse apps (Google refuses
 // embedded views), after Google's answer or a sign-out, or over a session that ended: after an admin ends it, people
 // sign in again on purpose.
 const quiet=!app&&q.google===undefined&&q.reason===undefined&&!q.out&&!q.change&&!(await cookies()).has('pulse_session');
 // LOGIN-VITALS: back from Microsoft or Apple: their answer (`reason`), named after them.
 const idp=q.idp==='microsoft'||q.idp==='apple'?q.idp:undefined;
 // PULSE-ID: on the way to an app's consent screen, the sign-in names the app and offers "Create your account".
 // SELF-SERVE: also the ChatGPT or Claude connector (/oauth/mcp/authorize): a new person creates their account on the way.
 const forApp=await appNameFor(next,await headers());
 return <><LoginForm change={q.change==='1'||q.change==='own'} own={q.change==='own'} accessGate={mode.signIn!=='password'} next={next} app={app} companyName={vitals?undefined:mode.name??branding.name} product={vitals?.product} productIcon={vitals?.icon} orgBrand={!vitals} quiet={quiet} googleReason={q.google??(idp?q.reason:undefined)} idp={idp} signedOut={q.out==="1"} forApp={forApp} withPassword={q.with==="password"}
  /* ONBOARD-SELF: the public way in for a new company, on Pulse's own addresses only (never a company's). SIGNED-OUT-SHELL:
     inside the form's one "New to Pulse?" line, where sign-up is not open (sign-up names a company too). */
  startCompany={mode.own&&!app&&!forApp}/><ShellSignedOut/></>;
}

