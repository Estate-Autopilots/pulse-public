'use client';
// MOBILE-READY (owner, 27 Oct 2026): Settings → Devices → Add a test device (admins). A one-time code for this admin's own
// account: 6 digits and a QR link, 10 minutes, once. The phone signs in from its sign-in page ("Sign in with a code from
// another device"); the new session is listed with your other devices and signs out there. Making a new code cancels
// the previous one.
import {useEffect,useState} from 'react';
import {post} from '../records';
import {styles} from '../ui';
import {qrSvg} from '../lib/qr.mjs';
type Code={id:string;code:string;url:string;expiresAt:string;warning:string};
export function TestDevice(){
 const [c,setC]=useState<Code|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[left,setLeft]=useState(0);
 useEffect(()=>{if(!c)return;const tick=()=>{const s=Math.max(0,Math.round((Date.parse(c.expiresAt)-Date.now())/1000));setLeft(s);if(!s)setC(null);};tick();const t=setInterval(tick,1000);return()=>clearInterval(t);},[c]);
 async function make(){setBusy(true);setError('');try{setC(await post<Code>('auth/device-code',{}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function cancel(){if(!c)return;setBusy(true);try{await post(`auth/device-code/${c.id}/cancel`,{});setC(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div data-test-device="" style={{display:'grid',gap:12,maxWidth:520}}>
  <p style={{margin:0}}>Sign a test phone in as you, without typing your password on it. On the phone, open Pulse, choose <b>Sign in with a code from another device</b>, then scan the QR code or type the 6 digits.</p>
  {c?<div style={{display:'grid',gap:12,justifyItems:'start'}}>
   <span style={{background:'#fff',padding:8,borderRadius:12,lineHeight:0}} dangerouslySetInnerHTML={{__html:qrSvg(c.url,184,'Scan with the test phone to sign it in')}}/>
   <p style={{margin:0,fontSize:32,fontWeight:700,letterSpacing:'0.2em',fontVariantNumeric:'tabular-nums'}} aria-label={`Code ${c.code.split('').join(' ')}`} data-device-code={c.code}>{c.code.slice(0,3)} {c.code.slice(3)}</p>
   <p style={{margin:0}} role="status">Works once, for {Math.floor(left/60)}:{String(left%60).padStart(2,'0')} more. {c.warning}</p>
   <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button className={styles.btn} disabled={busy} onClick={()=>void make()}>New code</button><button className={styles.btn} disabled={busy} onClick={()=>void cancel()}>Cancel this code</button></div>
  </div>:<div><button className={styles.btn} disabled={busy} onClick={()=>void make()}>{busy?'Making a code…':'Add a test device'}</button></div>}
  {error?<p role="alert" style={{margin:0}}>{error}</p>:null}
  <p style={{margin:0,opacity:.8}}>Signed-in phones appear in your devices list (Account → Security), where you can sign each one out.</p>
 </div>;
}
