'use client';
// PEOPLE-CONTACTS: a one-time sign-in link HR sent (Account access → Send sign-in link). The token is in the fragment,
// so it never reaches a server log; nothing happens until the person presses Sign in (mail scanners that open links
// therefore cannot use it up). Two-step accounts still give their code.
// SIGNIN-CODE (19 Nov 2026): opened without a link ("Have a sign-in code?" on the sign-in page), the page takes the
// link's 8-character code with the username: a phone app the link cannot open (on an iPhone a link opens Safari, not
// the installed app) signs in the same way. Pasting the whole link, or its token, works too (lib/link-code.mjs).
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../../records';
import {linkSignInBody} from '../../lib/link-code.mjs';
import css from '../login.module.css';
export function LinkSignIn(){
 const router=useRouter(),token=useRef('');const [error,setError]=useState(''),[busy,setBusy]=useState(false),[twoStep,setTwoStep]=useState(false),[ready,setReady]=useState(false);
 const [username,setUsername]=useState(''),[entry,setEntry]=useState('');
 useEffect(()=>{const capture=()=>{if(!window.location.hash)return;token.current=window.location.hash.slice(1);window.history.replaceState(null,'',window.location.pathname);setError('');setTwoStep(false);setReady(true);};capture();window.addEventListener('hashchange',capture);return()=>window.removeEventListener('hashchange',capture);},[]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');const otp=String(new FormData(event.currentTarget).get('code')??'');
  const typed:{body?:Record<string,string>;error?:string}=ready?{body:{token:token.current,code:otp}}:linkSignInBody({username,entry,otp});
  if(!typed.body){setError(typed.error??'');return;}
  setBusy(true);
  try{const r=await post<{twoStep?:boolean;failed?:boolean}>('auth/link-sign-in',typed.body);if(r.twoStep){setTwoStep(true);if(r.failed)setError('That code did not work. Use a fresh code from your authenticator, or a recovery code.');return;}token.current='';router.push('/dashboard');router.refresh();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className={css.screen}><section className={css.brand} aria-label="Pulse"><div className={css.wordmark}><b>Pulse</b></div><h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2></section><div className={css.side}><form className={css.form} onSubmit={submit}>
  <p className={css.kicker}>One-time sign-in</p><h1 className={css.title}>{ready?'Sign in to Pulse':'Sign in with a code'}</h1>
  <p className={css.sub}>{ready?'HR sent you this private link. It works once, within 15 minutes of being sent.':'Type your username and the 8-character code from HR’s sign-in e-mail. Like the link, it works once, within 15 minutes.'}</p>
  {ready?null:<>
   <label className={css.field}><span id="link-username-label">Username</span>
    <input name="username" aria-labelledby="link-username-label" required autoComplete="username" maxLength={254} autoCapitalize="none" autoCorrect="off" spellCheck={false}
     value={username} readOnly={twoStep} onChange={e=>setUsername(e.target.value)} data-link-username=""/></label>
   <label className={css.field}><span id="link-code-label">Sign-in code</span>
    <input name="signInCode" aria-labelledby="link-code-label" required autoComplete="one-time-code" maxLength={400} placeholder="7KQM-2RXD" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
     value={entry} readOnly={twoStep} onChange={e=>setEntry(e.target.value)} data-link-code=""/></label>
  </>}
  {twoStep?<label className={css.field}>Authenticator or recovery code<input name="code" required autoComplete="one-time-code" inputMode="numeric" maxLength={40} autoFocus/></label>:null}
  {error?<p role="alert" className={css.status} data-tone="error">{error}</p>:null}
  <button className={css.primary} disabled={busy}>{busy?'Signing in…':twoStep?'Verify and sign in':'Sign in'}</button>
  <a className={css.link} href="/login">Sign in with your password instead</a>
  <p className={css.foot}>{ready?'Didn’t ask for this? Close the page and tell HR. Keep the link private.':'No code? Ask HR to send you a one-time sign-in link. Keep the code private: with your username it signs you in once.'}</p>
 </form></div></div>;
}
