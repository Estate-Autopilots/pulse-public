'use client';
// KAZUK-REST slice 6 (KAZUK-requirements F1): for a published policy version, HR sees who acknowledged it and, first,
// who has not yet, with when each was last reminded, and reminds them all in one press (in Pulse only; each person at
// most once a day).
import { useCallback, useEffect, useState } from 'react';
import { BellRing, CheckCheck } from 'lucide-react';
import { notify } from '@pulse/ui-shell';
import { styles } from '../ui';
import css from './policy-acks.module.css';

type Status = { documentId: string; version: number; total: number; acknowledged: { id: string; name: string; at: string }[]; pending: { id: string; name: string; remindedAt: string | null }[] };
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(iso));

export function PolicyAcks({ documentId }: { documentId: string }) {
  const [s, setS] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => fetch(`/api/v0/hr/policies/${documentId}/acks`, { cache: 'no-store' }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setS(d); })
    .catch((e) => setError(e instanceof Error ? e.message : 'Acknowledgements are not available')), [documentId]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  async function remind() {
    setBusy(true);
    try {
      const r = await fetch(`/api/v0/hr/policies/${documentId}/remind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      notify({ id: 'policy-remind', tone: 'success', title: d.reminded ? `Reminded ${d.reminded} ${d.reminded === 1 ? 'person' : 'people'}` : 'Everyone was reminded today already', timeout: 3000 });
      await load();
    } catch (e) { notify({ id: 'policy-remind', tone: 'error', title: 'No reminder sent', message: e instanceof Error ? e.message : 'Try again' }); }
    finally { setBusy(false); }
  }
  if (!s) return error ? <p className={styles.muted} role="status">{error}</p> : null;
  return <section className={css.box} aria-label="Acknowledgements">
    <div className={css.head}>
      <b>Acknowledged by {s.acknowledged.length} of {s.total}</b>
      {s.pending.length ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void remind()}><BellRing size={13} aria-hidden="true" />{busy ? 'Reminding…' : `Remind the ${s.pending.length} who have not`}</button>
        : <span className={css.done}><CheckCheck size={14} aria-hidden="true" />Everyone has acknowledged this version</span>}
    </div>
    {s.pending.length ? <div><p className={css.label}>Not acknowledged yet ({s.pending.length})</p>
      <ul className={css.people}>{s.pending.map((p) => <li key={p.id} data-pending="">{p.name}{p.remindedAt ? <small> · reminded {when(p.remindedAt)}</small> : null}</li>)}</ul></div> : null}
    {s.acknowledged.length ? <details><summary className={css.label}>Acknowledged ({s.acknowledged.length})</summary>
      <ul className={css.people}>{s.acknowledged.map((p) => <li key={p.id}>{p.name}<small> · {when(p.at)}</small></li>)}</ul></details> : null}
  </section>;
}
