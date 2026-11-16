'use client';
// TWO-STEP-FACTORS (owner, 30 Oct 2026: "getting in should be easy"): the second step of a sign-in offers what this
// person has set up: their passkey first, an e-mailed code, then the authenticator or a recovery code in the box.
import {useState,useSyncExternalStore} from 'react';
import css from './login.module.css';
import {emailSignInCode,passkeyMessage,passkeySecondStep,passkeysSupported} from '../lib/passkeys';

const noSubscription=()=>()=>{};
export type SecondStepMethods={authenticator?:boolean;passkey?:boolean;email?:boolean};

export function SecondStep({challenge,methods,onSignedIn,onError}:{challenge:string;methods:SecondStepMethods|null;onSignedIn:()=>void;onError:(text:string)=>void}){
 const [sent,setSent]=useState(''),[busy,setBusy]=useState(false),supported=useSyncExternalStore(noSubscription,passkeysSupported,()=>false);
 const passkey=!!methods?.passkey&&supported,email=!!methods?.email,authenticator=!methods||!!methods.authenticator;
 async function askPasskey(){setBusy(true);
  try{await passkeySecondStep(challenge);onSignedIn();}catch(e){onError(passkeyMessage(e,'The passkey wasn’t used. Try again, or use another way below.'));}finally{setBusy(false);}}
 async function sendCode(){setBusy(true);
  try{const r=await emailSignInCode(challenge);setSent(r.to?`A code is on its way to ${r.to}. It works once, for 10 minutes.`:'A code is on its way.');}
  catch(e){onError(e instanceof Error?e.message:'The code could not be sent.');}finally{setBusy(false);}}
 return <>
  {passkey?<button type="button" className={css.secondary} disabled={busy} onClick={()=>void askPasskey()}>Use your passkey</button>:null}
  {email?<button type="button" className={css.link} disabled={busy} onClick={()=>void sendCode()}>{sent?'Send a new code':'Email me a code'}</button>:null}
  {sent?<p className={css.status} role="status">{sent} <button type="button" className={css.link} onClick={()=>setSent('')}>Use a recovery code instead</button></p>:null}
  <input type="hidden" name="method" value={sent?'email':''}/>
  <label className={css.field}>{sent?'Code from your email':authenticator?'Authenticator or recovery code':passkey?'Or a recovery code':'Recovery code'}
   <input name="code" required={!passkey} autoComplete="one-time-code" autoCapitalize="none" maxLength={40}/></label>
 </>;
}
