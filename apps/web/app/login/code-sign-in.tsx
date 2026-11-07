'use client';
// SIGNIN-CODE (owner, 2 Nov 2026: "anyone with access to their work e-mail gets in in a few clicks"): sign in with a
// 6-digit code e-mailed to the work e-mail on file, instead of the password. Two steps on one page: who you are, then
// the code. A locked password does not stop it, and signing in this way ends the lock. ACCOUNT-CODE (1465): a Pulse
// account's @handle or e-mail works here too (the server decides: staff of this organisation first, then the account).
import {useState,type FormEvent} from 'react';
import {post} from '../records';
import css from './login.module.css';
import type {SecondStepMethods} from './second-step';

type Signed={twoStep?:boolean;challenge?:string;methods?:SecondStepMethods;mustChange?:boolean;home?:string;kind?:string};

/** `onSignedIn` gets the answer: a session (the proxy keeps it as the cookie) or a second step still to do. */
export function CodeSignIn({username:initial='',remember:initialRemember=false,onSignedIn,onBack}:{username?:string;remember?:boolean;onSignedIn:(r:Signed)=>void;onBack:()=>void}){
 const [username,setUsername]=useState(initial),[sent,setSent]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[remember,setRemember]=useState(initialRemember);
 async function send(){
  setError('');setBusy(true);
  try{const r=await post<{message?:string}>('auth/sign-in-code',{username:username.trim()});setSent(r.message??'If that username or e-mail belongs to an active Pulse account, a code is on its way to the e-mail on file.');}
  catch(e){setError(e instanceof Error?e.message:'The code could not be sent. Try again in a minute.');}finally{setBusy(false);}
 }
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();
  if(!sent){await send();return;}
  const code=String(new FormData(e.currentTarget).get('code')??'').replace(/\D/g,'');
  if(code.length!==6){setError('Type the 6 digits from the e-mail.');return;}
  setError('');setBusy(true);
  try{onSignedIn(await post<Signed>('auth/code-sign-in',{username:username.trim(),code,remember}));}
  catch(err){setError(err instanceof Error?err.message:'That code did not work. Ask for a new one.');}finally{setBusy(false);}
 }
 return <form onSubmit={submit} className={css.form}>
  <p className={css.kicker}>Sign-in code</p>
  <h1 className={css.title}>{sent?'Check your e-mail':'E-mail me a sign-in code'}</h1>
  <p className={css.sub}>{sent?'Type the 6-digit code from the e-mail. No password needed.':'No password needed. Type your username, @handle or e-mail and we e-mail a 6-digit code to the e-mail Pulse has for you. It also works when your password is locked.'}</p>
  <label className={css.field}><span id="code-username-label">Username, @handle or e-mail</span>
   <input name="username" aria-labelledby="code-username-label" required autoComplete="username" maxLength={254} placeholder="firstname.lastname" autoCapitalize="none" autoCorrect="off" spellCheck={false}
    value={username} readOnly={!!sent} onChange={(ev)=>setUsername(ev.target.value)}/></label>
  {sent?<>
   <p className={css.status} data-tone="info" role="status">{sent}</p>
   <label className={css.field}><span id="code-label">6-digit code</span>
    <input name="code" aria-labelledby="code-label" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]*" maxLength={7} placeholder="123456"/></label>
  </>:null}
  <label className={css.foot}><input type="checkbox" name="remember" checked={remember} onChange={(ev)=>setRemember(ev.target.checked)}/> Keep me signed in on this device (30 days)</label>
  {error?<p className={css.status} data-tone="error" role="alert">{error}</p>:null}
  <button className={css.primary} disabled={busy||!username.trim()}>{busy?'Working…':sent?'Sign in':'E-mail me a code'}</button>
  {sent?<button type="button" className={css.link} disabled={busy} onClick={()=>void send()}>Send a new code</button>:null}
  {sent?<button type="button" className={css.link} onClick={()=>{setSent('');setError('');}}>Use a different username</button>:null}
  <button type="button" className={css.link} onClick={onBack}>Back to sign in with a password</button>
 </form>;
}
