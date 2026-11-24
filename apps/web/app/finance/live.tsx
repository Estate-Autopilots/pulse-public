import { Badge } from '../ui';
import type { LiveState, Confidence } from './types';
import css from './finance.module.css';

/** Every figure carries its confidence: high (system document), medium (staff sheet or snippet), low (inferred). */
export function Conf({ level }: { level?: Confidence | string | null }) {
 const l = (level ?? 'low') as Confidence;
 const label = l === 'high' ? 'High confidence' : l === 'medium' ? 'Medium confidence' : 'Low confidence';
 const why = l === 'high' ? 'From a system document: Zoho invoice PDF, bank statement export or GST portal mail' : l === 'medium' ? 'From a staff-maintained sheet or a mail snippet' : 'Inferred or owner-reported; check before relying on it';
 return <span className={css.conf} data-level={l} title={why}>{label}</span>;
}

/** Before the first live sync: say so, show the last runs, and name who starts it. */
export function NoLiveSync({ live }: { live: LiveState | null | undefined }) {
 return <section aria-label="Live finance" className={css.live}>
  <header className={css.liveHead}><div><span className={css.eyebrow}>Live finance</span><h2>The live sync has not run for this workspace yet.</h2>
   <p>Pulse reads EA&apos;s finance sheets, finance mail and the EA index every six hours. Until the first sync finishes, only the certification workspace below is available.</p></div>
   <Badge tone="warning">Uncertified</Badge></header>
  {(live?.runs ?? []).slice(0, 3).map((r, i) => <article className={css.row} key={i}><div><b>{r.ok ? 'Sync finished' : r.ok === false ? 'Sync failed' : 'Sync running'}</b><small>{r.startedAt}</small></div>{r.error ? <Badge tone="danger">{r.error}</Badge> : null}</article>)}
  <article className={css.row}><div><b>Who supplies it</b><p>The sync runs as the EA service account (read-only on mail and sheets). Ops starts it with the finance sync timer.</p></div></article>
 </section>;
}
