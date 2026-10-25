import { api } from '../lib/api';
import { Message, Page } from '../ui';
import { OpsInsights, type OpsData } from './ops';
// WA-NATIVE (1053): Insights → Client operations: what the company's WhatsApp groups say about how it runs a client, and
// what to change, for leadership and admins. ?tab= picks a part; ?fresh=1 reads the groups again.
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams;
 const r = await api<OpsData>(`insights/operations${q.fresh === '1' ? '?fresh=1' : ''}`);
 if (r.error) return <Message text={r.status === 403 ? 'Insights are for leadership and admins' : r.error} />;
 return <Page><OpsInsights data={r.data!} tab={q.tab ?? 'overview'} /></Page>;
}
