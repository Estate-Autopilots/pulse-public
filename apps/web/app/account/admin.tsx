'use client';
import {Toggle} from '../tasks/kit';
import {notify} from '@pulse/ui-shell';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {post} from '../records';
import {styles} from '../ui';
// PEOPLE-CONTACTS: never in bulk without confirmation: the first press says how many would get a link; the second sends.
export function ResendExpired(){const router=useRouter(),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[due,setDue]=useState<number|null>(null);
 async function run(confirmed:boolean){setBusy(true);try{const r=await post<{sent?:number;failed?:number;confirm?:boolean;count?:number}>('admin/resend-expired',{confirmed});if(r.confirm){setDue(r.count??0);setMessage(r.count?'':'Nobody has an expired link.');return;}setDue(null);setMessage(`${r.sent} sent; ${r.failed} failed`);router.refresh();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 return <span>{due?<><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={()=>void run(true)}>Send {due} new link{due===1?'':'s'}</button><button className={styles.btn} disabled={busy} onClick={()=>setDue(null)}>Cancel</button></>:<button className={styles.btn} disabled={busy} onClick={()=>void run(false)}>Resend expired links</button>}<small role="status">{message}</small></span>;}
/** UX-5A: two-step for admin, HR and leadership: a switch that is there from the first paint (no row jumping in after the
 *  read), with the confirmation in Pip's island instead of a sentence pushed into the toolbar. */
export function AuthPolicy(){const [policy,setPolicy]=useState<{required:boolean;graceUntil:string|null}|null|false>(null),[busy,setBusy]=useState(false);useEffect(()=>{void fetch('/api/v0/admin/auth-policy').then(async r=>{setPolicy(r.ok?await r.json():false);}).catch(()=>{});},[]);
 // MODULES-1024: only admins may set the policy; HR saw a switch that never turned on. Nothing shows when the policy is not theirs.
 if(policy===false)return null;
 return <Toggle label="Require two-step for admin / HR / leadership" checked={!!policy?.required} disabled={!policy||busy} onChange={async on=>{setBusy(true);try{setPolicy(await post('admin/auth-policy',{required:on}));notify({id:'auth-policy',tone:'success',title:on?'Two-step required':'Two-step not required',message:on?'Admin, HR and leadership get 14 days to enroll. The configuring owner stays exempt.':undefined,timeout:4000});}catch(e){notify({id:'auth-policy',tone:'error',title:'Not saved',message:(e as Error).message});}finally{setBusy(false);}}}/>;}
