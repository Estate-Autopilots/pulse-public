import Link from 'next/link';
import { api, getMe } from '../../lib/api';
import { Message, Page, PageHeader, styles } from '../../ui';
import { WaIndex } from './index-client';
import type { WaRow } from './wa';
// WA-IMPORT: every WhatsApp group imported into Pulse that this person reads (their own groups; admins: all), newest
// activity first; ?person= / ?client= / ?project= narrow it (the links from those pages), ?q= words of the title.
export default async function WhatsAppChatsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams;
 const keep = new URLSearchParams(Object.entries({ person: q.person, client: q.client, project: q.project, q: q.q }).filter(([, v]) => v) as [string, string][]);
 const [r, me] = await Promise.all([api<{ total: number; chats: WaRow[] }>(`chats/whatsapp?${keep.toString()}&limit=500`), getMe()]);
 const leader = ['admin', 'leadership'].includes(me.data?.role ?? '');
 if (r.error) return <Message text={r.status === 403 ? 'WhatsApp chats need your individual employee account.' : r.error} />;
 const d = r.data!;
 return <Page>
  <PageHeader title="Groups from WhatsApp" back={{ href: '/chats', label: 'Chats' }}
   context={[`${d.total.toLocaleString()} group${d.total === 1 ? '' : 's'}`, 'Each is a Pulse chat now, with its whole WhatsApp history inside']}
   actions={leader ? <><Link className={styles.btn} href="/insights">Insights</Link><Link className={styles.btn} href="/chats/whatsapp/signals">Signals</Link></> : undefined} />
  <WaIndex rows={d.chats} total={d.total} q={q.q ?? ''} filtered={!!(q.person || q.client || q.project)} />
 </Page>;
}
