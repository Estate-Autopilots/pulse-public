'use client';
// R54 (PLAN P28): while a company set up on this Pulse runs its pilot, everyone answers four questions once: does Pulse
// save effort, is it fair, is it calm, is it easy. Answers are anonymous: the database keeps only the totals, and admins
// and HR see them from five answers. Optional; nothing is sent anywhere else.
import { useState } from 'react';
import { HeartHandshake } from 'lucide-react';
import { styles } from '../ui';
import { post } from '../records';
import css from './get-apps.module.css';
import own from './pilot-feedback.module.css';

export type PilotFeedbackState = { open: boolean; given: boolean; minimum: number; questions: { key: string; label: string }[] };

export function PilotFeedback({ initial }: { initial: PilotFeedbackState }) {
  const [d, setD] = useState(initial), [answers, setAnswers] = useState<Record<string, number>>({}), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const complete = d.questions.every((q) => answers[q.key]);
  async function send() {
    setBusy(true); setStatus('');
    try { setD(await post<PilotFeedbackState>('pilot-feedback', answers)); setStatus('Thank you. Only the totals are kept.'); }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Not sent. Your answers are kept here.'); }
    finally { setBusy(false); }
  }
  return (
    <article className={`${css.card} ${css.feedback}`} aria-labelledby="pilot-feedback-title">
      <div className={css.cardHead}><HeartHandshake size={22} aria-hidden="true" /><div><h3 id="pilot-feedback-title">How does Pulse feel so far?</h3>
        <small>Four questions, once, anonymously. Pulse keeps only the totals, never your answers with your name; your admins and HR see the totals once {d.minimum} people have answered. 1 means disagree, 5 means agree. Skip it if you like.</small></div></div>
      {d.given ? <p className={own.done}>You have answered. Thank you.</p> : <>
        <div className={own.questions}>
          {d.questions.map((q) => <fieldset key={q.key} className={own.question}>
            <legend>{q.label}</legend>
            <span className={own.scale}>{[1, 2, 3, 4, 5].map((n) => <label key={n}>
              <input type="radio" name={`pilot-${q.key}`} value={n} checked={answers[q.key] === n} onChange={() => setAnswers({ ...answers, [q.key]: n })} aria-label={`${q.label}: ${n} of 5`} />{n}</label>)}</span>
          </fieldset>)}
        </div>
        <div><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !complete} onClick={() => void send()}>{busy ? 'Sending…' : 'Send my answers'}</button></div>
      </>}
      <p role="status" className={css.attach}>{status}</p>
    </article>
  );
}
