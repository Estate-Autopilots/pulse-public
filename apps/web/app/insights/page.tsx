import { api } from '../lib/api';
import { Message, Page } from '../ui';
import { OpsInsights, type OpsData, type WorkData } from './ops';
import type { Staff, WorkSummary } from './work';
import { CHATS_TAB, WORK_VIEWS } from './work-tabs';
import { TABS, type Act, type Card, type Facts, type PatternPage, type Runs } from './facts';
// WA-NATIVE (1053): Insights → Client operations: what the company's WhatsApp groups say about how it runs a client, and
// what to change, for leadership and admins. ?tab= picks a part; ?fresh=1 reads the groups again.
// WA-INTEL (1070): From the chats (?tab=chats&view=work|decisions|mistakes|runs|team) reads insights/work.
// INSIGHTS-2 (1082): the live facts filtered by ?period=&pod=&segment=&client= (insights/ops), the cards loaded for the
// tab, the pattern library (?tab=patterns&q=&area=&family=&status=&sort=&offset=) and the mining rounds.
const PART: Record<string, string> = { work: 'work', decisions: 'learning', mistakes: 'learning', runs: 'learning', team: 'team' };
const pass = (q: Record<string, string | undefined>, keys: string[]) => keys.filter((k) => q[k]).map((k) => `${k}=${encodeURIComponent(q[k]!)}`).join('&');
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams;
 const tab = q.tab ?? 'overview', isWork = tab === CHATS_TAB.key, meta = TABS.find((t) => t.key === tab) ?? TABS[0];
 const view = WORK_VIEWS.some((v) => v.key === q.view) ? q.view! : 'work';
 let sub = '', query = '';
 if (view === 'work') { sub = ['suggested', 'accepted', 'dismissed'].includes(q.state ?? '') ? q.state! : 'suggested'; query = `&state=${sub}`; }
 if (view === 'decisions') { sub = ['good', 'bad', 'neutral'].includes(q.verdict ?? '') ? q.verdict! : 'all'; query = `&kind=decision${sub === 'all' ? '' : `&verdict=${sub}`}`; }
 if (view === 'mistakes') query = '&kind=incident';
 if (view === 'runs') query = '&kind=case_study';
 const filters = pass(q, ['period', 'pod', 'segment', 'client', 'fresh']);
 const [r, summary, rows, staff, facts, cards, runs, patterns] = await Promise.all([
  api<OpsData>(`insights/operations${q.fresh === '1' ? '?fresh=1' : ''}`),
  isWork ? api<WorkSummary>('insights/work?part=summary').then((x) => x.data ?? null) : Promise.resolve(null),
  isWork ? api<{ rows: unknown[] }>(`insights/work?part=${PART[view]}${query}`).then((x) => x.data?.rows ?? []) : Promise.resolve([]),
  isWork && view === 'work' ? api<{ people: Staff[] }>('work/options').then((x) => (x.data?.people ?? []).map((p) => ({ id: p.id, name: p.name }))) : Promise.resolve([]),
  api<Facts>(`insights/ops${filters ? `?${filters}` : ''}`),
  tab === 'patterns' ? Promise.resolve(null) : api<{ cards: Card[]; actions: Act[] }>(`insights/library/cards?area=${encodeURIComponent(`${meta.key},${meta.area}`)}`).then((x) => x.data ?? null),
  api<Runs>('insights/library/runs').then((x) => x.data ?? null),
  tab === 'overview' ? api<PatternPage>('insights/library/patterns?status=confirmed&limit=12').then((x) => x.data ?? null) : tab === 'patterns' ? api<PatternPage>(`insights/library/patterns${pass(q, ['q', 'area', 'family', 'status', 'sort', 'offset']) ? `?${pass(q, ['q', 'area', 'family', 'status', 'sort', 'offset'])}` : ''}`).then((x) => x.data ?? null) : Promise.resolve(null),
 ]);
 if (r.error) return <Message text={r.status === 403 ? 'Insights are for leadership and admins' : r.error} />;
 const work: WorkData | undefined = isWork ? { view, summary, rows, staff, sub } : undefined;
 return <Page><OpsInsights data={r.data!} tab={tab} work={work} extra={{ facts: facts.data ?? null, factsError: facts.error ?? null, cards: cards?.cards ?? [], cardActs: cards?.actions ?? [], runs, patterns, q }} /></Page>;
}
