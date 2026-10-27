import {AuthReview} from '../account/review';
import Link from 'next/link';
import { CalendarDays, Clapperboard, Contact, Copy, FolderKanban, ListTodo, MapPinned, ScanSearch, Siren, Users, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Empty, Message, Page, PageHeader, Panel, QueryTabs, styles } from '../ui';
import { GroupDecision } from '../people/work-actions';
import { ReviewGroupDecision } from './groups';
import { type Row } from '../company/common';
import { Action, ReviewTable } from '../company/actions';
import css from './review.module.css';
import { AttentionList, type AttentionItem } from './attention';

const GROUPS = [
  { key: 'attention', label: 'Needs attention', impact: 'Everything below, most important first, each with why it matters', Icon: Siren },
  { key: 'geocode', label: 'Places on the map', impact: 'Pins and micro-market centres their own evidence contradicts', Icon: MapPinned },
  { key: 'talent', label: 'Models and shoots', impact: 'Which model a name means, and which project a shoot was for', Icon: Clapperboard },
  { key: 'correction', label: 'Corrections to check', impact: 'Someone on the team, or a source check, says a record is wrong', Icon: Wand2 },
  { key: 'identity', label: 'Identity ambiguities', impact: 'Prevents credit going to the wrong person', Icon: Users },
  { key: 'opening_balance', label: 'Opening leave balances', impact: 'Corrects employee entitlements', Icon: Users },
  { key: 'manager', label: 'Reporting lines', impact: 'Decides approvals and access scope', Icon: Users },
  { key: 'duplicate', label: 'Duplicate records', impact: 'Keeps client and project history together', Icon: Copy },
  { key: 'project_pod', label: 'Project pods', impact: 'Ownership and workload views for each pod', Icon: FolderKanban },
  { key: 'contact_type', label: 'Contact types', impact: 'A cleaner contact directory', Icon: Contact },
  { key: 'wa_contact', label: 'Contacts from the chats', impact: 'Roles, e-mails, clients and websites the WhatsApp groups show; accepting fills only what is empty', Icon: Contact },
  { key: 'onboard_project_fill', label: 'Project details from Drive', impact: 'Fill missing project client and deliverable type from configured rules', Icon: FolderKanban },
  { key: 'holiday', label: 'Holidays', impact: 'Attendance and leave count the right days', Icon: CalendarDays },
  { key: 'data_gap', label: 'Missing details', impact: 'Joining dates, work e-mails, clients and locations not yet recorded', Icon: ListTodo },
  { key: 'onboard_project_new', label: 'New project from Drive', impact: 'Review projects found in indexed Drive folders', Icon: FolderKanban },
  { key: 'people_work', label: 'People and work', impact: 'Who worked on which tasks, projects, deliveries and documents', Icon: Users },
];
type Group = { kind: string; key: string; label: string; note: string; count: number; high: number; confidence: number | null; pod?: string | null; canAccept: boolean; sample: { id: string; title: string; evidence: string[] }[] };
type WorkGroup = { key: string; label: string; count: number; high: number; confidence: number; kinds: string[]; people: number; names: string[]; sample: { id: string; kind: string; title: string; basis: string; confidence: number }[] };
type Groups = { groups: Group[]; work: WorkGroup[] };
const pct = (n: number | null) => n === null ? '' : `${Math.round(n * 100)}%`;
type Data = { rows: Row[]; total: number; page: number; pods: Row[]; people: Row[]; groups: { kind: string; total: number; pending: number; accepted: number; dismissed: number; high: number }[]; rules: { kind: string; enabled: boolean; threshold: number }[]; canRule: boolean };

/** Review data: the types on the left, most valuable first; the chosen type's suggestions on the right, one page at a time. */
export default async function Review({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const all = await api<Data>('review-data?page=0');
  if (all.error) return <Message text={all.error} />;
  // Work evidence (PEOPLE-LIVE) is reviewed beside the other suggestions, as groups.
  const work = (await api<Groups>('review-data/groups?kind=people_work')).data?.work ?? [];
  const workPending = work.reduce((n, g) => n + g.count, 0);
  const kinds = [...all.data!.groups, ...(work.length ? [{ kind: 'people_work', total: workPending, pending: workPending, accepted: 0, dismissed: 0, high: work.reduce((n, g) => n + g.high, 0) }] : [])];
  // R55: Needs attention ranks every pending suggestion; it is where Review data opens.
  const att = await api<{ items: AttentionItem[]; total: number; canDecide: boolean; pods: string[] }>('review-data/attention?limit=80');
  const attTotal = kinds.reduce((n, g) => n + g.pending, 0) - workPending;
  const groups = [{ kind: 'attention', total: attTotal, pending: att.data?.total ?? attTotal, accepted: 0, dismissed: 0, high: 0 }, ...kinds];
  const visible = GROUPS.filter((g) => groups.some((x) => x.kind === g.key));
  const kind = visible.find((g) => g.key === q.kind)?.key ?? 'attention';
  // Hundreds of suggestions are decided group by group: one click per group, a few items' evidence inline. "One by one" keeps the old list.
  const view = kind === 'people_work' || kind === 'attention' ? 'groups' : q.view === 'items' ? 'items' : 'groups';
  const r = kind && kind !== 'people_work' && kind !== 'attention' ? await api<Data>(`review-data?${new URLSearchParams({ kind, page: q.page ?? '0' })}`) : all;
  if (r.error) return <Message text={r.error} />; const d = r.data!;
  const grouped = kind && kind !== 'people_work' && kind !== 'attention' && view === 'groups' ? (await api<Groups>(`review-data/groups?kind=${encodeURIComponent(kind)}`)).data?.groups ?? [] : [];
  const pods = d.pods.map((p) => String(p.name));
  const switcher = kind && kind !== 'people_work' && kind !== 'attention' ? <QueryTabs sub base="/review-data" keep={`kind=${kind}`} param="view" current={view} items={[{ key: 'groups', label: 'Groups' }, { key: 'items', label: 'One by one' }]} /> : undefined;
  const total = kinds.reduce((n, g) => n + g.total, 0), pending = kinds.reduce((n, g) => n + g.pending, 0);
  const percent = total ? Math.round(((total - pending) / total) * 100) : 100;
  const group = GROUPS.find((g) => g.key === kind); const counts = groups.find((x) => x.kind === kind); const rule = d.rules.find((x) => x.kind === kind);
  return (
    <Page fit>
      <AuthReview/>
      <PageHeader title="Review data" context={[`${pending.toLocaleString('en-IN')} suggestions left`, `${percent}% reviewed`, 'your decisions survive source sync']} />
      <div className={css.split} data-grow="">
        <nav className={`${styles.panel} ${css.types}`} aria-label="Suggestion types">
          <div className={css.progress} aria-label={`${percent}% reviewed`}><i style={{ width: `${percent}%` }} /></div>
          <ul>{visible.map((g) => { const n = groups.find((x) => x.kind === g.key)!; return (
            <li key={g.key}><Link href={`/review-data?kind=${g.key}`} className={css.type} aria-current={g.key === kind ? 'true' : undefined}>
              <g.Icon size={16} aria-hidden="true" /><span title={g.impact}><b>{g.label}</b><small>{g.impact}</small></span><Badge tone={n.pending ? (g.key === 'correction' ? 'warning' : 'neutral') : 'success'}>{n.pending ? `${n.pending.toLocaleString('en-IN')} left` : 'Clear'}</Badge>
            </Link></li>); })}</ul>
        </nav>
        <Panel fill title={group?.label ?? 'Suggestions'} sub={kind === 'attention' ? `${(att.data?.total ?? 0).toLocaleString('en-IN')} waiting · ranked by impact and how sure Pulse is` : counts ? `${counts.pending.toLocaleString('en-IN')} left${['correction','data_gap','identity','duplicate','onboard_project_new','onboard_project_fill'].includes(kind??'') ? '' : ` · ${counts.high} at 90%+ source confidence`} · ${(counts.accepted + counts.dismissed).toLocaleString('en-IN')} decided` : undefined}
          tools={d.canRule && kind === 'data_gap' ? <Action path="review-data/gaps" body={{}} label="Check again" /> : d.canRule && kind && ['project_pod', 'contact_type', 'onboard_project_new'].includes(kind) ? <Action path="review-data/rules" body={{ kind, threshold: .95, enabled: !rule?.enabled }} label={rule?.enabled ? (kind === 'onboard_project_new' ? 'Turn off the rule' : 'Turn off the 95% rule') : kind === 'onboard_project_new' ? 'Accept folder-rule matches automatically' : 'Accept 95%+ automatically'} /> : undefined}>
          {switcher}
          {kind === 'attention' ? (att.error ? <p role="alert" className={styles.muted}>{att.error}</p> : att.data?.items.length ? <AttentionList items={att.data.items} canDecide={att.data.canDecide} pods={att.data.pods} />
            : <Empty icon={ScanSearch} first title="Nothing needs attention" text="Every suggestion has been decided. New ones appear after the next import." />)
          : kind === 'people_work' ? (work.length ? <div className={css.groups} data-items="">{work.map((g) => <div key={g.key} className={css.group}>
            <div className={css.groupHead}><span><b>{g.label}</b> <Badge tone={g.confidence >= .9 ? 'success' : 'warning'}>{pct(g.confidence)} average confidence</Badge> {g.kinds.map((k) => <Badge key={k}>{k}</Badge>)}</span>
              <GroupDecision group={g.key} count={g.count} /></div>
            <p>{g.people === 1 ? g.names[0] : `${g.people} people: ${g.names.join(', ')}`}. Accepting writes a receipt for each item; any of them can be undone from the person’s page.</p>
            <ul>{g.sample.map((x) => <li key={x.id}>{x.title} <small>{x.kind} · {pct(x.confidence)} · {x.basis}</small></li>)}</ul>
          </div>)}</div> : <Empty icon={ScanSearch} first title="Nothing left here" text="Every work suggestion has been decided. New ones appear after the next import." />)
          : view === 'groups' ? (grouped.length ? <div className={css.groups} data-items="">{grouped.map((g) => <div key={g.key} className={css.group}>
            <div className={css.groupHead}><span><b>{g.label}</b> {g.confidence !== null ? <Badge tone={g.confidence >= .9 ? 'success' : 'warning'}>up to {pct(g.confidence)} source confidence</Badge> : null}</span>
              <ReviewGroupDecision kind={g.kind} groupKey={g.key} count={g.count} canAccept={g.canAccept} pods={pods} needsPod={g.kind === 'project_pod' && !g.pod} /></div>
            <p>{g.note}</p>
            <ul>{g.sample.map((x) => <li key={x.id}>{x.title}{x.evidence.length ? <small>{x.evidence.join(' — ')}</small> : null}</li>)}</ul>
          </div>)}</div> : <Empty icon={ScanSearch} first title="Nothing left here" text="Every suggestion of this type has been decided. New ones appear after the next import." />)
          : d.rows.length ? <ReviewTable rows={d.rows} pods={d.pods} people={d.people} /> : <Empty icon={ScanSearch} first title="Nothing left here" text="Every suggestion of this type has been decided. New ones appear after the next import." />}
          {view === 'items' && d.total > 50 ? <p className={css.more}>Showing {Math.min(50, d.rows.length)} of {d.total.toLocaleString('en-IN')} · {d.page ? <Link href={`/review-data?kind=${kind}&page=${d.page - 1}`}>Previous 50</Link> : null}{d.page && (d.page + 1) * 50 < d.total ? ' · ' : null}{(d.page + 1) * 50 < d.total ? <Link href={`/review-data?kind=${kind}&page=${d.page + 1}`}>Next 50</Link> : null}</p> : null}
        </Panel>
      </div>
    </Page>
  );
}
