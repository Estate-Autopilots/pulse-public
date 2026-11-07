'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { styles } from '../../ui';
import { post } from '../../records';
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";
import { Switch } from "../../kit/switch";
import css from "./desk.module.css";

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
  // UX-POLISH: the access form reads top to bottom (what it does, person, expiry, revoke as a switch, one save).
  return <form onSubmit={save} className={css.access}><p>Give each CA or CS their own person record, then invite them from Settings → Account access.</p>
    <label className={styles.field}>Person<SelectField name="personId" required>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
    <label className={styles.field}>Access expires on<DateField name="expiresOn" required/></label>
    <Switch inline name="revoke" label="Revoke Finance access"/>
    <button className={`${styles.btn} ${css.save}`} disabled={busy}>{busy?'Saving…':'Save access'}</button><p role="status" className={css.muted}>{status}</p></form>;
}
