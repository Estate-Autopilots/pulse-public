'use client';
// SIGNIN-CODE (owner, 2 Nov 2026: "anyone with access to their work e-mail gets in in a few clicks"): sign in with a
// 6-digit code e-mailed to the e-mail on file, instead of the password. Two steps on one page: who you are, then the
// code. A locked password does not stop it, and signing in this way ends the lock. ACCOUNT-CODE (1465): a Pulse
// account's @handle or e-mail works here too (the server decides: staff of this organisation first, then the account).
// IDENTITY-SIGNIN (owner, 7 Nov 2026): this is the sign-in page's first way in; the password is the second
// ("Use my password instead"). "Keep me signed in" starts ticked: 30 days on this device.
import {useEffect,useState,type FormEvent,type ReactNode} from 'react';
import {post} from '../records';
import css from './login.module.css';
import type {SecondStepMethods} from './second-step';

type Signed={twoStep?:boolean;challenge?:string;methods?:SecondStepMethods;mustChange?:boolean;home?:string;kind?:string};

/** ACCOUNT-META: the address typed, masked (j••••@gmail.com); nothing for a username (we never say which e-mail an account uses). */
const maskTyped=(typed:string)=>{const t=typed.trim().toLowerCase();const at=t.indexOf('@');return at>0&&t.indexOf('.',at)>at+1?`${t[0]}••••${t.slice(at)}`:'';};
/** ACCOUNT-META: what the page says once a code was asked for. The same words whether or not the address has an account. */
const sentLine=(typed:string)=>maskTyped(typed)?'If this e-mail has an account, a 6-digit code is on its way to it. It can take a minute.':'If this username has an account, a 6-digit code is on its way to the e-mail it signs in with.';
const WAIT=60;


/** `onSignedIn` gets the answer (a session the proxy keeps as the cookie, or a second step still to do) and the remember
 *  choice; `onPassword` switches to the password with what was typed. `before`/`after` frame the form on the sign-in page.
 *  LOGIN-VITALS: no eyebrow and no paragraph unless the page passes one; the title and the field say what to do. */
export function CodeSignIn({username:initial='',remember:initialRemember=true,onSignedIn,onPassword,kicker,title='Sign in',sub,before,after,label='E-mail or username'}:{
 username?:string;remember?:boolean;onSignedIn:(r:Signed,remember:boolean)=>void;onPassword:(username:string,remember:boolean)=>void;
 kicker?:string;title?:string;sub?:string;before?:ReactNode;after?:ReactNode;label?:string}){
 const [username,setUsername]=useState(initial),[sent,setSent]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[remember]=useState(initialRemember),[wait,setWait]=useState(0);
 useEffect(()=>{if(wait<=0)return;const t=setTimeout(()=>setWait(w=>w-1),1000);return()=>clearTimeout(t);},[wait]);
 async function send(){
  setError('');setBusy(true);
  // ACCOUNT-META (owner, 15 Nov 2026: "show the address the code went to and resend timing"): the typed address, masked,
  // and a minute before the next code (the server's own ration: one a minute).
  try{await post<{message?:string}>('auth/sign-in-code',{username:username.trim()});setSent(sentLine(username));setWait(WAIT);}
  catch(e){setError(e instanceof Error?e.message:'The code could not be sent. Try again in a minute.');}finally{setBusy(false);}
 }
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();
  if(!username.trim()){setError('Type your username or e-mail.');return;}
  if(!sent){await send();return;}
  const code=String(new FormData(e.currentTarget).get('code')??'').replace(/\D/g,'');
  if(code.length!==6){setError('Type the 6 digits from the e-mail.');return;}
  setError('');setBusy(true);
  try{onSignedIn(await post<Signed>('auth/code-sign-in',{username:username.trim(),code,remember}),remember);}
  catch(err){setError(err instanceof Error?err.message:'That code did not work. Ask for a new one.');}finally{setBusy(false);}
 }
 return <form onSubmit={submit} className={css.form}>
  {kicker?<p className={css.kicker}>{kicker}</p>:null}
  <h1 className={css.title}>{sent?'Check your e-mail':title}</h1>
  {sent||sub?<p className={css.sub}>{sent||sub}</p>:null}
  {sent?null:before}
  {sent?<p className={css.sub} data-code-for>Code for <b>{maskTyped(username)||username.trim()}</b> · <button type="button" className={css.link} onClick={()=>{setSent('');setError('');setWait(0);}}>Change</button></p>
  :<label className={css.field}><span id="code-username-label">{label}</span>
   <input name="username" aria-labelledby="code-username-label" required autoComplete="username" maxLength={254} placeholder="you@company.com" autoCapitalize="none" autoCorrect="off" spellCheck={false}
    value={username} onChange={(ev)=>setUsername(ev.target.value)}/></label>}
  {sent?<>
   <label className={css.field}><span id="code-label">6-digit code</span>
    <input name="code" aria-labelledby="code-label" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]*" maxLength={7} placeholder="6 digits"/></label>
  </>:null}
  {/* LOGIN-VITALS (owner's list for the page): no "Keep me signed in" box; sign-ins here are kept (30 days on this
      device, as the box's default was), and Sign out ends one on a shared computer. */}
  {error?<p className={css.status} data-tone="error" role="alert">{error}</p>:null}
  <button className={css.primary} disabled={busy}>{busy?'Working…':sent?'Sign in':'Send me a code'}</button>
  {sent?<button type="button" className={css.link} disabled={busy||wait>0} onClick={()=>void send()}>{wait>0?`Send a new code in ${wait} s`:'Send a new code'}</button>:null}
  {/* LOGIN-VITALS: "or" right under the main button: the password and the providers below it are the other ways. */}
  {sent?null:<div className={css.or}>or</div>}
  <button type="button" className={css.secondary} onClick={()=>onPassword(username.trim(),remember)}>Use my password instead</button>
  {sent?<p className={css.sub} data-code-help role="status">Not getting it? Check spam.</p>:null}
  {sent?null:after}
 </form>;
}
