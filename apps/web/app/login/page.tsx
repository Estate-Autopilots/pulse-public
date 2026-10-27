import { cookies, headers } from 'next/headers';
import { LoginForm } from './form';
import { getBranding } from '../lib/branding';
import { ShellSignedOut } from '../shell-bridge';
import { shellFromUserAgent } from '../lib/native-shell';
import { hostHeader, hostMode, requestHost } from '../lib/host-mode.mjs';
import { safeNext } from '../lib/safe-next.mjs';
export default async function Login({searchParams}:{searchParams:Promise<{change?:string;next?:string;google?:string;out?:string}>}) {
 const [q,branding]=await Promise.all([searchParams,getBranding()]);
 // Only a page inside Pulse can be the place to return to after signing in (EST-1392 §3: one check for every return).
 const next=safeNext(q.next);
 const app=!!shellFromUserAgent((await headers()).get('user-agent'));
 // UX-TENANT: a company's own address has no "Continue with company Google" (that is the install's Access), and is
 // named after that company; the install's own addresses use the install's name (EST-655).
 const mode=await hostMode(requestHost(await headers()));
 // EST-1399: the one quiet Google attempt is for a signed-out entry only. Never inside the Pulse apps (Google refuses
 // embedded views), after Google's answer or a sign-out, or over a session that ended: after an admin ends it, people
 // sign in again on purpose.
 const quiet=!app&&q.google===undefined&&!q.out&&!q.change&&!(await cookies()).has('pulse_session');
 // PULSE-ID: on the way to an app's consent screen, the sign-in names the app and offers "Create your account".
 const forApp=next?.startsWith('/oauth/authorize?')?await appName(next,await headers()):undefined;
 return <><LoginForm change={q.change==='1'||q.change==='own'} own={q.change==='own'} accessGate={mode.signIn!=='password'} next={next} app={app} companyName={mode.name??branding.name} quiet={quiet} googleReason={q.google} signedOut={q.out==='1'} forApp={forApp}/><ShellSignedOut/></>;
}

/** The registered name of the app a Sign in with Pulse request is for (the API's public check), or undefined. */
async function appName(next:string,h:Headers):Promise<string|undefined>{
 try{
  const r=await fetch(`${process.env.PULSE_API_URL??'http://127.0.0.1:8081'}/api/v0/oidc/authorize/check?${new URL(next,'https://pulse.invalid').searchParams}`,{cache:'no-store',signal:AbortSignal.timeout(5000),headers:{...hostHeader(h),'x-pulse-client-ip':h.get('cf-connecting-ip')??h.get('x-forwarded-for')?.split(',')[0]?.trim()??'login-page'}});
  const d=r.ok?await r.json():null;return typeof d?.app?.name==='string'&&!d.fatal?d.app.name:undefined;
 }catch{return undefined;}
}
