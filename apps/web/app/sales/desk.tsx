import { AlertTriangle, BadgeCheck, Inbox, Phone, PhoneCall, Users } from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from '../ui';
import { EmptyState as Empty, StripeCard as Panel } from '../components/kit';
import { LineList, LineRow } from '../kit/line-row';
import { rupees } from '../lib/finance-numbers.mjs';
import { deskStageLabel } from '../lib/sales-desk.mjs';
import { RetryButton } from '../retry-button';
import css from './desk.module.css';

/* KAZUK-REST (A19; Kazuk, 3 Nov meeting: "a salesperson dashboard with leads and calls"). What a salesperson works from
   each day, under their numbers on My sales: their leads from Pulse and Sales X-Ray by stage, their calls of the last
   two weeks with what came of them, follow-ups due today, and (only when the company's sales flow has an approval:
   Willow Lane yes, EA no) quotations waiting for approval. Data: GET
   /api/v0/sales-desk (pulse.sales_desk, 1711). */

export type Desk = {
  person: { id: string; name: string; self: boolean }; asOf: string;
  leads: { count: number; xray: number; pulse: number; stages: { stage: string; label: string | null; count: number }[];
    items: { id: string; name: string; company: string | null; stage: string; label: string | null; source: 'xray' | 'pulse'; at: string | null; clientId: string | null }[] };
  calls: { count: number; minutes: number; tasksDone: number;
    items: { id: string; title: string; at: string | null; seconds: number | null; status: string; clientId: string | null; score: number | null; outcome: string | null }[] };
  today: { due: number; items: { id: string; title: string; dueOn: string | null; overdue: boolean; kind: 'quotation' | 'enquiry' }[] };
  approval: { on: boolean; waiting: { id: string; number: string | null; buyer: string | null; taxable: number; at: string; to: string | null; owner: boolean }[];
    forMe: { id: string; number: string | null; buyer: string | null; taxable: number; at: string | null; by: string | null }[] };
};

const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const mins = (s: number | null) => (s ? `${Math.max(1, Math.round(s / 60))} min` : null);

/** KAZUK-V2 G13: on the one home, Today already lists the follow-ups due (`today={false}` leaves them out here). */
export async function SalesDesk({ person, canOpenErp, today = true }: { person?: string; canOpenErp: boolean; today?: boolean }) {
  const r = await api<Desk>(`sales-desk${person ? `?person=${encodeURIComponent(person)}` : ''}`);
  if (!r.data) return <Panel stripe="in" title="Leads and calls"><div className={css.failed}><p>Leads and calls could not be loaded.{r.error ? ` ${r.error}` : ''}</p><RetryButton /></div></Panel>;
  const d = r.data, own = d.person.self;
  const quote = (id: string) => (canOpenErp ? `/erp/documents/${id}` : undefined);
  return <div className={css.desk} aria-label="Leads, calls and follow-ups">
    <Panel stripe="in" icon={Users} title={own ? 'My leads' : 'Leads'} sub={`${d.leads.pulse} from Pulse · ${d.leads.xray} from Sales X-Ray`} className={css.wide}><div>
      {d.leads.count ? <>
        <ul className={css.stages} aria-label="Leads by stage">{d.leads.stages.map((s) => <li key={s.stage} className={css.stage} data-stage={s.stage}>
          <b>{s.count}</b><span>{deskStageLabel(s.stage, s.label)}</span></li>)}</ul>
        {d.leads.items.length ? <LineList label="Open leads">{d.leads.items.map((l) => <LineRow key={`${l.source}-${l.id}`} href={l.clientId ? `/clients/${l.clientId}` : undefined}
          title={`${l.name}${l.company ? ` · ${l.company}` : ''}`} sub={[deskStageLabel(l.stage, l.label), l.source === 'xray' ? 'Sales X-Ray' : 'Pulse', l.at ? day(l.at) : null].filter(Boolean).join(' · ')} />)}</LineList>
          : <p className={css.quiet}>Every lead is won or lost.</p>}
      </> : <Empty compact icon={Users} title="No leads yet" text={own ? 'Leads assigned to you in Pulse, and Sales X-Ray leads with you as the owner, show here by stage.' : 'No leads with this person as the owner.'} />}
    </div></Panel>
    {today ? <Panel stripe="in" icon={AlertTriangle} title="Follow-ups due today" count={d.today.due || undefined}><div>
      {d.today.items.length ? <LineList label="Follow-ups due">{d.today.items.map((t) => <LineRow key={t.id} href={`/tasks/${t.id}`} title={t.title} tone={t.overdue ? 'needed' : undefined}
        sub={`${t.kind === 'quotation' ? 'Quotation follow-up' : 'Enquiry call'} · ${t.overdue && t.dueOn ? `missed ${day(t.dueOn)}` : 'due today'}`} />)}</LineList>
        : <Empty compact icon={Phone} title="Nothing due today" text="A quotation's follow-up call or an enquiry's call shows here on its day." />}
    </div></Panel> : null}
    <Panel stripe="in" icon={PhoneCall} title={own ? 'My calls' : 'Calls'} sub={`Last 14 days · ${d.calls.count} call${d.calls.count === 1 ? '' : 's'}${d.calls.minutes ? ` · ${d.calls.minutes} min` : ''} · ${d.calls.tasksDone} call task${d.calls.tasksDone === 1 ? '' : 's'} done`}><div>
      {d.calls.items.length ? <LineList label="Calls">{d.calls.items.map((x) => <LineRow key={x.id} href={x.clientId ? `/clients/${x.clientId}` : undefined} title={x.title}
        sub={[x.at ? day(x.at) : null, mins(x.seconds), x.outcome ?? (x.status === 'ready' ? 'No outcome noted' : 'Being analysed')].filter(Boolean).join(' · ')}
        amount={x.score !== null ? `${x.score}` : undefined} amountSub={x.score !== null ? 'score' : undefined} />)}</LineList>
        : <Empty compact icon={PhoneCall} title="No calls in the last 14 days" text="Calls recorded in Sales X-Ray with you as the person show here with what came of them." />}
    </div></Panel>
    {/* VISUAL-QA (D134): an empty approval list only for people who can send a quotation (Billing); others see it when one waits. */}
    {d.approval.on && (canOpenErp || d.approval.waiting.length || d.approval.forMe.length) ? <Panel stripe="in" icon={BadgeCheck} title="Quotations waiting for approval" count={(d.approval.waiting.length + d.approval.forMe.length) || undefined}><div>
      {d.approval.waiting.length || d.approval.forMe.length ? <LineList label="Quotations waiting for approval">
        {d.approval.forMe.map((x) => <LineRow key={`me-${x.id}`} href={quote(x.id)} title={`${x.number ?? 'Draft quotation'}${x.buyer ? ` · ${x.buyer}` : ''}`}
          sub={`${x.by ?? 'A colleague'} asked ${own ? 'you' : d.person.name} to approve${x.at ? ` · ${day(x.at)}` : ''}`} amount={rupees(x.taxable)} amountSub={<Badge tone="accent">To approve</Badge>} />)}
        {d.approval.waiting.map((x) => <LineRow key={x.id} href={quote(x.id)} title={`${x.number ?? 'Draft quotation'}${x.buyer ? ` · ${x.buyer}` : ''}`}
          sub={`${x.owner ? 'A price the owner approves' : `Sent to ${x.to ?? 'an approver'}`} · ${day(x.at)}`} amount={rupees(x.taxable)} amountSub={<Badge tone="warning">Waiting</Badge>} />)}
      </LineList> : <Empty compact icon={Inbox} title="Nothing waiting for approval" text="A quotation sent to a manager or the owner waits here until it is approved." />}
    </div></Panel> : null}
    {/* VISUAL-QA (D132, 13 Nov 2026): no "Quotations open in Quotes" line: /quotes has no list page (a 404); a quotation
        opens from its own row (/quotes/<id>). */}
  </div>;
}
