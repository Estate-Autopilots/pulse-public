"use client";
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionId } from '@pulse/companion';
import { AttendanceRecovery, type AttendanceReceipt, type AttendanceTrigger, type UnsavedTap } from '../lib/attendance-recovery.mjs';
import { styles } from '../ui';

const labels = { 'check-in': 'Check-in', 'check-out': 'Check-out', 'break-start': 'Break', 'break-end': 'End break' };
/** `day`: the day the page shows (state, in, out, on break). An accepted tap holds its progress until it changes. */
export function useAttendanceRecovery(person?: string, day = '') {
  const router = useRouter();
  const recovery = useRef<AttendanceRecovery | null>(null);
  const [state, setState] = useState<{ records: AttendanceReceipt[]; note: string; busy: boolean; unsaved: UnsavedTap | null }>({ records: [], note: '', busy: true, unsaved: null });
  // EST-1195: the action just tapped, from the tap until Pulse answers, so the control changes at once.
  const [tap, setTap] = useState<ActionId | null>(null);
  // UI Guard review: any tap Pulse accepts (the button, Try again, Retry saved attendance) keeps its progress label until
  // the page's day changes, or 15 s, so the old buttons never come back in between.
  const [landed, setLanded] = useState<{ id: string; action: ActionId; day: string } | null>(null);
  const dayNow = useRef(day);
  useEffect(() => { dayNow.current = day; });
  useEffect(() => {
    if (!landed) return;
    const t = window.setTimeout(() => setLanded(null), 15000);
    return () => window.clearTimeout(t);
  }, [landed]);
  useEffect(() => {
    if (!person) return;
    let active = true, accepted = '', primed = false;
    const changed = () => {
      const r = recovery.current; if (!active || !r) return;
      setState({ records: [...r.records], note: r.note, busy: r.busy, unsaved: r.unsaved });
      const next = r.records.filter(x => x.state === 'accepted').map(x => x.id).join(',');
      if (next !== accepted) {
        // Receipts already saved when the page opened are not news; a newly accepted tap is.
        const before = new Set(accepted.split(',')), fresh = primed ? r.records.filter(x => x.state === 'accepted' && !before.has(x.id)).at(-1) : undefined;
        if (fresh) setLanded({ id: fresh.id, action: fresh.action, day: dayNow.current });
        accepted = next; router.refresh(); window.dispatchEvent(new Event('pulse:attendance'));
      }
      primed = true;
    };
    try {
      recovery.current = new AttendanceRecovery({ owner: person, storage: localStorage, changed,
        lock: async fn => { if (navigator.locks) await navigator.locks.request('pulse-attendance', async () => { await fn(); }); else await fn(); },
        request: async (path, body, signal) => {
          const r = await fetch(`/api/v0/${path}`, body === undefined ? { cache: 'no-store', signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw Object.assign(new Error('Pulse did not confirm the action'), { status: r.status });
          return data;
        } });
      changed();
    } catch { queueMicrotask(() => { if (active) setState({ records: [], note: 'Saved attendance is unavailable on this device. Check storage and reload My desk.', busy: true, unsaved: null }); }); }
    const refresh = () => { if (document.visibilityState === 'visible') void recovery.current?.retry(); };
    refresh(); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { active = false; recovery.current?.dispose(); recovery.current = null; window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [person, router]);
  const queued = state.records.find(r => r.state === 'queued')?.action ?? null;
  const settling = landed && landed.day === day ? landed.action : null;
  const act = (action: ActionId, mode?: string, trigger?: AttendanceTrigger, extra?: { leave?: 'cancel' }) => {
    const r = recovery.current; if (!r) return Promise.resolve(undefined);
    setTap(action);
    return r.act(action, mode, trigger, extra).finally(() => setTap(null));
  };
  const again = () => { const r = recovery.current; if (!r?.unsaved) return; setTap(r.unsaved.action); void r.again().finally(() => setTap(null)); };
  return { ...state, pending: queued !== null, act,
    /** The action in flight or saved and waiting, and whether Pulse is being asked right now. */
    working: tap ?? queued ?? settling, sending: tap !== null || state.busy || (settling !== null && queued === null),
    receipts: person ? <div aria-label="Saved attendance" role="status" style={{ flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere', fontSize: 12 }}>
      {state.note ? <p>{state.note}</p> : null}
      {state.unsaved ? <p style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className={styles.btn} disabled={tap !== null} onClick={again}>Try again</button>
        {state.unsaved.signedOut ? <a className={styles.btn} href={`/login?next=${encodeURIComponent('/me')}`}>Sign in</a> : null}
      </p> : null}
      {/* Owner workbench (21 Oct 2026): the receipt log shows only when a tap still needs the person (waiting to sync,
          or refused); accepted taps are done and stay out of sight. */}
      {state.records.some(r => r.state !== 'accepted') ? <>
        <details><summary style={{ minHeight: 44 }}>Saved attendance · {state.records.filter(r => r.state === 'queued').length} waiting</summary>
          <ul>{state.records.map(r => <li key={r.id}>{labels[r.action]} · {r.state === 'queued' ? 'Queued — waiting for server confirmation' : r.state === 'accepted' ? 'Accepted by Pulse' : r.state === 'needs-correction' ? 'Needs correction on My desk' : 'Rejected — review My desk'}<br />{new Date(r.at).toLocaleString()} · Retry ID {r.id}{r.receiptId ? <><br />Server receipt {r.receiptId}</> : null}</li>)}</ul>
          <p>Attendance can sync for three hours after a tap. A seven-day metadata queue never extends that limit. Older or refused actions need your reviewed correction.</p>
          <Link href="/me?tab=attendance">Review attendance / request correction</Link>
          <button type="button" className={styles.btn} disabled={state.busy} onClick={() => void recovery.current?.clearReviewed()}>Clear reviewed receipts</button>
        </details>
        {/* Only once sending has stopped: while Pulse is being asked it would be a second, greyed-out button. */}
        {queued !== null && !state.busy && tap === null ? <button type="button" className={styles.btn} onClick={() => void recovery.current?.retry()}>Retry saved attendance</button> : null}
      </> : null}
    </div> : null };
}
