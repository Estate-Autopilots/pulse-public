'use client';
import { useEffect,useRef,useState,type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Circle, KeyRound, MessageCircleWarning, QrCode, Ticket, UserRound } from 'lucide-react';
import { post } from '../records';
import { organizationDisplayName } from '../lib/branding-name';
import css from './login.module.css';
import { markSvg } from '@pulse/design-system/brand';
import { orgLogo, type OrgBrand, type OrgLogo } from '../lib/brand';
import { PasswordField } from './password-field';
import { SecondStep, type SecondStepMethods } from './second-step';
import { CodeSignIn } from './code-sign-in';
import { openBugReport } from '../bug-report/open';

/** The Pulse mark (packages/design-system/brand), or the product's own icon (Vitals OS on the platform's addresses). */
function Mark({ size = 40, icon }: { size?: number; icon?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- the product's icon, a static file of the app
  if (icon) return <img src={icon} alt="" width={size} height={size} style={{ borderRadius: Math.round(size * 0.28) }} />;
  return <span style={{ display: "inline-flex", width: size, height: size }} dangerouslySetInnerHTML={{ __html: markSvg({ size, id: "login-mark" }) }} />;
}

/** Google's "G", as Google's sign-in button guidelines ask for next to "Continue with Google". */
function GoogleG(){
 return <svg className={css.providerIcon} viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>;
}

/** EST-1399: Continue with Google starts on the server (EST-1392 contract §3); `next` already passed the shared check. */
const googleStart=(mode:'signin'|'silent',next?:string,idp:Idp='google')=>`/api/v0/auth/${idp}/start?mode=${mode}${next?`&next=${encodeURIComponent(next)}`:''}`;
/** LOGIN-VITALS: the sign-in providers the page may offer (the API's branding says which are switched on here). */
type Idp='google'|'microsoft'|'apple';
const IDP_NAME:Record<Idp,string>={google:'Google',microsoft:'Microsoft',apple:'Apple'};
function MicrosoftMark(){return <svg className={css.providerIcon} viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><path fill="#f25022" d="M0 0h10v10H0z"/><path fill="#7fba00" d="M11 0h10v10H11z"/><path fill="#00a4ef" d="M0 11h10v10H0z"/><path fill="#ffb900" d="M11 11h10v10H11z"/></svg>;}
function AppleMark(){return <svg className={css.providerIcon} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>;}
/** One full-width "Continue with Google" when it is the only provider; with Microsoft or Apple too, one row of short buttons.
 *  LOGIN-VITALS (the owner's order): under the page's own buttons, after an "or". */
function Providers({list,next}:{list:Idp[];next?:string}){
 if(!list.length)return null;
 const icon=(p:Idp)=>p==='google'?<GoogleG/>:p==='microsoft'?<MicrosoftMark/>:<AppleMark/>;
 return <>{list.length===1?<a className={css.secondary} href={googleStart('signin',next,list[0])}>{icon(list[0])}Continue with {IDP_NAME[list[0]]}</a>
  :<div className={css.providerRow}>{list.map((p)=><a key={p} className={css.secondary} href={googleStart('signin',next,p)} aria-label={`Continue with ${IDP_NAME[p]}`}>{icon(p)}{IDP_NAME[p]}</a>)}</div>}</>;
}
type Notice={tone:'error'|'info';text:string};
/** Google's answer (`?google=<reason>`, contract §3), shown above the normal page; any other value reads as the last one. */
const GOOGLE:Record<string,Notice>={
 silent_failed:{tone:'info',text:'Pulse could not sign you in with Google automatically. Choose Continue with Google, or sign in with your Pulse password.'},
 not_linked:{tone:'error',text:'We couldn’t find you in Pulse with that Google account. Ask your admin to add that e-mail to your Pulse profile (work or personal e-mail), or choose Send me a code.'},
 domain_not_allowed:{tone:'error',text:'This Google account is not on an allowed work domain. Use your work Google account, or the Google account of the e-mail Pulse has for you.'},
 account_disabled:{tone:'error',text:'Sign-in is turned off for this account. Ask your admin.'},
 already_linked:{tone:'error',text:'That Google account is already linked to someone else in Pulse.'},
 state_invalid:{tone:'error',text:'That Google sign-in expired or was already used. Choose Continue with Google again.'},
 provider_error:{tone:'error',text:'Google sign-in is not available right now. Sign in with your Pulse password, or try again in a few minutes.'},
 two_step:{tone:'info',text:'Google confirmed it is you. Pulse still asks for your 2-step code: enter it to finish.'},
 email_unverified:{tone:'error',text:'Google did not confirm the e-mail address of that account, so Pulse cannot match it. Choose Send me a code.'},
 other:{tone:'error',text:'Google sign-in did not finish. Try again, or sign in with your Pulse password.'},
};
/** After Google, Pulse's own 2-step challenge waits in an HttpOnly cookie the proxy adds; the page sends the code alone. */
const VIA_GOOGLE='google';
const SIGNED_OUT:Notice={tone:'info',text:'You are signed out of Pulse on this device. Google and your other work apps stay signed in.'};

/** STAFF-UX: the sign-in refusal says what to check. The API keeps one answer for a wrong name, a wrong password and a
 *  lock (it never says which accounts exist); what was typed can still be read here: an e-mail where a username goes,
 *  Caps Lock. Other answers (too many attempts, a password rule) are already precise and stand as they are. */
function explain(text:string,typed:string,caps:boolean,signIn:boolean){
 if(!signIn||!/^Sign-in details are unavailable/.test(text))return text;
 if(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed))return 'That looks like an e-mail address. Staff sign in with their Pulse username, like firstname.lastname. Don’t know it? Choose Forgot your username? and it is e-mailed to you.';
 return `The username or the password is not right${caps?' (Caps Lock is on)':''}. Check both: passwords care about capital letters. After several wrong tries the account waits 15 minutes. Choose E-mail me a sign-in code to get in with a code sent to your work e-mail, or Forgot your password? to set a new one.`;
}

/** Sign in, forgot password, and the first-sign-in password change. `framed` is the change form inside the app frame. */
/** `next`: where to go after signing in. `app`: inside the Pulse phone app, where staying signed in is the default.
 *  `quiet`: a signed-out entry, where the page may make its one quiet Google attempt; `googleReason`: Google's answer. */
export function LoginForm({change=false,accessGate=false,framed=false,own=false,client=false,next:after,app=false,companyName="Pulse",quiet=false,googleReason,signedOut=false,forApp,startCompany=false,withPassword=false,product="Pulse",productIcon,orgBrand=true,idp}:{change?:boolean;
 /** LOGIN-VITALS: the provider `googleReason` came back from (Microsoft or Apple; Google when absent). */ idp?:'microsoft'|'apple';
 /** LOGIN-VITALS: the product this address wears ("Vitals OS" and its icon on the platform's own addresses, where no
  *  company's logo or name is shown: `orgBrand` false). */ product?:string;productIcon?:string;orgBrand?:boolean;
 /** IDENTITY-SIGNIN: open on the password (`/login?with=password`) instead of the e-mailed code. */ withPassword?:boolean;accessGate?:boolean;framed?:boolean;own?:boolean;client?:boolean;next?:string;app?:boolean;companyName?:string;quiet?:boolean;googleReason?:string;signedOut?:boolean;
 /** PULSE-ID: the app this sign-in continues to (Sign in with Pulse): named here, with "Create your account". */ forApp?:string;
 /** ONBOARD-SELF: "Start your company on Pulse" is offered here (Pulse's own addresses, not in the app). */ startCompany?:boolean}) {
 const router=useRouter(),[methods,setMethods]=useState<SecondStepMethods|null>(null),[error,setError]=useState<Notice|null>(null),[busy,setBusy]=useState(false),[forgot,setForgot]=useState(false),[usernameHelp,setUsernameHelp]=useState(false),[linkHelp,setLinkHelp]=useState(false),[challenge,setChallenge]=useState(googleReason==='two_step'&&!change?VIA_GOOGLE:'');
 const [others,setOthers]=useState<Idp[]>([]),[google,setGoogle]=useState(false),[waiting,setWaiting]=useState(false),[caps,setCaps]=useState(false),[signup,setSignup]=useState(false),[help,setHelp]=useState(false);
 // IDENTITY-SIGNIN (owner, 7 Nov 2026): the e-mailed code (code-sign-in.tsx) is the first way in; the password is the
 // second ("Use my password instead"), and each switch carries what was typed. "Keep me signed in" starts ticked on every
 // way in (30 days on this device); `keep` is the choice made, sent again with the second step.
 const formRef=useRef<HTMLFormElement>(null),[password,setPassword]=useState(withPassword),[prefill,setPrefill]=useState({username:'',remember:true,n:0}),[refused,setRefused]=useState(false),[keep,setKeep]=useState(true);
 // LOGIN-VITALS: the notices name the product this address wears ("your Vitals OS password" on vitalsos.ai).
 const say=(text:string)=>(product==='Pulse'?text:text.replace(/\bPulse\b/g,product)).replace(/\bGoogle\b/g,idp?IDP_NAME[idp]:'Google');
 const shown=googleReason?(Object.hasOwn(GOOGLE,googleReason)?GOOGLE[googleReason]:GOOGLE.other):signedOut?SIGNED_OUT:null;
 const notice=shown?{...shown,text:say(shown.text)}:null;
 const [next,setNext]=useState(''),[again,setAgain]=useState('');
 // LAYOUT-SWEEP: the organisation's own logo above the form, read in the browser (public) so the page never waits for it.
 const [org,setOrg]=useState<OrgLogo|null>(null);
 // POLISH-2 (QA-E2E P2-9): "Forgot your password?" is a step of its own in the history, so Back (Android's too) returns
 // to the sign-in form instead of leaving the page or the Pulse app.
 useEffect(()=>{const back=()=>{setForgot(false);setUsernameHelp(false);setLinkHelp(false);setError(null);};window.addEventListener('popstate',back);return()=>window.removeEventListener('popstate',back);},[]);
 /** Back to the e-mailed code, with the username and the remember choice typed in the password form. */
 const openCode=()=>{const f=formRef.current?new FormData(formRef.current):null;setError(null);setRefused(false);setPrefill((p)=>({username:String(f?.get('username')??'').trim(),remember:f?f.get('remember')==='on':true,n:p.n+1}));setPassword(false);};
 const openPassword=(username:string,remember:boolean)=>{setError(null);setPrefill((p)=>({username,remember,n:p.n+1}));setPassword(true);};
 const toggleForgot=()=>{setChallenge('');setError(null);setLinkHelp(false);if(forgot){if(history.state?.pulseForgot)history.back();else setForgot(false);return;}history.pushState({...history.state,pulseForgot:true},'');setForgot(true);};
 // EST-1399: Continue with Google once the organisation switches it on (public branding; no answer means off), never in the
 // Pulse apps. A signed-out entry makes one quiet attempt, and the cookie stops another for 10 minutes: no loops.
 useEffect(()=>{if(framed||client||change||app)return;let live=true;
  void fetch('/api/v0/auth/branding',{cache:'no-store'}).then(r=>r.ok?r.json() as Promise<{google?:unknown;microsoft?:unknown;apple?:unknown;signup?:unknown}>:null).then(b=>{
   // ACCOUNT-CODE: personal sign-up is offered where it is open (the shared address).
   if(live&&b?.signup===true)setSignup(true);
   // LOGIN-VITALS: Microsoft and Apple where the server switched them on (no quiet attempt: that is Google's alone).
   if(live)setOthers((['microsoft','apple'] as const).filter((p)=>b?.[p]===true));
   if(!live||b?.google!==true)return;setGoogle(true);
   if(!quiet||/(?:^|;\s*)pulse_oidc_quiet=/.test(document.cookie))return;
   document.cookie='pulse_oidc_quiet=1; Max-Age=600; Path=/; SameSite=Lax';setWaiting(true);
  }).catch(()=>{});
  // Back from Google's page restores this page from the cache: the normal page then, not the waiting one.
  const shown=(e:PageTransitionEvent)=>{if(e.persisted)setWaiting(false);};window.addEventListener('pageshow',shown);
  return()=>{live=false;window.removeEventListener('pageshow',shown);};
 },[framed,client,change,app,quiet,after]);
 // LOGIN-VITALS: "Trouble signing in?" opens its list below the fold on a phone: bring it into view.
 useEffect(()=>{if(help)document.getElementById('login-more-ways')?.scrollIntoView({block:'nearest',behavior:'smooth'});},[help]);
 // Commit the waiting page before starting a browser navigation that can pause React's pending work.
 useEffect(()=>{if(waiting)location.replace(googleStart('silent',after));},[waiting,after]);
 useEffect(()=>{if(framed||!orgBrand)return;let live=true;void fetch('/api/v0/brand').then(r=>r.ok?r.json() as Promise<OrgBrand>:null).then(b=>{if(live)setOrg(orgLogo(b));}).catch(()=>{});return()=>{live=false;};},[framed,orgBrand]);
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setError(null);
  const data=Object.fromEntries(new FormData(e.currentTarget)) as Record<string,string>;
  // STAFF-UX: a phone's autofill or keyboard often adds a space after the username; it never belongs to it.
  if(typeof data.username==='string')data.username=data.username.trim();
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
  const remember=data.remember==='on';
  if(!change&&!challenge&&!forgot)setKeep(remember);
  try{
   const result=await post<{mustChange?:boolean;twoStep?:boolean;challenge?:string;methods?:SecondStepMethods;enrollmentRequired?:boolean;message?:string}>((client?'portal/':'')+(change?'auth/change-password':challenge?'auth/two-step':forgot?(usernameHelp?'auth/forgot-username':'auth/forgot'):'auth/sign-in'),change?{current:data.current,next:data.next}:challenge?{code:data.code,...(data.method==='email'?{method:'email'}:{}),...(challenge===VIA_GOOGLE?{}:{challenge,remember:keep})}:{...data,remember});
   if(result.twoStep){setChallenge(result.challenge??'');setMethods(result.methods??null);return;}
   if(forgot){await accountReset;setError({tone:'info',text:result.message??'If an eligible account matches and mail delivery is available, a recovery email may arrive. Ask your admin for a new link if needed.'});}
   // Replace, not push: Back after signing in never returns to the sign-in page.
   else{router.replace(client?'/portal':!change&&result.mustChange?'/login?change=1':change&&!own?'/dashboard?welcome=1':after??'/');router.refresh();}
  }catch(e){
   // ORG: a Pulse account (a handle or e-mail with the account's own password) signs in at the shared address too, into
   // the organisation it used last: freelancers and clients who joined with an invitation have no company username.
   if(!client&&!change&&!challenge&&!forgot&&data.username&&data.password){
    try{const account=await post<{home?:string;kind?:string;mustChange?:boolean;twoStep?:boolean;challenge?:string;methods?:SecondStepMethods}>('auth/account-sign-in',{login:data.username,password:data.password,remember});
     // LOGIN-OTP: an authenticator on the account's seat: its code next, here (no "use your organisation's address").
     if(account.twoStep&&account.challenge){setChallenge(account.challenge);setMethods(account.methods??null);return;}
     router.replace(account.mustChange?'/login?change=1':after??(account.kind==='client'?'/client':account.home)??'/dashboard');router.refresh();return;}
    catch(err){
     // IDENTITY-SIGNIN (1841): this company has them under an e-mail that already has its own account: say what to do.
     if(err instanceof Error&&/already has its own account/.test(err.message)){setError({tone:'error',text:err.message});return;}
     /* otherwise the first answer stands */}
   }
   // The organisation's recovery may be off while the account's is on: the account's answer then stands.
   if(accountReset){const r=await accountReset as {message?:string}|null;if(r?.message){setError({tone:'info',text:r.message});return;}}
   setRefused(!client&&!change&&!challenge&&!forgot);
   setError({tone:'error',text:explain(e instanceof Error?e.message:'Could not sign in',data.username??'',caps,!client&&!change&&!challenge&&!forgot)});}finally{setBusy(false);}
 }
 const rules=[{ok:new TextEncoder().encode(next).length>=10,text:'At least 10 characters'},{ok:!!next&&next===again,text:'Both new passwords match'}];
 // The organisation's own brand record first (LAYOUT-SWEEP, per address), then the install's name (EST-655); none for a bare install.
 const company=orgBrand?organizationDisplayName(org?.name)??organizationDisplayName(companyName):undefined;
 const codeOffer=!change&&!challenge&&!forgot&&!client&&!framed;
 // LOGIN-VITALS: the plain sign-in (no change, second step, recovery or app consent): title, fields and buttons only.
 const plain=!change&&!challenge&&!forgot&&!forApp;
 // LOGIN-VITALS: on the platform's own addresses people sign in with their e-mail (a username still works); a company's
 // staff on its own address often have a Pulse username.
 const fieldLabel=product==='Pulse'?'E-mail or username':'E-mail';
 const form=<form ref={formRef} onSubmit={submit} className={css.form} noValidate={false}>
  {/* eslint-disable-next-line @next/next/no-img-element -- the organisation's logo, served by the app */}
  {org?.logo&&!framed?<span className={css.orgLogo}><img className={css.orgLight} src={org.logo} alt={company}/><img className={css.orgDark} src={org.logoDark??org.logo} alt="" aria-hidden="true"/></span>:null}
  {/* LOGIN-VITALS (owner, 13 Nov 2026): the plain sign-in has no eyebrow and no paragraph: the title and the fields say it. */}
  {plain?null:<p className={css.kicker}>{change?(own?'Your account':'First sign-in'):challenge?'Two-step verification':forgot?(linkHelp?'Sign-in link':usernameHelp?'Forgot username':'Forgot password'):'Sign in with Pulse'}</p>}
  <h1 className={css.title}>{change?(own?'Change your password':'Set your own password'):challenge?'Verify it’s you':forgot?(linkHelp?'Sign in with a link':usernameHelp?'Find your username':'Reset your password'):(client?'Client sign-in':forApp?`Sign in to continue to ${forApp}`:'Sign in')}</h1>
  {plain?null:<p className={css.sub}>{change?(own?'Other devices where you are signed in are signed out when you change it.':'Choose a unique password before continuing to your workspace.'):challenge?'Finish with your second step: your passkey, a code from your authenticator or email, or a backup code. HR can reset two-step after checking your identity.':forgot?(linkHelp?'Clients and freelancers: type your @handle or the e-mail of your Pulse account. We e-mail you a link that signs you in once, within 15 minutes.':usernameHelp?'Enter your delivery email. We will email your username if it matches an eligible account.':'Enter your username, @handle or e-mail for a private, one-time reset link.'):accessGate?'Team: your Pulse username and password, or your company Google account. Clients and freelancers: your @handle or e-mail and the password you chose.':'Use your Pulse username or @handle and your password.'}</p>}
  {change?<>
   <PasswordField label="Current password" name="current" required autoComplete="current-password" />
   <PasswordField label="New password" name="next" maxLength={72} required autoComplete="new-password" value={next} onChange={(e)=>setNext(e.target.value)} />
   <PasswordField label="New password again" name="again" maxLength={72} required autoComplete="new-password" value={again} onChange={(e)=>setAgain(e.target.value)} />
   <ul className={css.rules}>{rules.map((r)=><li key={r.text} data-ok={r.ok?'':undefined}>{r.ok?<Check size={14} aria-hidden="true"/>:<Circle size={14} aria-hidden="true"/>}{r.text}</li>)}</ul>
  </>:challenge?<SecondStep challenge={challenge} methods={challenge===VIA_GOOGLE?null:methods} onSignedIn={()=>{router.replace(client?'/portal':after??'/');router.refresh();}} onError={(text)=>setError({tone:'error',text})}/>:<>
   {!forgot&&notice?<p className={css.status} data-tone={notice.tone} role={notice.tone==='error'?'alert':'status'}>{notice.text}</p>:null}
   {/* GOOGLE-ONE-CLICK: Google first, one click, with any Google account whose e-mail Pulse has for you. */}
   <label className={css.field}><span id="login-username-label">{forgot?(linkHelp?'@handle or e-mail':usernameHelp?'Delivery email':'Username, @handle or e-mail'):fieldLabel}</span><input key={`u${prefill.n}`} defaultValue={forgot?undefined:prefill.username} name="username" aria-labelledby="login-username-label" required autoComplete="username" maxLength={254} placeholder={forgot&&(usernameHelp||linkHelp)?"user-aa260886@gmail.com":"you@company.com"} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
    {/* LOGIN-VITALS: the long username hint left the page (the work e-mail on file signs in too, SIGNIN-OFFICE); a wrong
        try still says exactly what to check (explain()). */}</label>
   {!forgot?<><div onKeyUp={(ev)=>setCaps(ev.getModifierState?.('CapsLock')===true)} onKeyDown={(ev)=>setCaps(ev.getModifierState?.('CapsLock')===true)}><PasswordField label="Password" name="password" required autoComplete="current-password" /></div>
   {caps?<small className={css.hint} role="status">Caps Lock is on. Passwords care about capital letters.</small>:null}
   {/* STAFF-UX: the way out of a forgotten password sits right under the password, not below the button. LOGIN-VITALS:
       on one row with "Keep me signed in", so the page fits a phone's screen. */}
   {/* LOGIN-VITALS (owner's list for the page): no "Keep me signed in" box; the choice made on the code page (on by
       default: 30 days on this device) carries over, and Sign out ends it on a shared computer. */}
   <input type="hidden" name="remember" value={prefill.remember?'on':''}/>
   <button type="button" className={`${css.link} ${css.forgotInline}`} onClick={toggleForgot}>Forgot your password?</button></>:null}
  </>}
  {/* ONBOARD: people who sign in with Google have no Pulse password to reset. */}
  {forgot&&!usernameHelp&&!linkHelp&&google&&!client?<p className={css.status} data-tone="info">Sign in with Google? Your password is your Google password: reset it at Google, or ask the admin. This form resets a Pulse password.</p>:null}
  {error?<p className={css.status} data-tone={error.tone} role={error.tone==='error'?'alert':'status'}>{say(error.text)}</p>:null}
  {/* SIGNIN-CODE: a wrong or locked password: the way in with the work e-mail, right under the refusal. */}
  {codeOffer&&refused&&error?<button type="button" className={css.secondary} onClick={openCode}>Locked out? E-mail me a sign-in code</button>:null}
  <button className={css.primary} disabled={busy}>{busy?'Working…':change?(own?'Change password':'Set password and continue'):challenge?'Verify and sign in':forgot?(linkHelp?'E-mail me a sign-in link':usernameHelp?'Email my username':'Send reset link'):'Sign in'}</button>
  {codeOffer&&!(refused&&error)?<><div className={css.or}>or</div><button type="button" className={css.secondary} onClick={openCode}>Send me a code instead</button></>:null}
  {extras()}
 </form>;
 // The ways in besides the form's own (the same on the code and the password pages); hoisted, read when a page is drawn.
 function extras(){return <>
  {!change&&!challenge&&!forgot?<Providers list={[...(google?['google' as const]:[]),...others]} next={after}/>:null}
  {!change&&!forgot&&accessGate&&!google?<><button type="button" className={css.secondary} onClick={async()=>{await post('auth/sign-out',{}).catch(()=>{});router.push('/dashboard');router.refresh();}}>Continue with company Google account</button></>:null}
  {!change&&(forgot||challenge)?<button type="button" className={css.link} onClick={toggleForgot}>{forgot?'Back to sign in':'Forgot your password?'}</button>:null}
  {/* SIGNED-OUT-SHELL (phone QA): one "New to Pulse?" line. Sign-up (open on Pulse's shared address) makes your account and,
      if you name one, your company; where it is closed, a company's owner starts with Start your company on Pulse. */}
  {(forApp||signup)&&!change&&!challenge&&!forgot?<p className={css.foot}>New to {product}? <a href={after?`/signup?${new URLSearchParams({next:after})}`:'/signup'}>Create your account</a></p>
   :startCompany&&!change&&!challenge&&!forgot&&!client&&!framed?<p className={css.foot}>New to {product}? <a href="/start">Start your company on {product}</a></p>:null}
  {/* FIX-SHELL (owner, 10 Nov 2026) made the other ways in one tidy list; LOGIN-VITALS (owner, 13 Nov 2026: "a long page
      you have to scroll, even on a phone") folds it behind one quiet "Trouble signing in?" on the sign-in page, so the
      page fits one phone screen. Recovery (Forgot your password) keeps it open: that is where people look for help.
      No aria-controls: the shell's menu helper (menu-keys.ts) would size the list like a dropdown and clip it. */}
  {!change&&!challenge&&!forgot&&!client&&!framed?<button type="button" className={`${css.link} ${css.helpToggle}`} aria-expanded={help} onClick={()=>setHelp(!help)}>Trouble signing in?<ChevronDown size={16} aria-hidden="true"/></button>:null}
  {!change&&!challenge&&(forgot||help)?<div id="login-more-ways" className={css.moreWays} role="group" aria-label={forgot?'Other ways in':'Trouble signing in?'}>
  {/* Three plain answers per page: the password page already shows Forgot your password?, the code page needs no username. */}
  {forgot||password?null:<button type="button" className={css.link} onClick={toggleForgot}><KeyRound size={16} aria-hidden="true"/>Forgot your password?</button>}
  {forgot||password?<button type="button" className={css.link} onClick={()=>{if(!forgot)history.pushState({...history.state,pulseForgot:true},'');setForgot(true);setLinkHelp(false);setUsernameHelp(!usernameHelp||linkHelp);setError(null);}}><UserRound size={16} aria-hidden="true"/>{usernameHelp&&!linkHelp?'Forgot your password?':'Forgot your username?'}</button>:null}
  {/* PORTAL-2: the account's sign-in link, in recovery only (on the sign-in page "Send me a code" takes an @handle too). */}
  {forgot&&!client&&!framed&&!linkHelp?<button type="button" className={css.link} onClick={()=>{setUsernameHelp(false);setLinkHelp(true);setError(null);}}>Freelancer or client? E-mail me a sign-in link</button>:null}
  {/* SIGNIN-CODE (19 Nov 2026): HR's one-time sign-in link has an 8-character code for a phone app the link cannot open
      (on an iPhone a link opens Safari, not the installed app): /login/link without a link takes it with the username. */}
  {!client&&!forgot?<a className={css.link} href="/login/link" data-link-code-entry=""><Ticket size={16} aria-hidden="true"/>Have a sign-in code?</a>:null}
  {/* MOBILE-READY: a phone signs in with a one-time code an admin makes on a signed-in device (Settings → Devices). */}
  {!client&&!forgot?<a className={css.link} href="/login/device"><QrCode size={16} aria-hidden="true"/>Sign in with a QR code from your phone</a>:null}
  {forgot&&!client&&!framed&&!forApp?<a className={css.link} href="/login/how">How signing in works</a>:null}
  {/* QA-BULK: signed out on a phone browser there is no Ctrl+B and no shake; the reporter needs a visible way in. */}
  <button type="button" className={css.link} onClick={()=>openBugReport({title:'Signing in'})}><MessageCircleWarning size={16} aria-hidden="true"/>Report a problem</button>
  </div>:null}
 </>;}
 // IDENTITY-SIGNIN: the e-mailed code first, wherever a person signs in (not the client portal or the framed change form).
 const codeFirst=!password&&!change&&!challenge&&!forgot&&!client&&!framed;
 const codeTop=<>
  {/* eslint-disable-next-line @next/next/no-img-element -- the organisation's logo, served by the app */}
  {org?.logo?<span className={css.orgLogo}><img className={css.orgLight} src={org.logo} alt={company}/><img className={css.orgDark} src={org.logoDark??org.logo} alt="" aria-hidden="true"/></span>:null}
  {notice?<p className={css.status} data-tone={notice.tone} role={notice.tone==='error'?'alert':'status'}>{notice.text}</p>:null}
 </>;
 if(framed)return <div className={css.framed}>{form}</div>;
 return <div className={css.screen}>
  <section className={css.brand} aria-label={product}>
   <div className={css.wordmark}><Mark icon={productIcon}/><span><b>{product}</b>{company?<small>for {company}</small>:null}</span></div>
   <div className={css.pitch}>
    <h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2>
   </div>
   <svg className={css.beat} viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="login-beat" x1="0" x2="1"><stop offset="0" stopColor="#a78bfa" stopOpacity="0.2"/><stop offset="0.5" stopColor="#c4b5fd"/><stop offset="1" stopColor="#f0abfc" stopOpacity="0.4"/></linearGradient></defs><path d="M0 70 H150 L175 70 L195 30 L222 108 L248 14 L272 82 L290 70 H600"/></svg>
  </section>
  <div className={css.side}>{codeFirst&&!waiting?<CodeSignIn key={`c${prefill.n}`} username={prefill.username} remember={prefill.remember} onPassword={openPassword}
   kicker={forApp?'Sign in with Pulse':undefined} title={forApp?`Sign in to continue to ${forApp}`:'Sign in'}
   before={codeTop} after={extras()} label={fieldLabel}
   onSignedIn={(r,remember)=>{setKeep(remember);if(r.twoStep){setChallenge(r.challenge??'');setMethods(r.methods??null);return;}router.replace(r.mustChange?'/login?change=1':after??(r.kind==='client'?'/client':r.home)??'/');router.refresh();}}/>:waiting?<div className={css.form} role="status"><h1 className={css.title}>Signing you in…</h1><p className={css.sub}>Checking your Google sign-in. {product} opens where you were going in a moment.</p></div>:form}</div>
 </div>;
}
