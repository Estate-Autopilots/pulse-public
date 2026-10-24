'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { styles } from '../../ui';
import { post } from '../../records';

export function ApproveClose({closeKey, synthetic}:{closeKey:string; synthetic:boolean}) {
  const router = useRouter();
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);
  async function approve() {
    setBusy(true);
    try { const r = await post<{status:string}>('finance/desk/approve-send',{key:closeKey,synthetic}); setStatus(r.status === 'sink' ? 'Synthetic send recorded; no email sent.' : r.status); router.refresh(); }
    catch(e) { setStatus(e instanceof Error ? e.message : 'Approval unavailable'); }
    finally { setBusy(false); }
  }
  return <><button className={styles.btn} disabled={busy} onClick={()=>void approve()}>{busy?'Sending…':synthetic?'Approve fixture send':'Approve & send to CA'}</button><p role="status">{status}</p></>;
}

export function AccountantAccess({people}:{people:{id:string;name:string}[]}) {
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);
  async function save(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();const values = new FormData(e.currentTarget);setBusy(true);
    try { const r = await post<{invitation:string}>('finance/desk/accountants',{personId:values.get('personId'),expiresOn:values.get('expiresOn'),revoke:values.get('revoke')==='on'});setStatus(r.invitation); }
    catch(e) { setStatus(e instanceof Error ? e.message : 'Access unavailable'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save}><p>Assign each CA or CS to their own existing person record, then invite through Settings → Account access.</p><label className={styles.field}>Person<select name="personId" required>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className={styles.field}>Access expires on<input type="date" name="expiresOn" required/></label><label><input type="checkbox" name="revoke"/>Revoke Finance access</label><button className={styles.btn} disabled={busy}>Save Accountant access</button><p role="status">{status}</p></form>;
}
