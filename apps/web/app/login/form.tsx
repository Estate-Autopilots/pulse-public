'use client';
import { useEffect,useState,type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, Check, Circle, FolderKanban, MessagesSquare } from 'lucide-react';
import { post } from '../records';
import { organizationDisplayName } from '../lib/branding-name';
import css from './login.module.css';
import { markSvg } from '@pulse/design-system/brand';
import { orgLogo, type OrgBrand, type OrgLogo } from '../lib/brand';
import { PasswordField } from './password-field';

/** The Pulse mark (packages/design-system/brand). */
function Mark({ size = 40 }: { size?: number }) {
  return <span style={{ display: "inline-flex", width: size, height: size }} dangerouslySetInnerHTML={{ __html: markSvg({ size, id: "login-mark" }) }} />;
}

/** EST-1399: Continue with Google starts on the server (EST-1392 contract §3); `next` already passed the shared check. */
const googleStart=(mode:'signin'|'silent',next?:string)=>`/api/v0/auth/google/start?mode=${mode}${next?`&next=${encodeURIComponent(next)}`:''}`;
type Notice={tone:'error'|'info';text:string};
/** Google's answer (`?google=<reason>`, contract §3), shown above the normal page; any other value reads as the last one. */
const GOOGLE:Record<string,Notice>={
 silent_failed:{tone:'info',text:'Pulse could not sign you in with Google automatically. Choose Continue with Google, or sign in with your Pulse password.'},
 not_linked:{tone:'error',text:'This Google account is not linked to anyone in Pulse. Sign in with your Pulse password, then link Google in Account / Security.'},
 domain_not_allowed:{tone:'error',text:'This Google account is not on an allowed work domain. Use your work Google account.'},
 account_disabled:{tone:'error',text:'Sign-in is turned off for this account. Ask your admin.'},
 already_linked:{tone:'error',text:'That Google account is already linked to someone else in Pulse.'},
 state_invalid:{tone:'error',text:'That Google sign-in expired or was already used. Choose Continue with Google again.'},
 provider_error:{tone:'error',text:'Google sign-in is not available right now. Sign in with your Pulse password, or try again in a few minutes.'},
 two_step:{tone:'info',text:'Google confirmed it is you. Pulse still asks for your 2-step code: enter it to finish.'},
 other:{tone:'error',text:'Google sign-in did not finish. Try again, or sign in with your Pulse password.'},
};
/** After Google, Pulse's own 2-step challenge waits in an HttpOnly cookie the proxy adds; the page sends the code alone. */
const VIA_GOOGLE='google';
const SIGNED_OUT:Notice={tone:'info',text:'You are signed out of Pulse on this device. Google and your other work apps stay signed in.'};

/** Sign in, forgot password, and the first-sign-in password change. `framed` is the change form inside the app frame. */
/** `next`: where to go after signing in. `app`: inside the Pulse phone app, where staying signed in is the default.
 *  `quiet`: a signed-out entry, where the page may make its one quiet Google attempt; `googleReason`: Google's answer. */
export function LoginForm({change=false,accessGate=false,framed=false,own=false,client=false,next:after,app=false,companyName="Pulse",quiet=false,googleReason,signedOut=false,forApp}:{change?:boolean;accessGate?:boolean;framed?:boolean;own?:boolean;client?:boolean;next?:string;app?:boolean;companyName?:string;quiet?:boolean;googleReason?:string;signedOut?:boolean;
 /** PULSE-ID: the app this sign-in continues to (Sign in with Pulse): named here, with "Create your account". */ forApp?:string}) {
 const router=useRouter(),[error,setError]=useState<Notice|null>(null),[busy,setBusy]=useState(false),[forgot,setForgot]=useState(false),[usernameHelp,setUsernameHelp]=useState(false),[linkHelp,setLinkHelp]=useState(false),[challenge,setChallenge]=useState(googleReason==='two_step'&&!change?VIA_GOOGLE:'');
 const [google,setGoogle]=useState(false),[waiting,setWaiting]=useState(false);
 const notice=googleReason?(Object.hasOwn(GOOGLE,googleReason)?GOOGLE[googleReason]:GOOGLE.other):signedOut?SIGNED_OUT:null;
 const [next,setNext]=useState(''),[again,setAgain]=useState('');
 // LAYOUT-SWEEP: the organisation's own logo above the form, read in the browser (public) so the page never waits for it.
 const [org,setOrg]=useState<OrgLogo|null>(null);
 // POLISH-2 (QA-E2E P2-9): "Forgot your password?" is a step of its own in the history, so Back (Android's too) returns
 // to the sign-in form instead of leaving the page or the Pulse app.
 useEffect(()=>{const back=()=>{setForgot(false);setUsernameHelp(false);setLinkHelp(false);setError(null);};window.addEventListener('popstate',back);return()=>window.removeEventListener('popstate',back);},[]);
 const toggleForgot=()=>{setChallenge('');setError(null);setLinkHelp(false);if(forgot){if(history.state?.pulseForgot)history.back();else setForgot(false);return;}history.pushState({...history.state,pulseForgot:true},'');setForgot(true);};
 // EST-1399: Continue with Google once the organisation switches it on (public branding; no answer means off), never in the
 // Pulse apps. A signed-out entry makes one quiet attempt, and the cookie stops another for 10 minutes: no loops.
 useEffect(()=>{if(framed||client||change||app)return;let live=true;
  void fetch('/api/v0/auth/branding',{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<{google?:unknown}>:null).then(b=>{
   if(!live||b?.google!==true)return;setGoogle(true);
   if(!quiet||/(?:^|;\s*)pulse_oidc_quiet=/.test(document.cookie))return;
   document.cookie='pulse_oidc_quiet=1; Max-Age=600; Path=/; SameSite=Lax';setWaiting(true);
  }).catch(()=>{});
  // Back from Google's page restores this page from the cache: the normal page then, not the waiting one.
  const shown=(e:PageTransitionEvent)=>{if(e.persisted)setWaiting(false);};window.addEventListener('pageshow',shown);
  return()=>{live=false;window.removeEventListener('pageshow',shown);};
 },[framed,client,change,app,quiet,after]);
 // Commit the waiting page before starting a browser navigation that can pause React's pending work.
 useEffect(()=>{if(waiting)location.replace(googleStart('silent',after));},[waiting,after]);
 useEffect(()=>{if(framed)return;let live=true;void fetch('/api/v0/brand').then(r=>r.ok?r.json() as Promise<OrgBrand>:null).then(b=>{if(live)setOrg(orgLogo(b));}).catch(()=>{});return()=>{live=false;};},[framed]);
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setError(null);
  const data=Object.fromEntries(new FormData(e.currentTarget)) as Record<string,string>;
  if(change&&data.next!==data.again){setError({tone:'error',text:'The two new passwords are not the same.'});return;}
  if(change&&data.next===data.current){setError({tone:'error',text:own?'Choose a password that is different from your current one.':'Choose a password that is different from your current one.'});return;}
  setBusy(true);
  // PORTAL-2: a Pulse account (clients, freelancers) gets its own e-mailed sign-in link; "Forgot your password?" asks
  // the organisation's recovery and the account's at once (each answers the same whether or not anything matches).
  if(forgot&&linkHelp&&!client){
   try{const r=await post<{message?:string}>('auth/account-link',{login:data.username});setError({tone:'info',text:r.message??'If a Pulse account matches, a sign-in link is on its way to its e-mail.'});}
   catch(e){setError({tone:'error',text:e instanceof Error?e.message:'Could not send the link'});}finally{setBusy(false);}
   return;
  }
  const accountReset=forgot&&!usernameHelp&&!client&&!change&&!challenge?post('auth/account-forgot',{login:data.username}).catch(()=>null):null;
  try{
   const result=await post<{mustChange?:boolean;twoStep?:boolean;challenge?:string;enrollmentRequired?:boolean;message?:string}>((client?'portal/':'')+(change?'auth/change-password':challenge?'auth/two-step':forgot?(usernameHelp?'auth/forgot-username':'auth/forgot'):'auth/sign-in'),change?{current:data.current,next:data.next}:challenge?{code:data.code,...(challenge===VIA_GOOGLE?{}:{challenge})}:{...data,remember:data.remember==='on'});
   if(result.twoStep){setChallenge(result.challenge??'');return;}
   if(forgot){await accountReset;setError({tone:'info',text:result.message??'If an eligible account matches and mail delivery is available, a recovery email may arrive. Ask your admin for a new link if needed.'});}
   // Replace, not push: Back after signing in never returns to the sign-in page.
   else{router.replace(client?'/portal':result.enrollmentRequired?'/account':!change&&result.mustChange?'/login?change=1':change&&!own?'/dashboard?welcome=1':after??'/');router.refresh();}
  }catch(e){
   // ORG: a Pulse account (a handle or e-mail with the account's own password) signs in at the shared address too, into
   // the organisation it used last: freelancers and clients who joined with an invitation have no company username.
   if(!client&&!change&&!challenge&&!forgot&&data.username&&data.password){
    try{const account=await post<{home?:string;kind?:string}>('auth/account-sign-in',{login:data.username,password:data.password});router.replace(after??(account.kind==='client'?'/client':account.home)??'/dashboard');router.refresh();return;}catch{/* the first answer stands */}
   }
   // The organisation's recovery may be off while the account's is on: the account's answer then stands.
   if(accountReset){const r=await accountReset as {message?:string}|null;if(r?.message){setError({tone:'info',text:r.message});return;}}
   setError({tone:'error',text:e instanceof Error?e.message:'Could not sign in'});}finally{setBusy(false);}
 }
 const rules=[{ok:new TextEncoder().encode(next).length>=10,text:'At least 10 bytes'},{ok:!!next&&next===again,text:'Both new passwords match'}];
 // The organisation's own brand record first (LAYOUT-SWEEP, per address), then the install's name (EST-655); none for a bare install.
 const company=organizationDisplayName(org?.name)??organizationDisplayName(companyName);
 const form=<form onSubmit={submit} className={css.form} noValidate={false}>
  {/* eslint-disable-next-line @next/next/no-img-element -- the organisation's logo, served by the app */}
  {org?.logo&&!framed?<span className={css.orgLogo}><img className={css.orgLight} src={org.logo} alt={company}/><img className={css.orgDark} src={org.logoDark??org.logo} alt="" aria-hidden="true"/></span>:null}
  <p className={css.kicker}>{change?(own?'Your account':'First sign-in'):challenge?'Two-step verification':forgot?(linkHelp?'Sign-in link':usernameHelp?'Forgot username':'Forgot password'):forApp?'Sign in with Pulse':'Welcome to Pulse'}</p>
  <h1 className={css.title}>{change?(own?'Change your password':'Set your own password'):challenge?'Verify it’s you':forgot?(linkHelp?'Sign in with a link':usernameHelp?'Find your username':'Reset your password'):(client?'Client sign-in':forApp?`Sign in to continue to ${forApp}`:'Sign in to Pulse')}</h1>
  <p className={css.sub}>{!change&&!challenge&&!forgot&&google?'Continue with your work Google account, or use your Pulse username and password.':change?(own?'Other devices where you are signed in are signed out when you change it.':'Choose a unique password before continuing to your workspace.'):challenge?'Enter an authenticator code or one of your recovery codes. HR can reset two-step after checking your identity.':forgot?(linkHelp?'Clients and freelancers: type your @handle or the e-mail of your Pulse account. We e-mail you a link that signs you in once, within 15 minutes.':usernameHelp?'Enter your delivery email. We will email your username if it matches an eligible account.':'Enter your username, @handle or e-mail for a private, one-time reset link.'):accessGate?'Team: your Pulse username and password, or your company Google account. Clients and freelancers: your @handle or e-mail and the password you chose.':'Use your Pulse username or @handle and your password.'}</p>
  {change?<>
   <PasswordField label="Current password" name="current" required autoComplete="current-password" />
   <PasswordField label="New password" name="next" maxLength={72} required autoComplete="new-password" value={next} onChange={(e)=>setNext(e.target.value)} />
   <PasswordField label="New password again" name="again" maxLength={72} required autoComplete="new-password" value={again} onChange={(e)=>setAgain(e.target.value)} />
   <ul className={css.rules}>{rules.map((r)=><li key={r.text} data-ok={r.ok?'':undefined}>{r.ok?<Check size={14} aria-hidden="true"/>:<Circle size={14} aria-hidden="true"/>}{r.text}</li>)}</ul>
  </>:challenge?<label className={css.field}>Authenticator or recovery code<input name="code" required autoComplete="one-time-code" autoCapitalize="none" maxLength={40}/></label>:<>
   {!forgot&&notice?<p className={css.status} data-tone={notice.tone} role={notice.tone==='error'?'alert':'status'}>{notice.text}</p>:null}
   {!forgot&&google?<><a className={css.secondary} href={googleStart('signin',after)}>Continue with Google</a><div className={css.or}>or</div></>:null}
   <label className={css.field}>{forgot?(linkHelp?'@handle or e-mail':usernameHelp?'Delivery email':'Username, @handle or e-mail'):'Username or @handle'}<input name="username" required autoComplete="username" maxLength={254} placeholder={forgot&&(usernameHelp||linkHelp)?"user-aa260886@gmail.com":"firstname.lastname or @handle"} autoCapitalize="none" spellCheck={false}/></label>
   {!forgot?<><PasswordField label="Password" name="password" required autoComplete="current-password" /><label className={css.foot}><input type="checkbox" name="remember" defaultChecked={app}/> Keep me signed in on this device (30 days)</label></>:null}
  </>}
  {/* ONBOARD: people who sign in with Google have no Pulse password to reset. */}
  {forgot&&!usernameHelp&&!linkHelp&&google&&!client?<p className={css.status} data-tone="info">Sign in with Google? Your password is your Google password: reset it at Google, or ask the admin. This form resets a Pulse password.</p>:null}
  {error?<p className={css.status} data-tone={error.tone} role={error.tone==='error'?'alert':'status'}>{error.text}</p>:null}
  <button className={css.primary} disabled={busy}>{busy?'Working…':change?(own?'Change password':'Set password and continue'):challenge?'Verify and sign in':forgot?(linkHelp?'E-mail me a sign-in link':usernameHelp?'Email my username':'Send reset link'):'Sign in'}</button>
  {!change&&!forgot&&accessGate&&!google?<><div className={css.or}>or</div><button type="button" className={css.secondary} onClick={async()=>{await post('auth/sign-out',{}).catch(()=>{});router.push('/dashboard');router.refresh();}}>Continue with company Google account</button></>:null}
  {!change?<button type="button" className={css.link} onClick={toggleForgot}>{forgot?'Back to sign in':'Forgot your password?'}</button>:null}
  {!change&&!challenge?<button type="button" className={css.link} onClick={()=>{if(!forgot)history.pushState({...history.state,pulseForgot:true},'');setForgot(true);setLinkHelp(false);setUsernameHelp(!usernameHelp||linkHelp);setError(null);}}>{usernameHelp&&!linkHelp?'Forgot your password?':'Forgot your username?'}</button>:null}
  {!change&&!challenge&&!client&&!framed&&!linkHelp?<button type="button" className={css.link} onClick={()=>{if(!forgot)history.pushState({...history.state,pulseForgot:true},'');setForgot(true);setUsernameHelp(false);setLinkHelp(true);setError(null);}}>E-mail me a sign-in link</button>:null}
  {forApp&&!change&&!challenge&&!forgot?<p className={css.foot}>New to Pulse? <a href={`/signup?${new URLSearchParams({next:after??'/'})}`}>Create your account</a></p>:null}
  {!change&&!challenge&&!client&&!framed&&!forApp?<a className={css.link} href="/login/how">New here? How you get into Pulse</a>:null}
  <p className={css.foot}>{company?`${company}. `:''}Every sign-in is recorded.</p>
 </form>;
 if(framed)return <div className={css.framed}>{form}</div>;
 return <div className={css.screen}>
  <section className={css.brand} aria-label="Pulse">
   <div className={css.wordmark}><Mark/><span><b>Pulse</b>{company?<small>for {company}</small>:null}</span></div>
   <div>
    <h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2>
    <p className={css.lede}>Check in, plan leave, find any project or client and talk to your pod, with the evidence behind every number.</p>
   </div>
   <svg className={css.beat} viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="login-beat" x1="0" x2="1"><stop offset="0" stopColor="#a78bfa" stopOpacity="0.2"/><stop offset="0.5" stopColor="#c4b5fd"/><stop offset="1" stopColor="#f0abfc" stopOpacity="0.4"/></linearGradient></defs><path d="M0 70 H150 L175 70 L195 30 L222 108 L248 14 L272 82 L290 70 H600"/></svg>
   <ul className={css.chips}><li><CalendarCheck size={15} aria-hidden="true"/>Attendance &amp; leave</li><li><FolderKanban size={15} aria-hidden="true"/>Projects &amp; clients</li><li><MessagesSquare size={15} aria-hidden="true"/>Pod chats</li></ul>
  </section>
  <div className={css.side}>{waiting?<div className={css.form} role="status"><p className={css.kicker}>Welcome to Pulse</p><h1 className={css.title}>Signing you in…</h1><p className={css.sub}>Checking your Google sign-in. Pulse opens where you were going in a moment.</p></div>:form}</div>
 </div>;
}
