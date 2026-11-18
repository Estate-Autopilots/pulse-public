'use client';
// EST-1398: Settings → Sign-in → Google over GoogleSignInSettings (contract EST-1392 §3). Admins only. Trust Google 2-step
// is off by default; changing it sends the admin's fresh Pulse 2-step code in X-Pulse-Two-Step, and PUT omits configured.
import {useEffect,useState} from 'react';
import {Lock,ServerOff,ShieldAlert} from 'lucide-react';
import {Toggle} from '../tasks/kit';
import {Empty,Panel,Skeleton,styles} from '../ui';
import css from './settings.module.css';
import {authResponse,RECONNECT} from '../account/http';

type Settings={configured:boolean;enabled:boolean;allowedDomains:string[];trustGoogle2Step:boolean;passwordSignIn:'on'|'off_for_linked'};
type Status='loading'|'ready'|'forbidden'|'error';
const DOMAIN=/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const TRUST_HELP='Only switch this on if 2-step verification is enforced for every user of these domains in Google Workspace.';
/** The API's save refusals with what to do next; any other message shows as it is. */
const REFUSED:Record<string,string>={
 'Fresh Pulse two-step required':'Enter a current code from your authenticator app to change Trust Google 2-step.',
 'Keep a password recovery path':'Someone is linked with a domain that isn’t in the list. Keep that domain, or let everyone keep their Pulse password.',
};
const parse=(text:string)=>[...new Set(text.toLowerCase().split(/[\s,]+/).filter(Boolean))];
async function read():Promise<{status:Status;data?:Settings;error?:string}>{
 try{const {response:r,data:d}=await authResponse<Settings>('/api/v0/admin/sign-in/google',{cache:'no-store'});
  return r.status===403?{status:'forbidden'}:r.ok?{status:'ready',data:d}:{status:'error',error:d?.error?.trim()||'Google sign-in settings are unavailable.'};}
 catch{return {status:'error',error:RECONNECT};}
}

export function GoogleSignIn({admin}:{admin:boolean}){
 const [saved,setSaved]=useState<Settings|null>(null),[draft,setDraft]=useState<Settings|null>(null),[domains,setDomains]=useState(''),[code,setCode]=useState('');
 const [status,setStatus]=useState<Status>(admin?'loading':'forbidden'),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const take=(d:Settings)=>{setSaved(d);setDraft(d);setDomains(d.allowedDomains.join(', '));setCode('');};
 const [attempt,setAttempt]=useState(0),reload=()=>{setStatus('loading');setError('');setAttempt(n=>n+1);};
 useEffect(()=>{
  if(!admin)return;let live=true;
  void read().then(r=>{if(!live)return;if(r.data){setSaved(r.data);setDraft(r.data);setDomains(r.data.allowedDomains.join(', '));setCode('');}setError(r.error??'');setStatus(r.status);});
  return ()=>{live=false;};
 },[admin,attempt]);
 const list=parse(domains),bad=list.find(d=>!DOMAIN.test(d)||d.length>253);
 const domainInvalid=bad?`“${bad}” is not a domain like example.com.`:list.length>10?'Up to 10 domains.':draft?.enabled&&!list.length?'Add at least one Workspace domain before switching Google on.':'';
 const passwordInvalid=draft?.passwordSignIn==='off_for_linked'&&!draft.enabled?'Switch on Continue with Google before linked people must use it.':'';
 const invalid=domainInvalid||passwordInvalid;
 const trustChanged=!!saved&&!!draft&&saved.trustGoogle2Step!==draft.trustGoogle2Step;
 const changed=!!saved&&!!draft&&(saved.enabled!==draft.enabled||saved.passwordSignIn!==draft.passwordSignIn||trustChanged||saved.allowedDomains.join()!==list.join());
 async function save(){
  if(!draft||invalid)return;setBusy(true);setMessage('');setError('');
  try{const {enabled,trustGoogle2Step,passwordSignIn}=draft;
   const {response:r,data:d}=await authResponse<Settings>('/api/v0/admin/sign-in/google',{method:'PUT',headers:{'content-type':'application/json',...(trustChanged&&code.trim()?{'x-pulse-two-step':code.trim()}:{})},body:JSON.stringify({enabled,allowedDomains:list,trustGoogle2Step,passwordSignIn})});
   if(!r.ok)throw new Error(REFUSED[d?.error??'']||d?.error?.trim()||'Could not save Google sign-in.');
   take(d);setMessage('Google sign-in saved.');}
  catch(e){const message=(e as Error).message.trim();setError(`${message}${/[.!?…]$/.test(message)?'':'.'} Your changes are still here.`);}finally{setBusy(false);}
 }
 const sub=status!=='ready'||!saved?undefined:!saved.configured?'Server not set up':saved.enabled?'On':'Off';
 return <Panel fill title="Google" sub={sub}>
  {status==='forbidden'?<Empty icon={Lock} compact title="Admins only" text="Only an organisation admin can change Google sign-in. Ask an admin if your team should use Continue with Google."/>
  :status==='loading'?<div className={css.googleForm} role="status" aria-label="Loading Google sign-in settings"><Skeleton width="60%"/><Skeleton height={32}/><Skeleton width="80%"/><Skeleton height={32}/></div>
  :status==='error'||!draft||!saved?<Empty icon={ShieldAlert} compact title="Couldn’t load Google sign-in" text={error||'Try again in a moment.'}><button type="button" className={styles.btn} onClick={reload}>Try again</button></Empty>
  :<form className={css.googleForm} onSubmit={e=>{e.preventDefault();void save();}}>
   <p className={css.googleIntro}>People link their Google account once under Account; then <b>Continue with Google</b> signs them in to that existing Pulse account. Google never creates a Pulse person.</p>
   {!saved.configured?<p className={css.note}><ServerOff size={15} aria-hidden="true"/><span>Google sign-in isn’t set up on this server yet. Whoever runs your Pulse server adds the Google OAuth client and restarts it; then switch it on here. <button type="button" className={styles.btn} onClick={reload}>Check again</button></span></p>:null}
   <Toggle label="Allow Continue with Google" checked={draft.enabled} disabled={busy||(!saved.configured&&!draft.enabled)} onChange={on=>setDraft({...draft,enabled:on})}/>
   <label className={styles.field}>Allowed Workspace domains<input value={domains} onChange={e=>setDomains(e.target.value)} placeholder="example.com" disabled={busy} aria-invalid={!!domainInvalid} aria-describedby="google-domains-hint" autoComplete="off" spellCheck={false}/></label>
   <small id="google-domains-hint" className={domainInvalid?css.googleError:css.googleHint}>{domainInvalid||'Company Google Workspace domains only, separated by commas. Personal Gmail accounts can’t use Google sign-in.'}</small>
   <fieldset className={css.googleChoice} disabled={busy} aria-describedby={passwordInvalid?'google-password-hint':undefined}><legend>Password sign-in</legend>
    <label><input type="radio" name="passwordSignIn" checked={draft.passwordSignIn==='on'} onChange={()=>setDraft({...draft,passwordSignIn:'on'})}/> Everyone can still use their Pulse password</label>
    <label><input type="radio" name="passwordSignIn" checked={draft.passwordSignIn==='off_for_linked'} onChange={()=>setDraft({...draft,passwordSignIn:'off_for_linked'})}/> People with a linked Google account use Google</label>
    <small className={css.googleHint}>Admins always keep their password and Pulse 2-step as the recovery path.</small>
   </fieldset>
   {passwordInvalid?<small id="google-password-hint" className={css.googleError}>{passwordInvalid}</small>:null}
   <Toggle label="Trust Google 2-step" checked={draft.trustGoogle2Step} disabled={busy} onChange={on=>setDraft({...draft,trustGoogle2Step:on})}/>
   <small className={css.googleHint}>{TRUST_HELP} It applies only to Workspace accounts in the domains above; password sign-ins always keep Pulse 2-step.</small>
   {trustChanged?<><label className={styles.field}>Your Pulse 2-step code<input value={code} onChange={e=>setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" disabled={busy} placeholder="Needed if you use 2-step"/></label><small className={css.googleHint}>This change is recorded in the sign-in history and every admin is told.</small></>:null}
   {error?<p role="alert" className={css.googleError}>{error}</p>:message?<p role="status" className={css.googleSaved}>{message}</p>:null}
   <span className={styles.inline}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy||!changed||!!invalid}>{busy?'Saving…':'Save Google sign-in'}</button>{changed?<button type="button" className={styles.btn} disabled={busy} onClick={()=>{take(saved);setError('');}}>Discard changes</button>:null}</span>
  </form>}
 </Panel>;
}
