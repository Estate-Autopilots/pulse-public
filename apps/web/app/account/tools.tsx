'use client';
// Account access (HR and admins, for one person). PEOPLE-CONTACTS (owner, 11 Oct 2026: "like Google Admin"): the
// account at a glance (status, last sign-in and where, two-step), one-tap actions (reset password, a one-time sign-in
// link, sign out everywhere, suspend and restore), every signed-in device with its own sign-out, the addresses links go
// to, and the history. Links leave only on an explicit, confirmed click; every action is in the person's history.
import {useEffect,useId,useState,type FormEvent,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {KeyRound,Laptop,Link2,LockOpen,LogOut,MailCheck,PauseCircle,PlayCircle,ShieldCheck,ShieldOff,Smartphone,Unlink} from 'lucide-react';
import {Modal,post} from '../records';
import {styles} from '../ui';
import css from './account.module.css';

type Session={id:string;device:string;lastActive:string;expiresAt:string;remembered:boolean;thisDevice:boolean};
type AccountState={authStatus:string;delivery:string|null;workEmail:string|null;draftDelivery:string|null;verifiedDelivery:string|null;lastLoginAt:string|null;emailPending:{email:string;expiresAt:string}|null;activity:{action:string;at:string;device?:string}[];
 sessions?:Session[];lastSignIn?:{at:string;device:string|null}|null;twoStep?:boolean;signinLink?:{expiresAt:string;used:boolean}|null};
type Props={id:string;hasLogin:boolean;active:boolean;small?:boolean;client?:boolean};
const errorMessage=(e:unknown)=>e instanceof Error?e.message:'Could not save. Please retry.';
const when=(at:string)=>{const m=Math.round((Date.now()-Date.parse(at))/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:new Date(at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});};
const STATUS:Record<string,{label:string;tone:string}>={active:{label:'Active',tone:'ok'},disabled:{label:'Suspended',tone:'off'},locked:{label:'Locked',tone:'warn'},invited:{label:'Invited',tone:'wait'},'link expired':{label:'Invitation expired',tone:'warn'},'not invited':{label:'Not invited',tone:'wait'}};
const CONFIRM:Record<string,{label:string;text:string}>={
 copy:{label:'Confirm copy',text:'This link gives access to this account. Check identity, then deliver it privately. Never post in a group chat. It is shown once and audited.'},
 'two-step-reset':{label:'Confirm two step reset',text:'Confirm you checked identity outside Pulse. Resetting two-step signs the person out.'},
 disable:{label:'Confirm suspend',text:'Suspending ends every session at once and blocks sign-in until you restore the account. Nothing else on the record changes.'},
 'sign-out-all':{label:'Confirm sign out all',text:'This ends active sessions immediately. Confirm this account action.'},
 'google-unlink':{label:'Confirm unlink Google',text:'Continue with Google stops working for this person and every session opened with Google ends now. Their Pulse password and two-step stay; they can link again from Account.'},
 signin:{label:'Confirm send sign-in link',text:'Pulse e-mails a private link that signs this person in once, within 15 minutes. Send it only when they asked for it.'},
};
export function AccountTools(props:Props){
 const [open,setOpen]=useState(false);
 return <><button className={`${styles.btn}${props.small?' '+styles.btnSmall:''}`} onClick={()=>setOpen(true)}>Account access</button>{open?<AccountDrawer {...props} onClose={()=>setOpen(false)}/>:null}</>;
}
function Action({icon,label,hint,onClick,disabled,tone}:{icon:ReactNode;label:string;hint:string;onClick:()=>void;disabled?:boolean;tone?:'danger'}){
 return <button type="button" className={css.tile} data-tone={tone} disabled={disabled} onClick={onClick} aria-label={label} title={hint}><span className={css.tileIcon} aria-hidden="true">{icon}</span><span className={css.tileText}><b>{label}</b><small>{hint}</small></span></button>;
}
function AccountDrawer({id,hasLogin,active,client=false,onClose}:Props&{onClose:()=>void}){
 const router=useRouter(),uid=useId();
 const [state,setState]=useState<AccountState|null>(null),[loading,setLoading]=useState(!client),[loadError,setLoadError]=useState('');
 const [busy,setBusy]=useState(''),[message,setMessage]=useState(''),[actionError,setActionError]=useState(false),[link,setLink]=useState(''),[confirm,setConfirm]=useState(''),[reason,setReason]=useState('');
 const [work,setWork]=useState(''),[delivery,setDelivery]=useState(''),[fieldMessage,setFieldMessage]=useState({work:'',delivery:''}),[fieldError,setFieldError]=useState({work:false,delivery:false});
 const path=client?`admin/client-accounts/${id}`:`people/${id}/login`;
 useEffect(()=>{
  if(client)return;
  let live=true;
  void fetch('/api/v0/admin/auth-history/'+id,{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error??'Could not load account access');if(live){setState(d);setWork(d.workEmail??'');setDelivery(d.draftDelivery??d.emailPending?.email??d.verifiedDelivery??d.delivery??'');}}).catch(e=>{if(live)setLoadError(errorMessage(e));}).finally(()=>{if(live)setLoading(false);});
  return ()=>{live=false;};
 },[id,client]);
 async function refresh(){
  const r=await fetch('/api/v0/admin/auth-history/'+id,{cache:'no-store'}),d=await r.json();
  if(!r.ok)throw new Error(d.error??'Could not refresh account access');
  setState(d);setLoadError('');return d as AccountState;
 }
 async function retryLoad(){setLoading(true);try{const d=await refresh();setWork(d.workEmail??'');setDelivery(d.draftDelivery??d.emailPending?.email??d.verifiedDelivery??d.delivery??'');}catch(e){setLoadError(errorMessage(e));}finally{setLoading(false);}}
 async function saveEmail(event:FormEvent<HTMLFormElement>,field:'work'|'delivery'){
  event.preventDefault();const email=(field==='work'?work:delivery).trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>(field==='work'?120:254)){setFieldError(s=>({...s,[field]:true}));setFieldMessage(s=>({...s,[field]:'Enter a valid email address.'}));return;}
  setBusy(field);setFieldMessage(s=>({...s,[field]:''}));setFieldError(s=>({...s,[field]:false}));
  try{await post(path,{action:field==='work'?'email-work-save':'email-delivery-save',email});if(field==='work')setWork(email);else setDelivery(email);await refresh();setFieldMessage(s=>({...s,[field]:field==='work'?'Work identity saved. No invitation sent.':'Address saved, unverified. Send a confirmation link when ready. No invitation sent.'}));router.refresh();}
  catch(e){setFieldError(s=>({...s,[field]:true}));setFieldMessage(s=>({...s,[field]:errorMessage(e)}));}finally{setBusy('');}
 }
 async function verifyEmail(){
  setBusy('verify');setFieldMessage(s=>({...s,delivery:''}));setFieldError(s=>({...s,delivery:false}));
  try{await post(path,{action:'email-delivery-verify'});await refresh();setFieldMessage(s=>({...s,delivery:'Confirmation link sent. Waiting for the person to confirm. No invitation sent.'}));}
  catch(e){setFieldError(s=>({...s,delivery:true}));setFieldMessage(s=>({...s,delivery:errorMessage(e)}));}finally{setBusy('');}
 }
 async function run(action:string,extra:Record<string,unknown>={}){
  setBusy(action);setMessage('');setActionError(false);setLink('');
  try{const r=await post<{link?:string;warning?:string;to?:string}>(path,action==='google-unlink'?{action}:{action,confirmed:true,reason,...extra});
   if(r.link){setLink(r.link);setMessage(r.warning??'Keep this link private.');}
   else setMessage(action==='signin'?`Sign-in link sent${r.to?` to ${r.to}`:''}. It works once, for 15 minutes.`:['reset','invite'].includes(action)?'Fresh link sent. Older links no longer work.':action==='device-end'?'Signed out of that device.':action==='google-unlink'?'Google unlinked. Their password still works.':'Saved.');
   setConfirm('');if(!client)await refresh();router.refresh();}
  catch(e){setActionError(true);setMessage(errorMessage(e));}finally{setBusy('');}
 }
 const blocked=!!busy||loading||(!client&&!state),missing=!client&&!state?.delivery;
 const pending=state?.emailPending,waiting=!!pending&&Date.parse(pending.expiresAt)>Date.now();
 const deliveryStatus=state?.draftDelivery?waiting&&pending?.email===state.draftDelivery?'Pending confirmation':'Saved, unverified':waiting?'Pending confirmation':state?.verifiedDelivery?'Verified':state?.delivery?'On file · not email-verified':'Missing';
 const changedDraft=delivery.trim().toLowerCase()!==state?.draftDelivery;
 const status=STATUS[state?.authStatus??(client?active?'active':'disabled':'')]??{label:loading?'Loading…':state?.authStatus??'Unavailable',tone:'wait'};
 const sessions=state?.sessions??[];
 const ask=(action:string)=>{setConfirm(action);setMessage('');};
 const confirmation=confirm?(confirm.startsWith('device-end:')?{label:'Confirm sign out device',text:'That device is signed out at once. A Pulse app on it has to be paired again.'}:CONFIRM[confirm]):null;
 return <Modal title="Account access" sub={client?'Client sign-in and recovery':'Sign-in, devices, e-mail and recovery'} onClose={onClose} scroll><div className={css.access}>
  <section className={`${css.accessSection} ${css.glance}`} aria-label="Account status">
   <h4>Account status</h4>
   <p className={css.accountStatus}><span className={css.pill} data-tone={status.tone}>{status.label}</span>{state?.twoStep?<span className={css.pill} data-tone="ok"><ShieldCheck size={12} aria-hidden="true"/>Two-step on</span>:state?<span className={css.pill} data-tone="wait">Two-step off</span>:null}</p>
   <p>{state?<>Last sign-in: {state.lastSignIn?<><b>{when(state.lastSignIn.at)}</b>{state.lastSignIn.device?` · ${state.lastSignIn.device}`:''}</>:state.lastLoginAt?<b>{new Date(state.lastLoginAt).toLocaleString()}</b>:'Never'}{sessions.length?` · signed in on ${sessions.length} device${sessions.length===1?'':'s'}`:''}</>:'Each person uses their own Pulse username and password.'}</p>
   {loadError?<><p role="alert" className={css.error}>{loadError}</p><button className={styles.btn} disabled={loading} onClick={()=>void retryLoad()}>Retry account details</button></>:null}
  </section>
  <section className={css.accessSection} aria-label="Sign-in and recovery"><h4>Sign-in and recovery</h4>
   <p>Links go to the delivery address below, only when you press a button here. The person chooses their own password.</p>
   {missing&&state?<p className={css.hint}>Add a work address or save and confirm a delivery address below. You can also deliver a private link after checking identity.</p>:null}
   <div className={css.tiles}>
    {hasLogin?<Action icon={<KeyRound size={16}/>} label="Send password reset link" hint="They set a new password; older links stop working." disabled={blocked||missing} onClick={()=>void run('reset')}/>:null}
    {hasLogin&&!client?<Action icon={<Link2 size={16}/>} label="Send one-time sign-in link" hint="Signs them in once, within 15 minutes. Two-step still applies." disabled={blocked||missing||!active} onClick={()=>ask('signin')}/>:null}
    <Action icon={<MailCheck size={16}/>} label={hasLogin?'Resend invitation':'Send invitation'} hint="A link to choose a password, valid for 7 days." disabled={blocked||missing} onClick={()=>void run('invite')}/>
    <Action icon={<Link2 size={16}/>} label="Copy link (no email)" hint="A private password link to hand over yourself." disabled={blocked} onClick={()=>ask('copy')}/>
    <Action icon={<LockOpen size={16}/>} label="Unlock" hint="After too many wrong passwords." disabled={blocked} onClick={()=>void run('unlock')}/>
   </div>
  </section>
  {!client&&state?<section className={css.accessSection} aria-label="Devices"><h4>Devices</h4>
   {sessions.length?<ul className={css.devices}>{sessions.map(s=>{const app=/Native app/.test(s.device);return <li key={s.id}><span className={css.deviceIcon} aria-hidden="true">{app||/Android|iPhone|iOS/.test(s.device)?<Smartphone size={16}/>:<Laptop size={16}/>}</span>
    <span className={css.deviceText}><b>{s.device.replace(' · Native app · ',' · Pulse app · ')}</b><small>Active {when(s.lastActive)}{s.remembered?' · stays signed in':''}</small></span>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={blocked} onClick={()=>ask('device-end:'+s.id)} aria-label={`Sign out ${s.device}`}>{app?'Remove':'Sign out'}</button></li>;})}</ul>
    :<p>Not signed in anywhere right now.</p>}
  </section>:null}
  <section className={css.accessSection} aria-label="Sessions and security"><h4>Sessions and security</h4><p>Suspending or signing out ends browser and app sessions immediately.</p>
   <div className={css.tiles}>
    <Action icon={<LogOut size={16}/>} label="Sign out everywhere" hint="Every browser and app; the password stays." disabled={blocked} onClick={()=>ask('sign-out-all')}/>
    {active?<Action icon={<PauseCircle size={16}/>} label="Suspend" hint="Blocks sign-in until restored." tone="danger" disabled={blocked} onClick={()=>ask('disable')}/>:<Action icon={<PlayCircle size={16}/>} label="Restore" hint="Sign-in works again with their password." disabled={blocked} onClick={()=>void run('enable')}/>}
    {hasLogin?<Action icon={<ShieldOff size={16}/>} label="Reset two-step" hint="When they lost their authenticator." disabled={blocked} onClick={()=>ask('two-step-reset')}/>:null}
    {hasLogin&&!client?<Action icon={<Unlink size={16}/>} label="Unlink Google" hint="Ends Continue with Google; the password stays." disabled={blocked} onClick={()=>ask('google-unlink')}/>:null}
   </div>
  </section>
  {confirmation?<section className={css.confirmation} aria-label="Confirm account action"><p>{confirmation.text}{confirm==='signin'&&state?.delivery?<> It goes to <b>{state.delivery}</b>.</>:null}</p>{confirm==='two-step-reset'?<label className={css.form}>Identity check reason<input value={reason} onChange={e=>setReason(e.target.value)} minLength={10}/></label>:null}<div className={css.actions}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={blocked||(confirm==='two-step-reset'&&reason.trim().length<10)} onClick={()=>void (confirm.startsWith('device-end:')?run('device-end',{id:confirm.slice(11)}):run(confirm))}>{confirmation.label}</button><button className={styles.btn} disabled={!!busy} onClick={()=>setConfirm('')}>Cancel</button></div></section>:null}
  {message?<p className={actionError?css.error:css.status} role={actionError?'alert':'status'}>{message}</p>:null}{link?<><code className={css.secret}>{link}</code><button className={styles.btn} onClick={()=>void navigator.clipboard.writeText(link).catch(()=>{setActionError(true);setMessage('Clipboard unavailable. Select the private link to copy it.');})}>Copy private link</button></>:null}
  {!client&&state?<>
   <section className={css.accessSection} aria-label="Work identity email"><h4>Work identity email</h4><p>The company address recorded on the staff profile. Saving it does not connect a Google account or change roles.</p><form className={css.form} noValidate onSubmit={e=>void saveEmail(e,'work')}><label htmlFor={uid+'work'}>Work email<input id={uid+'work'} name="workEmail" type="email" autoComplete="off" maxLength={120} value={work} disabled={!!busy} aria-invalid={fieldError.work} aria-describedby={uid+'work-feedback'} onChange={e=>setWork(e.target.value)}/></label><div className={css.actions}><button className={styles.btn} disabled={!!busy}>{busy==='work'?'Saving…':'Save work email'}</button></div><p id={uid+'work-feedback'} role={fieldError.work?'alert':'status'} className={fieldError.work?css.error:css.hint}>{fieldMessage.work||'No email or invitation is sent when you save.'}</p></form></section>
   <section className={css.accessSection} aria-label="Delivery email"><div className={css.sectionTitle}><h4>Delivery email</h4><span className={css.badge}>{deliveryStatus}</span></div><p>Receives sign-in links, password recovery and account notices. A saved replacement is used only after the person confirms it.</p><p className={css.hint}>Current destination: <span className={css.address}>{state.delivery??'None yet'}</span>{!state.verifiedDelivery&&state.delivery?' (staff profile fallback)':''}</p><form className={css.form} noValidate onSubmit={e=>void saveEmail(e,'delivery')}><label htmlFor={uid+'delivery'}>Delivery address<input id={uid+'delivery'} name="deliveryEmail" type="email" autoComplete="off" maxLength={254} value={delivery} disabled={!!busy} aria-invalid={fieldError.delivery} aria-describedby={uid+'delivery-feedback'} onChange={e=>setDelivery(e.target.value)}/></label><div className={css.actions}><button className={styles.btn} disabled={!!busy}>{busy==='delivery'?'Saving…':'Save delivery email'}</button><button type="button" className={styles.btn} disabled={!!busy||!state.draftDelivery||changedDraft} onClick={()=>void verifyEmail()}>{busy==='verify'?'Sending…':waiting?'Resend confirmation link':'Send confirmation link'}</button></div><p id={uid+'delivery-feedback'} role={fieldError.delivery?'alert':'status'} className={fieldError.delivery?css.error:css.hint}>{fieldMessage.delivery||(pending&&!waiting?'Confirmation expired. Save the address and send a fresh link.':'Save first. Sending confirmation is a separate action; it never sends an invitation.')}</p></form><button className={styles.btn} disabled={!!busy} onClick={()=>void refresh().catch(e=>setLoadError(errorMessage(e)))}>Refresh verification status</button></section>
   <section className={css.accessSection} aria-label="Account history"><h4>Account history</h4>{state.activity.length?state.activity.map((h,i)=><div className={css.row} key={i}><span>{h.action.replaceAll('_',' ')}</span><small>{new Date(h.at).toLocaleString()}</small></div>):<p>No account activity yet.</p>}</section>
  </>:null}
 </div></Modal>;
}
