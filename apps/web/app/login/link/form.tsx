'use client';
// PEOPLE-CONTACTS: a one-time sign-in link HR sent (Account access → Send sign-in link). The token is in the fragment,
// so it never reaches a server log; nothing happens until the person presses Sign in (mail scanners that open links
// therefore cannot use it up). Two-step accounts still give their code.
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../../records';
import css from '../login.module.css';
export function LinkSignIn(){
 const router=useRouter(),token=useRef('');const [error,setError]=useState(''),[busy,setBusy]=useState(false),[twoStep,setTwoStep]=useState(false),[ready,setReady]=useState(false);
 useEffect(()=>{const capture=()=>{if(!window.location.hash)return;token.current=window.location.hash.slice(1);window.history.replaceState(null,'',window.location.pathname);setError('');setTwoStep(false);setReady(true);};capture();window.addEventListener('hashchange',capture);return()=>window.removeEventListener('hashchange',capture);},[]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');const data=new FormData(event.currentTarget);setBusy(true);
  try{const r=await post<{twoStep?:boolean;failed?:boolean}>('auth/link-sign-in',{token:token.current,code:data.get('code')??''});if(r.twoStep){setTwoStep(true);if(r.failed)setError('That code did not work. Use a fresh code from your authenticator, or a recovery code.');return;}token.current='';router.push('/dashboard');router.refresh();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className={css.screen}><section className={css.brand} aria-label="Pulse"><div className={css.wordmark}><b>Pulse</b></div><h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2></section><div className={css.side}><form className={css.form} onSubmit={submit}>
  <p className={css.kicker}>One-time sign-in</p><h1 className={css.title}>Sign in to Pulse</h1>
  <p className={css.sub}>{ready?'HR sent you this private link. It works once, within 15 minutes of being sent.':'Open the link from your e-mail on this device. It works once, within 15 minutes.'}</p>
  {twoStep?<label className={css.field}>Authenticator or recovery code<input name="code" required autoComplete="one-time-code" inputMode="numeric" maxLength={40} autoFocus/></label>:null}
  {error?<p role="alert" className={css.status} data-tone="error">{error}</p>:null}
  <button className={css.primary} disabled={busy||!ready}>{busy?'Signing in…':twoStep?'Verify and sign in':'Sign in'}</button>
  <a className={css.link} href="/login">Sign in with your password instead</a>
  <p className={css.foot}>Didn’t ask for this? Close the page and tell HR. Keep the link private.</p>
 </form></div></div>;
}
