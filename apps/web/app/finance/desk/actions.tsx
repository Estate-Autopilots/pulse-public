'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { styles } from '../../ui';
import { post } from '../../records';
import { Switch } from "../../kit/switch";
import { Drawer } from "../../kit/drawer";
import { UserCog } from "lucide-react";
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

/** CA-ACCESS: the owner's card for each CA: whether they see salaries (the tick), until when, and End access. Adding a
 *  CA is Add people → CA / accountant (one join link); there is no separate "invite CA". */
export function CaAccess({ initial }: { initial: { id: string; name: string; until: string; salaries: boolean; active: boolean }[] }) {
  const [cas, setCas] = useState(initial);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  async function save(personId: string, change: { salaries?: boolean; end?: boolean }) {
    setBusy(personId); setStatus('');
    try { setCas((await post<{ cas: typeof initial }>('finance/desk/ca', { personId, ...change })).cas); setStatus(change.end ? 'Access ended. They are signed out.' : 'Saved. They will see it the next time they sign in.'); }
    catch (e) { setStatus(e instanceof Error ? e.message : 'That did not save'); }
    finally { setBusy(null); }
  }
  const live = cas.filter((c) => c.active);
  return <div className={css.access}>
    {live.length ? <ul className={css.caList}>{live.map((c) => <li key={c.id}>
      <span className={css.caName}><b>{c.name}</b><small>Until {c.until}</small></span>
      <Switch inline label="Can see salaries" hint="Each person’s pay, for TDS on salary" checked={c.salaries} disabled={busy === c.id} onChange={(on) => void save(c.id, { salaries: on })} />
      <button type="button" className={styles.btn} disabled={busy === c.id} onClick={() => void save(c.id, { end: true })}>End access</button>
    </li>)}</ul> : <p className={css.muted}>No CA yet. Add them once; they get one link and see Finance only.</p>}
    <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/people?add=ca">Add your CA</Link>
    <p role="status" className={css.muted}>{status}</p>
  </div>;
}

/** FIX-PEOPLE-MONEY C3: "Your CA" is a button in the month bar (beside Download) that opens the shared side panel,
 *  instead of a card under the table. */
export function YourCa({ initial }: { initial: { id: string; name: string; until: string; salaries: boolean; active: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const n = initial.filter((c) => c.active).length;
  return <>
    <button type="button" className={styles.btn} onClick={() => setOpen(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><UserCog size={15} aria-hidden="true" />Your CA{n ? ` · ${n}` : ""}</button>
    {open ? <Drawer title="Your CA" size="md" onClose={() => setOpen(false)} context={<span className={css.muted}>Finance only. No HR, chats or salaries unless you say so.</span>}>
      <CaAccess initial={initial} />
    </Drawer> : null}
  </>;
}
