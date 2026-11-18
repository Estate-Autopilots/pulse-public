// AGENT-MEMORY (8 Nov 2026, the 7 Nov demo: "Activity doesn't show the groups' and pods' communication"): Activity's
// conversations view: the newest messages in group, unit and function chats the viewer is in (Pulse lists only their own; never
// direct messages), with AI employees marked. Server-rendered from /api/v0/activity/chats.
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { api } from '../lib/api';
import { Message, styles } from '../ui';
import { Say, W } from '../kit/word';
import css from '../company/company.module.css';

type Row = { id: string; at: string; channelId: string; channel: string; kind: 'group' | 'pod' | 'team'; authorId: string; author: string; byAi: boolean; client: boolean; text: string; reply: boolean; files: number };
// Chat kinds: pod is the company's unit (its team word), team is a function (Creative, Sales): both said in its own words.
const KINDS = [{ key: 'all', label: <>All</> }, { key: 'group', label: <>Groups</> }, { key: 'pod', label: <Say t="{teams}" /> }, { key: 'team', label: <Say t="{functions}" /> }];

export async function ActivityChats({ q, zone }: { q: Record<string, string>; zone: string }) {
  const kind = KINDS.some((k) => k.key === q.kind) ? q.kind : 'all', page = Math.max(0, Number(q.page) || 0);
  const r = await api<{ rows: Row[]; page: number }>(`activity/chats?kind=${kind}&page=${page}`);
  if (r.error) return <Message text={r.error} />;
  const rows = r.data?.rows ?? [];
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone });
  return <section aria-label="Group and pod chats" data-activity-chats="">
    <div className={css.controls} role="group" aria-label="Which conversations">{KINDS.map((k) => <Link key={k.key} className={styles.btn} aria-current={k.key === kind ? 'true' : undefined}
      href={`/activity?tab=chats${k.key === 'all' ? '' : `&kind=${k.key}`}`}>{k.label}</Link>)}</div>
    <p className={css.note}><Say t="The newest messages in the group, {team} and {function} chats you are in. Direct messages are never listed here." /></p>
    {rows.length ? <table><thead><tr><th>When</th><th>Conversation</th><th>Who</th><th>Message</th></tr></thead><tbody>{rows.map((m) => <tr key={m.id}>
      <td>{when(m.at)}</td>
      <td><Link href={`/chats?channel=${m.channelId}&message=${m.id}`}>{m.channel}</Link><span className={styles.cellSub}>{m.kind === 'pod' ? <W k="team" /> : m.kind === 'team' ? <W k="function" /> : 'Group'}</span></td>
      <td>{m.byAi ? <><Bot size={13} aria-hidden="true" /> </> : null}{m.author}<span className={styles.cellSub}>{m.byAi ? 'AI employee' : m.client ? 'Client' : 'Colleague'}</span></td>
      <td>{m.text || (m.files ? `${m.files} file${m.files === 1 ? '' : 's'}` : '')}{m.reply ? <span className={styles.cellSub}>In a thread</span> : null}</td></tr>)}</tbody></table>
      : <p><Say t="No messages in your group, {team} or {function} chats yet." /></p>}
    <div className={css.controls}>{page > 0 ? <Link className={styles.btn} href={`/activity?tab=chats&kind=${kind}&page=${page - 1}`}>Newer</Link> : null}
      {rows.length === 50 ? <Link className={styles.btn} href={`/activity?tab=chats&kind=${kind}&page=${page + 1}`}>Older</Link> : null}</div>
  </section>;
}
