'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../../records';
import {organizationDisplayName} from '../../lib/branding-name';
import css from '../login.module.css';
import {PasswordField} from '../password-field';

/** ONBOARD: an invitation to a company Google address is accepted with Continue with Google; the link stays in this tab
 *  (sessionStorage, like /join) so a wrong Google account can try again without the e-mail. */
const KEY='pulse.invite';
type Peek={invite:boolean;google:boolean;email?:string;ticket?:string};
const GOOGLE:Record<string,string>={
 invite_email_mismatch:'That Google account is not the address this invitation is for. Press Continue with Google again and choose it.',
 domain_not_allowed:'That Google account is not on your company’s domain. Press Continue with Google again and choose your company account.',
 already_linked:'That Google account is already linked to another Pulse account. Ask HR to check.',
 account_disabled:'Sign-in is turned off for this account. Ask HR.',
 invite_used:'This invitation was already used, replaced or has expired. Try Sign in with Google, or ask HR for a fresh link.',
 state_invalid:'That Google attempt expired. Press Continue with Google again.',
 provider_error:'Google sign-in did not finish. Press Continue with Google again, or set a Pulse password below.',
};
export function SetPasswordForm({client=false,companyName="Pulse"}:{client?:boolean;companyName?:string}) {
 const router=useRouter(),token=useRef('');const [error,setError]=useState(''),[busy,setBusy]=useState(false),[twoStep,setTwoStep]=useState(false),[password,setPassword]=useState('');
 const [peek,setPeek]=useState<Peek|null>(null),[usePassword,setUsePassword]=useState(false);
 useEffect(()=>{
  const ask=(t:string)=>{if(client||!/^[A-Za-z0-9_-]{43}$/.test(t))return;void post<Peek>('auth/invite-peek',{token:t}).then(p=>{if(token.current===t)setPeek(p);}).catch(()=>{});};
  const capture=()=>{
   let t=window.location.hash.slice(1);
   if(t){window.history.replaceState(null,'',window.location.pathname+window.location.search);try{if(!client)window.sessionStorage.setItem(KEY,t);}catch{/* private window */}}
   else{try{t=client?'':window.sessionStorage.getItem(KEY)??'';}catch{t='';}}
   if(!t)return;token.current=t;setError('');setTwoStep(false);setPeek(null);ask(t);
  };
  capture();
  // Back from Google with a reason: say what happened above the same choice.
  const reason=new URLSearchParams(window.location.search).get('google');
  if(reason)void Promise.resolve().then(()=>setError(GOOGLE[reason]??GOOGLE.provider_error));
  window.addEventListener('hashchange',capture);return()=>window.removeEventListener('hashchange',capture);
 },[client]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');const data=new FormData(event.currentTarget);
  if(data.get('password')!==data.get('again')){setError('The two passwords are not the same.');return;}
  setBusy(true);try{const result=await post<{twoStep?:boolean}>((client?'portal/':'')+'auth/set-password',{token:token.current,password:data.get('password'),code:data.get('code')});if(result.twoStep){setTwoStep(true);setError('Enter an authenticator or recovery code to finish.');return;}token.current='';try{window.sessionStorage.removeItem(KEY);}catch{/* */}router.push(client?'/portal':'/dashboard?welcome=1');router.refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 const bytes=new TextEncoder().encode(password).length;
 const kicker=[organizationDisplayName(companyName),client?'Client portal':undefined].filter((label):label is string=>Boolean(label)).join(' · ');
 const google=!!peek?.google&&!!peek.ticket&&!usePassword;
 const brand=<section className={css.brand} aria-label="Pulse"><div className={css.wordmark}><b>Pulse</b></div><h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2></section>;
 if(google)return <div className={css.screen}>{brand}<div className={css.side}><div className={css.form}>
  {kicker?<p className={css.kicker}>{kicker}</p>:null}<h1 className={css.title}>Welcome to Pulse</h1>
  <p className={css.sub}>Your company Google account is your Pulse login. No new password to remember.</p>
  <ol className={css.steps}><li>Press <b>Continue with Google</b>.</li><li>Choose <b>{peek!.email}</b> (Google may ask for its password).</li><li>You are in Pulse. Next time, the same button on Sign in.</li></ol>
  {error?<p role="alert" className={css.status} data-tone="error">{error}</p>:null}
  <a className={css.primary} href={`/api/v0/auth/google/start?mode=invite&ticket=${encodeURIComponent(peek!.ticket!)}`}>Continue with Google</a>
  <p className={css.foot}>as {peek!.email}</p>
  <button type="button" className={css.link} onClick={()=>{setUsePassword(true);setError('');}}>I&apos;d rather use a Pulse password</button>
  <a className={css.link} href="/login/how">How you get into Pulse</a>
  <p className={css.foot}>Forgot your Google password? Reset it at Google, or ask the admin. Keep this link private.</p>
 </div></div></div>;
 return <div className={css.screen}>{brand}<div className={css.side}><form className={css.form} onSubmit={submit}>
 {kicker?<p className={css.kicker}>{kicker}</p>:null}<h1 className={css.title}>Set your Pulse password</h1><p className={css.sub}>Choose a unique passphrase. Reset links expire after 60 minutes; invitations after seven days. Each works once.</p>
 <PasswordField label="New password" name="password" required maxLength={72} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/>
 <PasswordField label="New password again" name="again" required maxLength={72} autoComplete="new-password"/>
 <p className={css.foot}>{bytes<10?'Use at least 10 bytes; several unrelated words work well.':bytes>72?'This password exceeds 72 bytes.':password.length<16?'Valid length. A longer, unique passphrase is stronger.':'Good length. Avoid common phrases and reused passwords.'}</p>
 {twoStep?<label className={css.field}>Authenticator or recovery code<input name="code" required autoComplete="one-time-code" maxLength={40}/></label>:null}
 {error?<p role="alert" className={css.status} data-tone="error">{error}</p>:null}<button className={css.primary} disabled={busy||bytes>72}>{busy?'Setting password…':'Set password and start'}</button>
 {peek?.google&&usePassword?<button type="button" className={css.link} onClick={()=>{setUsePassword(false);setError('');}}>Use Continue with Google instead</button>:<a className={css.link} href={client?'/portal/login':'/login'}>Request a fresh link</a>}
 <p className={css.foot}>Keep the link private. HR can help if it has expired.</p>
 </form></div></div>;
}
