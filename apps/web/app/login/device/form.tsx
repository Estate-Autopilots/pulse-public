'use client';
// MOBILE-READY (owner, 27 Oct 2026): "Sign in with a code from another device". An admin made a one-time code on a
// signed-in device (Settings → Devices → Add a test device): this phone types its 6 digits, or opens its QR link, whose
// token sits in the fragment (it never reaches a server log). Nothing happens until Sign in is pressed. Two-step accounts
// still give their authenticator code.
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../../records';
import css from '../login.module.css';
export function DeviceSignIn(){
 const router=useRouter(),token=useRef('');const [error,setError]=useState(''),[busy,setBusy]=useState(false),[twoStep,setTwoStep]=useState(false),[scanned,setScanned]=useState(false),[code,setCode]=useState('');
 useEffect(()=>{const capture=()=>{const h=window.location.hash.slice(1);if(!/^[A-Za-z0-9_-]{43}$/.test(h))return;token.current=h;window.history.replaceState(null,'',window.location.pathname);setError('');setTwoStep(false);setScanned(true);};capture();window.addEventListener('hashchange',capture);return()=>window.removeEventListener('hashchange',capture);},[]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');const data=new FormData(event.currentTarget);setBusy(true);
  try{const r=await post<{twoStep?:boolean;failed?:boolean}>('auth/device-sign-in',scanned?{token:token.current,otp:String(data.get('otp')??'')}:{code,otp:String(data.get('otp')??'')});
   if(r.twoStep){setTwoStep(true);if(r.failed)setError('That code did not work. Use a fresh code from your authenticator, or a recovery code.');return;}
   token.current='';router.replace('/');router.refresh();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className={css.screen}><section className={css.brand} aria-label="Pulse"><div className={css.wordmark}><b>Pulse</b></div><h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2></section><div className={css.side}><form className={css.form} onSubmit={submit}>
  <p className={css.kicker}>Sign in this device</p><h1 className={css.title}>Sign in with a code</h1>
  <p className={css.sub}>{scanned?'You scanned a sign-in code. Press Sign in to sign this device in as the admin who made it.':'On a device where you are signed in, open Settings → Devices → Add a test device. Type the 6-digit code it shows, or scan its QR code with this phone’s camera.'}</p>
  {scanned?null:<label className={css.field}>6-digit code<input name="code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} required pattern="\d{6}" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} autoFocus data-device-code=""/></label>}
  {twoStep?<label className={css.field}>Authenticator or recovery code<input name="otp" required autoComplete="one-time-code" inputMode="numeric" maxLength={40} autoFocus/></label>:null}
  {error?<p role="alert" className={css.status} data-tone="error">{error}</p>:null}
  <button className={css.primary} disabled={busy||(!scanned&&code.length!==6)}>{busy?'Signing in…':twoStep?'Verify and sign in':'Sign in'}</button>
  <a className={css.link} href="/login">Sign in with your password instead</a>
  <p className={css.foot}>Codes work once, for 10 minutes. Every sign-in is recorded and this device can be signed out from the devices list.</p>
 </form></div></div>;
}
