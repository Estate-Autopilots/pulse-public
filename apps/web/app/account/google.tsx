'use client';
// EST-1398: Account → Google (contract EST-1392 §3). Link Google is a full navigation to the API, which comes back here
// with ?google=linked or ?google=<reason>. Only the Google email and dates reach the page, never the subject or tokens.
import {useState} from 'react';
import {authResponse} from './http';
import {styles} from '../ui';
import css from './account.module.css';

export type GoogleLink={email:string;linkedAt:string;lastUsedAt:string|null}|null;
export const LINK_URL='/api/v0/auth/google/start?mode=link&next=/account';
const RESULTS:Record<string,string>={
 linked:'Google account linked. You can now use Continue with Google on the sign-in page.',
 domain_not_allowed:'That Google account isn’t in one of your organisation’s Workspace domains. Link Google again and choose your company account, or ask an admin to add the domain in Settings → Sign-in.',
 already_linked:'That Google account is already linked to a Pulse account, or you already have one linked. Unlink the old one first, or ask an admin.',
 account_disabled:'Your Pulse account can’t link Google right now. Sign in again with your Pulse password and retry; if it keeps happening, ask HR.',
 state_invalid:'The linking attempt expired or started in another browser. Link Google again from this page.',
 provider_error:'Google couldn’t confirm the link, or Google sign-in is switched off. Link Google again and finish within a few minutes; if it keeps failing, ask an admin to check Settings → Sign-in.',
};
/** A ?google= result from the API in plain words; unknown values get a generic retry line. */
export const googleResult=(code:string)=>RESULTS[code]??'Google didn’t link your account. Link Google again from this page.';
const day=(at:string)=>new Date(at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});

export function GoogleAccount({link,onChange}:{link:GoogleLink;onChange:(message:string,error?:boolean)=>Promise<void>}){
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false);
 async function unlink(){setBusy(true);try{const {response:r,data:d}=await authResponse('/api/v0/auth/google/unlink',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!r.ok)throw new Error(r.status===403&&d?.error?.trim()==='Use your browser account session'?'Sign in with your Pulse password, then unlink Google.':d?.error?.trim()||'Could not unlink Google. Try again.');setConfirm(false);await onChange('Google unlinked. Sign in with your Pulse password from now on.');}catch(e){await onChange((e as Error).message,true);}finally{setBusy(false);}}
 return <section className={css.box}><h2>Google</h2>
  {link?<>
   <p>Linked to <b className={css.address}>{link.email}</b> since {day(link.linkedAt)} · {link.lastUsedAt?`last used ${day(link.lastUsedAt)}`:'not used to sign in yet'}.</p>
   <p>Continue with Google signs you in to this Pulse account. Your Pulse password and two-step stay as they are.</p>
   {confirm?<div className={css.confirmation}><p>Unlinking ends every session you opened with Google. You can link again at any time.</p><div className={css.actions}><button className={styles.btn} disabled={busy} onClick={()=>void unlink()}>{busy?'Unlinking…':'Confirm unlink'}</button><button className={styles.btn} disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button></div></div>
   :<div className={css.actions}><button className={styles.btn} onClick={()=>setConfirm(true)}>Unlink Google</button></div>}
  </>:<>
   <p>Not linked. Link your company Google account once, then use <b>Continue with Google</b> on the sign-in page.</p>
   <p>Google signs you in only to a Pulse account that already exists and is linked here; it never creates one. Pulse keeps the Google email, never your Google password or tokens. Your Pulse password and two-step stay as they are.</p>
   <div className={css.actions}><a className={`${styles.btn} ${styles.btnPrimary}`} href={LINK_URL}>Link Google</a></div>
  </>}
 </section>;
}
