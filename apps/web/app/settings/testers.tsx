'use client';
import { useState } from 'react';
import { Check, Copy, Image as ImageIcon, UserPlus, X } from 'lucide-react';
import { Badge, styles } from '../ui';
import { post } from '../records';
import { GUIDES } from './app-guides';
import css from './team.module.css';

export type Tester = { personId: string; name: string; username: string | null; platforms: string[]; note: string; invitedAt: string; invitedBy: string | null; feedback: number;
  devices: { platform: string; appVersion: string | null; lastSeen: string | null }[] };
export type Feedback = { id: string; personName: string; platform: string; appVersion: string; page: string; body: string; hasScreenshot: boolean; status: 'new' | 'seen' | 'done'; createdAt: string; handledBy: string | null };
export type TestersData = { testers: Tester[]; people: { id: string; name: string }[] };

const NAMES: Record<string, string> = { windows: 'Windows', macos: 'Mac', android: 'Android', ios: 'iPhone', chrome: 'Chrome' };
function CopyLink({ path, label }: { path: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={styles.btn} onClick={() => void navigator.clipboard?.writeText(new URL(path, window.location.origin).toString()).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1600); })} aria-label={`Copy the ${label} install link`}>
    {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{label}</button>;
}

/** Settings → Devices → Invite testers (admin and leadership): install links per platform, who is testing, feedback. */
export function Testers({ initial, feedback: initialFeedback }: { initial: TestersData; feedback: Feedback[] }) {
  const [data, setData] = useState(initial), [feedback, setFeedback] = useState(initialFeedback);
  const [person, setPerson] = useState(''), [platforms, setPlatforms] = useState<string[]>(['windows', 'macos']), [note, setNote] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  async function reload() { const r = await fetch('/api/v0/testers', { cache: 'no-store' }); if (r.ok) setData(await r.json()); }
  async function invite() {
    if (!person) return; setBusy(true); setStatus('');
    try { await post('testers', { personId: person, platforms, note }); setPerson(''); setNote(''); await reload(); setStatus('Added. Send them the install links above.'); }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Could not add'); } finally { setBusy(false); }
  }
  async function remove(id: string) { await post(`testers/${id}/remove`, {}); await reload(); }
  async function mark(id: string, next: Feedback['status']) { await post(`feedback/${id}/status`, { status: next }); setFeedback(feedback.map((f) => f.id === id ? { ...f, status: next } : f)); }
  const open = feedback.filter((f) => f.status !== 'done').length;
  return (
    <section className={css.team} aria-labelledby="testers-title">
      <header className={css.head}><div><h2 id="testers-title">Invite testers</h2>
        <p>Leadership and volunteers try the apps before the stores. Send each tester the install page for their device; updates then arrive by themselves through Pip.</p></div></header>
      <div className={css.links}>{GUIDES.map((g) => <CopyLink key={g.slug} path={`/apps/${g.slug}`} label={g.title} />)}</div>
      <div className={css.invite}>
        <label className={styles.field}>Tester<select value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Choose a person…</option>{data.people.filter((p) => !data.testers.some((t) => t.personId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <fieldset className={css.platforms}><legend>Devices</legend>{Object.entries(NAMES).map(([key, label]) => <label key={key}><input type="checkbox" checked={platforms.includes(key)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, key] : platforms.filter((x) => x !== key))} />{label}</label>)}</fieldset>
        <label className={styles.field}>Note<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="For example: leadership pilot" /></label>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!person || busy} onClick={() => void invite()}><UserPlus size={14} aria-hidden="true" />Add tester</button>
      </div>
      <p role="status" className={styles.muted}>{status}</p>
      <h3 className={css.sub}>{`Testers (${data.testers.length})`}</h3>
      {data.testers.length ? <ul className={css.devices}>{data.testers.map((t) => (
        <li key={t.personId} className={css.device}>
          <div className={css.deviceMain}><strong>{t.name}</strong><small>{[t.platforms.map((p) => NAMES[p] ?? p).join(', ') || 'No devices chosen', t.note, `${t.feedback} feedback`].filter(Boolean).join(' · ')}</small></div>
          <div className={css.badges}>{t.devices.length ? t.devices.map((d, i) => <Badge key={i} tone="success">{`${NAMES[d.platform] ?? d.platform} ${d.appVersion ?? ''}`.trim()}</Badge>) : <Badge tone="warning">Not installed yet</Badge>}</div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} aria-label={`Remove ${t.name} from testers`} onClick={() => void remove(t.personId)}><X size={14} aria-hidden="true" /></button>
        </li>))}</ul> : <p className={styles.muted}>No testers yet.</p>}
      <h3 className={css.sub}>{`Feedback (${open} open)`}</h3>
      {feedback.length ? <ul className={css.feedback}>{feedback.map((f) => (
        <li key={f.id} data-status={f.status}>
          <div className={css.feedbackHead}><strong>{f.personName}</strong><small>{`${NAMES[f.platform] ?? 'Web'}${f.appVersion ? ` ${f.appVersion}` : ''} · ${new Date(f.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`}</small>
            <Badge tone={f.status === 'new' ? 'accent' : f.status === 'seen' ? 'warning' : 'success'}>{f.status === 'new' ? 'New' : f.status === 'seen' ? 'Seen' : 'Done'}</Badge></div>
          <p>{f.body}</p>
          <div className={css.badges}>
            {f.hasScreenshot ? <a className={styles.btn} href={`/api/v0/feedback/${f.id}/screenshot`} target="_blank" rel="noreferrer"><ImageIcon size={14} aria-hidden="true" />Screenshot</a> : null}
            {f.status !== 'seen' && f.status !== 'done' ? <button type="button" className={styles.btn} onClick={() => void mark(f.id, 'seen')}>Mark seen</button> : null}
            {f.status !== 'done' ? <button type="button" className={styles.btn} onClick={() => void mark(f.id, 'done')}>Done</button> : <button type="button" className={styles.btn} onClick={() => void mark(f.id, 'new')}>Reopen</button>}
          </div>
        </li>))}</ul> : <p className={styles.muted}>No feedback yet. Testers send it from the app’s Settings → Updates & about, or from Get the apps.</p>}
    </section>
  );
}
