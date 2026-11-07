import Link from 'next/link';
import { api } from '../../../lib/api';
import { Message, Page, PageHeader, QueryTabs } from '../../../ui';
import css from '../wa.module.css';
import { WaDay } from '../wa';
// WA-IMPORT (1016): what to act on across the imported WhatsApp chats (complaints, churn risk, upsell, payments …), newest
// first, each a link to its message. Admins and leadership; read from the messages on Pulse's own server.
type Signal = { id: string; kind: string; at: string; score: number; amount: number | null; note: string | null; chatId: string; chat: string; messageId: string | null; clientId: string | null; client: string | null };
const KINDS: [string, string][] = [['', 'All'], ['complaint', 'Complaints'], ['churn_risk', 'Churn risk'], ['delay', 'Delays'], ['lead_quality', 'Lead quality'], ['upsell', 'Upsell'], ['renewal', 'Renewal'], ['referral', 'Referrals'],
 ['payment', 'Payments'], ['invoice', 'Invoices'], ['quotation', 'Quotations'], ['approval', 'Approvals']];
const LABEL = Object.fromEntries(KINDS);
export default async function WhatsAppSignalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams; const kind = KINDS.some(([k]) => k === q.kind) ? q.kind ?? '' : '';
 const r = await api<{ signals: Signal[] }>(`chats/whatsapp/signals?limit=500${kind ? `&kind=${kind}` : ''}${q.client ? `&client=${encodeURIComponent(q.client)}` : ''}`);
 if (r.error) return <Message text={r.status === 403 ? 'Signals are for admins and leadership' : r.error} />;
 const rows = r.data!.signals;
 return <Page>
  <PageHeader title="WhatsApp signals" back={{ href: '/chats/whatsapp', label: 'WhatsApp chats' }} context={[`${rows.length.toLocaleString()} shown`, 'Read from the imported chats on Pulse’s server; a guide, not a verdict']} />
  <QueryTabs base="/chats/whatsapp/signals" param="kind" current={kind} items={KINDS.map(([key, label]) => ({ key, label }))} />
  {rows.length ? <ul className={css.rows}>{rows.map((g) => <li key={g.id}><Link href={`/chats/whatsapp/${g.chatId}${g.messageId ? `?m=${g.messageId}` : ''}`}>
   <span className={css.rowIcon} aria-hidden="true">{(LABEL[g.kind] ?? g.kind).slice(0, 1)}</span>
   <span className={css.rowMain}><b>{LABEL[g.kind] ?? g.kind}{g.amount ? ` · ₹${Math.round(g.amount).toLocaleString('en-IN')}` : ''}</b><small>{[g.client, g.chat].filter(Boolean).join(' · ')}</small></span>
   <span className={css.rowNums}><b>{Math.round(g.score * 100)}%</b><small>{g.note ?? ''}</small></span>
   <span className={css.rowWhen}><small><WaDay iso={g.at} /></small></span>
  </Link></li>)}</ul> : <p className={css.empty}>No signals of this kind.</p>}
 </Page>;
}
