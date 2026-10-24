'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../../records';
import {organizationDisplayName} from '../../lib/branding-name';
import css from '../login.module.css';
import {PasswordField} from '../password-field';
export function SetPasswordForm({client=false,companyName="Pulse"}:{client?:boolean;companyName?:string}) {
 const router=useRouter(),token=useRef('');const [error,setError]=useState(''),[busy,setBusy]=useState(false),[twoStep,setTwoStep]=useState(false),[password,setPassword]=useState('');
 useEffect(()=>{const capture=()=>{if(!window.location.hash)return;token.current=window.location.hash.slice(1);window.history.replaceState(null,'',window.location.pathname);setError('');setTwoStep(false);};capture();window.addEventListener('hashchange',capture);return()=>window.removeEventListener('hashchange',capture);},[]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError('');const data=new FormData(event.currentTarget);
  if(data.get('password')!==data.get('again')){setError('The two passwords are not the same.');return;}
  setBusy(true);try{const result=await post<{twoStep?:boolean}>((client?'portal/':'')+'auth/set-password',{token:token.current,password:data.get('password'),code:data.get('code')});if(result.twoStep){setTwoStep(true);setError('Enter an authenticator or recovery code to finish.');return;}token.current='';router.push(client?'/portal':'/dashboard?welcome=1');router.refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 const bytes=new TextEncoder().encode(password).length;
 const kicker=[organizationDisplayName(companyName),client?'Client portal':undefined].filter((label):label is string=>Boolean(label)).join(' · ');
 return <div className={css.screen}><section className={css.brand} aria-label="Pulse"><div className={css.wordmark}><b>Pulse</b></div><h2 className={css.headline}>Your team&apos;s day, <em>in one place.</em></h2></section><div className={css.side}><form className={css.form} onSubmit={submit}>
 {kicker?<p className={css.kicker}>{kicker}</p>:null}<h1 className={css.title}>Set your Pulse password</h1><p className={css.sub}>Choose a unique passphrase. Reset links expire after 60 minutes; invitations after seven days. Each works once.</p>
 <PasswordField label="New password" name="password" required maxLength={72} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/>
 <PasswordField label="New password again" name="again" required maxLength={72} autoComplete="new-password"/>
 <p className={css.foot}>{bytes<10?'Use at least 10 bytes; several unrelated words work well.':bytes>72?'This password exceeds 72 bytes.':password.length<16?'Valid length. A longer, unique passphrase is stronger.':'Good length. Avoid common phrases and reused passwords.'}</p>
 {twoStep?<label className={css.field}>Authenticator or recovery code<input name="code" required autoComplete="one-time-code" maxLength={40}/></label>:null}
 {error?<p role="alert" className={css.status} data-tone="error">{error}</p>:null}<button className={css.primary} disabled={busy||bytes>72}>{busy?'Setting password…':'Set password and start'}</button><a className={css.link} href={client?'/portal/login':'/login'}>Request a fresh link</a><p className={css.foot}>Keep the link private. HR can help if it has expired.</p>
 </form></div></div>;
}
