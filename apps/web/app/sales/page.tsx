import Link from 'next/link';
import { AlertTriangle, BadgeIndianRupee, Bot, Briefcase, CalendarClock, FileText, FolderKanban, Handshake, MessageSquareDashed, Phone, Receipt, RefreshCw, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import type { Pipeline } from '../dashboard/pipeline';
import { Badge, Message, Page, styles } from '../ui';
import { EmptyState as Empty, PageHeader, RailCard, SectionHeader, StatTile as Kpi, StatTiles as Tiles, StripeCard as Panel, WithRail } from '../components/kit';
import { LineList, LineRow } from '../kit/line-row';
import { SelectField } from '../kit/select-field';
import { dueText, rupees, span, statusLabel } from '../lib/finance-numbers.mjs';
import { INCENTIVE, NEETI_ROWS, firstName, greeting, neetiValue, syncText, todayItems } from '../lib/sales-home.mjs';
import { discount, money } from '../lib/deals.mjs';
import { Periods } from '../finance/numbers';
import { EmptyState as GameEmpty, ProgressRing } from '../kit/game';
import { DEAL_LABEL, type DealStatus } from '../erp/types';
import css from './home.module.css';
import { SalesDesk } from './desk';
import { DealsBoard, type Deals } from './deals';
import { ReleaseIncentive } from './incentive';
import { Disclosure } from '../kit/disclosure';
import { DraftButton } from './draft';
import { AutoForm } from './auto-form';
import { AgentCard } from './agent-card';

/* KAZUK-V2 G13 (Kazuk, 6 Nov 2026, R41–R45, R60; backlog conflict C2): ONE salesperson home. My sales (FINANCE-TRUTH),
   My pipeline (KAZUK-GAPS) and the sales desk (KAZUK-REST) were three views of the same deals; this page is all of them,
   once each: Today (follow-ups due, and the Sales Agent's reminders with their drafts, G14), the pipeline as one
   strip, every deal with its incentive (Not due, Pending, Released), how the deals went (G12), leads and calls, and in
   the rail the period's money, the Neeti / Sales X-Ray numbers with their last sync ("Not recorded" where nothing came),
   and the projects they sold. Layout: Codex's concept 1 "Today first" (reports/kazuk-v2/concepts/home). No approval
   stage unless the company's sales flow has one (EA: none; conflict C1). The Sales Head, leadership and Finance pick
   anyone. */

type Quote = { id: string; number: string | null; status: string; issueDate: string | null; buyer: string | null; taxable: number; total: number; ownerApprovalNeeded: boolean; named?: boolean };
type Invoice = { id: string; number: string; status: string; issueDate: string; dueDate: string | null; buyer: string | null; taxable: number; gst: number; total: number; baseDue: number; gstDue: number };
type Sales = {
  period: string; from: string; to: string; today: string; canOpenErp: boolean; person: { id: string; name: string; self: boolean };
  quotes: { count: number; value: number; won: number; wonValue: number; open: number; drafts: number; items: Quote[] };
  invoices: { count: number; taxable: number; total: number; paid: number; items: Invoice[] };
  collections: { count: number; cash: number; base: number; gst: number; tds: number };
  open: { count: number; base: number; gst: number; overdue: number; overdueAmount: number };
  team: { id: string; name: string }[] | null;
};
export type Home = {
  person: { id: string; name: string; self: boolean }; canRelease: boolean; approval: boolean; sold: number;
  incentives: { pending: number; released: number; notDue: number };
  stages: { key: 'sent' | 'won' | 'invoiced' | 'paid'; count: number; value: number }[];
  deals: { id: string; number: string | null; buyer: string | null; status: DealStatus; value: number; version: number; incentive: 'not_due' | 'pending' | 'released'; releasedOn: string | null; projectId: string | null }[];
};
export type Nudges = { agent: boolean; canMakeAgent: boolean; settings: { noReplyDays: number; renewalDays: number };
  items: { kind: 'no_reply' | 'overdue' | 'renewal'; key: string; title: string; sub: string; href: string; draft: string; phone: string | null; amount?: number; days: number }[] };
export type Neeti = { connected: boolean; lastSync: string | null; lastError: string | null; leads: number | null; attempts: number | null; firstCallMinutes: number | null;
  settingCalls: number | null; strategySessions: number | null; proposals: number | null; closes: number | null; lost: { reason: string; count: number }[] };

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { paid: 'success', accepted: 'success', converted: 'success', part_paid: 'warning', declined: 'danger' };
const DEAL_TONE: Partial<Record<DealStatus, 'success' | 'warning' | 'danger' | 'accent' | 'neutral'>> = { paid: 'success', accepted: 'success', invoiced: 'accent', part_paid: 'warning', negotiating: 'warning', sent: 'accent', lost: 'danger' };
/** An invoice's state as a salesperson says it (no approval in the flow: an issued invoice is simply not paid yet). */
const INVOICE_WORD: Record<string, string> = { issued: 'Not paid yet', sent: 'Not paid yet', part_paid: 'Part-paid', paid: 'Paid' };
const STAGE: Record<string, string> = { draft: 'Drafts', approval: 'Waiting for approval', sent: 'Sent, no answer yet', won: 'Won, to invoice', invoiced: 'Invoiced', paid: 'Paid' };
/** The folded deals section's hint: "3 won · 48% off on average · 1 lost · Nov 2026". */
const dealsSummary = (s: Deals['summary'], when: string) => !s.deals ? `No quotation sent in ${when} yet`
  : [`${s.won} won`, s.won ? `${discount(s.v1Won, s.finalWon) ?? 0}% off on average` : null, s.lost ? `${s.lost} lost` : null, when].filter(Boolean).join(' · ');
const date = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

export default async function MySales({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const period = ['month', 'last', 'quarter', 'fy', 'lastfy'].includes(q.period) ? q.period : 'month';
  const person = q.person && /^[0-9a-f-]{36}$/.test(q.person) ? q.person : '';
  const pick = new URLSearchParams(Object.entries({ period, person }).filter(([, v]) => v)).toString(), who = person ? `?person=${person}` : '';
  const [r, pipe, home, neeti, deals, nudges] = await Promise.all([api<Sales>(`sales-numbers?${pick}`), api<Pipeline>(`sales-pipeline${who}`), api<Home>(`sales-workspace${who}`),
    api<Neeti>(`sales-neeti?${pick}`), api<Deals>(`sales-deals?${pick}`), api<Nudges>(`sales-agent/nudges${who}`)]);
  if (!r.data) return <Page calm><PageHeader eyebrow={['Sales']} title="My sales" lede="Your quotations, invoices and what your clients paid." />
    {r.status === 403 ? <Empty icon={ShieldCheck} title={person ? 'Another person’s sales are for leadership and Finance' : 'My sales is for staff'}
      text={person ? 'You can see your own deals, numbers and projects.' : 'Sign in with your staff account to see your quotations and invoices.'} action={person ? { href: '/sales', label: 'See my own' } : { href: '/', label: 'Back to Home' }} />
      : <Message text={r.error ?? 'My sales is unavailable'} />}</Page>;
  const d = r.data, self = d.person.self, keep = self ? undefined : { person: d.person.id }, when = span(d.from, d.to);
  const h = home.data, p = pipe.data, n = neeti.data;
  const quoteHref = (x: Quote) => (d.canOpenErp ? `/erp/documents/${x.id}` : x.status === 'draft' || !x.named ? undefined : `/quotes/${x.id}`);
  const today = todayItems({ pipeline: p ?? null, invoices: d.invoices.items, today: d.today, nudges: nudges.data?.items ?? null });
  const strip = [...(p ? p.stages.filter((s) => s.key === 'draft' || (s.key === 'approval' && (h?.approval || s.count > 0))) : []), ...(h?.stages ?? [])];
  // A salesperson with nothing yet gets one clear start, not rows of zeros.
  const fresh = !!h && !h.deals.length && !d.quotes.count && !d.invoices.count && !today.length;
  const invoiced = d.invoices.total, collected = d.collections.cash,
    // Nothing invoiced, no incentive due and no project yet: one note instead of three empty cards.
    quiet = !d.invoices.total && !(h?.incentives.pending || h?.incentives.released) && !h?.sold, share = invoiced ? Math.min(100, Math.round((collected / invoiced) * 100)) : 0;
  return <Page calm>
    <PageHeader eyebrow={['Sales', when]} title={self ? 'My sales' : `Sales · ${d.person.name}`}
      lede={self ? `${greeting(d.today)} ${firstName(d.person.name)}. What to do today, your deals and your numbers.` : 'Their deals, numbers and what is due. Read only.'}
      actions={self && d.canOpenErp ? <Link href="/erp/new?type=quotation" className={`${styles.btn} ${styles.btnPrimary}`}>New quotation</Link> : undefined}
      back={self ? undefined : { href: `/erp/deals?period=${d.period}`, label: 'Deals' }} />
    <div className={css.page}>
      <div className={css.head}>
        <Periods base="/sales" period={d.period} keep={keep} />
        {d.team?.length ? <AutoForm className={css.person} action="/sales" label="Pick a salesperson">
          <input type="hidden" name="period" value={d.period} />
          <label className={styles.field}>Salesperson<SelectField name="person" defaultValue={d.person.id}>
            {d.team.some((x) => x.id === d.person.id) ? null : <option value={d.person.id}>{d.person.name}</option>}
            {d.team.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectField></label>
        </AutoForm> : null}
      </div>
      <WithRail rail={<>
        {quiet ? null : <>
        <RailCard title="Collected" icon={Wallet}>
          {invoiced ? <div className={css.ringRow}>
            <ProgressRing value={share / 100} size={72} stroke={8} tone={share >= 100 ? 'good' : undefined} label={`${share}% of what was invoiced is collected`}><b>{`${share}%`}</b></ProgressRing>
            <p><b>{money(collected)}</b> of {money(invoiced)} invoiced in {when}</p>
          </div> : <p className={css.sync}>Nothing invoiced in {when} yet.</p>}
        </RailCard>
        <RailCard title="From Sales X-Ray" icon={Sparkles}>
          {n ? <>
            <p className={css.sync}>{syncText(n)}</p>
            {NEETI_ROWS.some(([k]) => neetiValue(n, k) !== null) ? <>
              <dl className={css.neeti}>{NEETI_ROWS.filter(([k]) => neetiValue(n, k) !== null).map(([k, label]) => <div key={k}><dt>{label}</dt><dd>{neetiValue(n, k)}</dd></div>)}</dl>
              {NEETI_ROWS.some(([k]) => neetiValue(n, k) === null) ? <p className={css.sync} title={`Not recorded: ${NEETI_ROWS.filter(([k]) => neetiValue(n, k) === null).map(([, label]) => label.toLowerCase()).join(', ')}`}>Some numbers are not recorded yet.</p> : null}
            </>
              : <p className={css.sync}>No leads or calls recorded for {self ? 'you' : 'them'} yet. They show here once Sales X-Ray has them.</p>}
            {n.lost.length ? <p className={css.sync}>{n.lost.map((l) => `${l.count} lost (${l.reason.toLowerCase()})`).join(' · ')}</p> : null}
          </> : <p className={css.sync}>Sales X-Ray numbers could not be loaded.</p>}
        </RailCard>
        {h ? <RailCard title="Incentives" icon={BadgeIndianRupee}>
          {h.incentives.pending + h.incentives.released ? <p className={css.chips}><Badge tone="warning">{h.incentives.pending} pending</Badge><Badge tone="success">{h.incentives.released} released</Badge>{h.incentives.notDue ? <Badge>{h.incentives.notDue} not due yet</Badge> : null}</p>
            : <p className={css.sync}>{h.incentives.notDue ? `${h.incentives.notDue} deal${h.incentives.notDue === 1 ? ' is' : 's are'} not paid yet, so no incentive is due.` : 'No deals yet, so no incentives yet.'}</p>}
          <p className={css.sync}>An incentive is due once the deal is Paid. The Sales Head marks it released.</p>
        </RailCard> : null}
        </>}
        {nudges.data ? <RailCard title={self ? 'My Sales Agent' : 'Their Sales Agent'} icon={Bot}>
          <AgentCard person={d.person.id} self={self} agent={nudges.data.agent} canMake={nudges.data.canMakeAgent} noReplyDays={nudges.data.settings.noReplyDays} renewalDays={nudges.data.settings.renewalDays} />
        </RailCard> : null}
        {quiet ? <RailCard title="Coming up here" icon={Wallet}>
          <p className={css.sync}>Once a deal is paid, this side shows the money collected, your incentives and the projects you sold.</p>
        </RailCard> : <>
        <RailCard title={self ? 'Projects I sold' : 'Projects they sold'} icon={FolderKanban}>
          <p className={css.sync}>{h?.sold ? `${h.sold} project${h.sold === 1 ? '' : 's'}. See how the work is going, read only.` : 'A project shows here once a deal is paid.'}</p>
          {h?.sold ? <Link className={css.more} href={`/sales/projects${who}`}>{self ? 'Open projects I sold' : 'Open their projects'}</Link> : null}
        </RailCard>
        </>}
      </>}>
        {/* VISUAL-QA (D133): "New quotation above" only where that button is (people who can open Billing). */}
        {fresh ? <GameEmpty art="nothing" title={self ? 'Your sales start here' : 'No deals yet'} text={self ? `${d.canOpenErp ? 'Send your first quotation with New quotation above.' : 'Quotations that name you show here once someone with Billing sends one.'} Your deals, money, reminders and incentives show here as they happen.` : 'Nothing sent by this person yet.'} /> : <>
        <Panel stripe="warn" icon={CalendarClock} title="Today" count={today.length || undefined} sub={today.length ? 'Follow-ups due today, late invoices and your Sales Agent’s reminders' : undefined}>
          <div>{today.length ? <ul className={css.today} aria-label="Today">{today.map((t) => <li key={t.key} data-late={t.late ? '' : undefined}>
              <span className={css.todayIcon} aria-hidden="true">{t.kind === 'invoice' ? <Receipt size={16} /> : t.kind === 'no_reply' ? <MessageSquareDashed size={16} /> : t.kind === 'renewal' ? <RefreshCw size={16} />
                : t.late ? <AlertTriangle size={16} /> : <Phone size={16} />}</span>
              <span className={css.todayText}><Link href={t.href}>{t.title}</Link><small>{t.draft ? t.sub.replace(/ · an? [a-z -]+ is drafted$/, '') : t.sub}</small></span>
              <span className={css.todayEnd}>{t.amount !== undefined ? <b>{rupees(t.amount)}</b> : null}
                {t.draft && self ? <DraftButton title={t.title} draft={t.draft} phone={t.phone} /> : null}</span>
            </li>)}</ul>
            : <Empty compact icon={CalendarClock} title="All clear for today" text="Follow-ups, late invoices and your Sales Agent's reminders show here on their day." />}</div>
        </Panel>
        <Panel stripe="in" icon={Briefcase} title={self ? 'My pipeline' : 'Pipeline'} sub="Every deal by where it stands now (any month), before GST">
          {strip.every((s) => !s.count) ? <Empty compact icon={Briefcase} title="Nothing in the pipeline yet" text={self ? `${d.canOpenErp ? 'Use New quotation above to send your first one.' : 'A quotation that names you shows here once it is sent.'} It moves along as the client says yes and pays.` : 'Nothing sent by this person yet.'} /> : <ul className={css.stages} aria-label="Deals by stage">{strip.map((s) => <li key={s.key} data-key={s.key} data-has={s.count ? '' : undefined} data-empty={s.count ? undefined : ''}><b>{s.count}</b><span>{STAGE[s.key]}</span><small>{money(s.value)}</small></li>)}</ul>}
          {p && strip.some((s) => s.count) ? <p className={css.pipeFacts}>
            <span>Pipeline value <b>{money(p.pipeline.value)}</b>{p.pipeline.oldest ? ` · oldest ${p.pipeline.oldest} days` : ''}</span>
            <span>Won this month {p.won.count}{p.lost.count ? ` · lost ${p.lost.count}` : ''}</span>
          </p> : null}
        </Panel>
        <Panel stripe="in" icon={Handshake} title={self ? 'My deals' : 'Deals'} count={h?.deals.length || undefined} sub="Each deal's status and incentive">
          <div>{h?.deals.length ? <ul className={css.deals} aria-label="Deals">{h.deals.map((x) => {
            const inc = INCENTIVE[x.incentive];
            return <li key={x.id}>
              <div className={css.dealMain}>
                {d.canOpenErp ? <Link href={`/erp/documents/${x.id}`}>{x.buyer ?? 'Client not named'}</Link> : <b>{x.buyer ?? 'Client not named'}</b>}
              </div>
              <span className={css.dealValue}>{money(x.value)}</span>
              <span className={css.dealChips}><Badge tone={DEAL_TONE[x.status] ?? 'neutral'}>{DEAL_LABEL[x.status] ?? x.status}</Badge>
                {x.incentive === 'not_due' ? null : <span className={css.incentive} data-tone={inc.tone}>Incentive: {inc.label}</span>}
                {h.canRelease && x.incentive !== 'not_due' ? <ReleaseIncentive id={x.id} released={x.incentive === 'released'} name={x.buyer ?? x.number ?? 'this deal'} /> : null}</span>
              <span className={css.dealMeta}>{x.number ? `${x.number} · V${x.version}` : `V${x.version}`}{x.projectId ? <> · <Link href={`/sales/projects/${x.projectId}${who}`}>See the project</Link></> : null}</span>
            </li>; })}</ul>
            : <Empty compact icon={Handshake} title="No deals yet" text={self ? 'Send your first quotation and it shows here, with its status and incentive.' : 'No quotation of theirs went out yet.'} />}</div>
        </Panel>
        </>}
      </WithRail>
      {fresh ? null : <><SectionHeader level={2} icon={Wallet} title={`Money in ${when}`} />
      <Tiles count={4} label="Money this period">
        <Kpi label="Quoted" value={rupees(d.quotes.value)} note={`${d.quotes.count} quotation${d.quotes.count === 1 ? '' : 's'}, before GST`} />
        <Kpi label="Won" value={rupees(d.quotes.wonValue)} note={`${d.quotes.won} won · ${d.quotes.open} waiting`} />
        <Kpi label="Invoiced" value={rupees(d.invoices.total)} note={`${d.invoices.count} invoice${d.invoices.count === 1 ? '' : 's'} · ${d.invoices.paid} paid`} />
        <Kpi label="Collected" value={rupees(collected)}
          note={d.open.overdue ? `${rupees(d.open.overdueAmount)} overdue` : d.open.count ? `${rupees(d.open.base + d.open.gst)} still to collect` : 'Nothing outstanding'} />
      </Tiles></>}
      {/* VISUAL-QA (D134): with no sales yet the hero above says it once; "How my deals went" ("No quotation sent in …") and
          the empty Quotations and Invoices panels repeated it three more times. */}
      {deals.data && !fresh ? <section className={css.section} aria-label={self ? 'How my deals went' : 'How their deals went'}>
        <SectionHeader level={2} icon={Handshake} title={self ? 'How my deals went' : 'How their deals went'}
          aside={d.canOpenErp ? <Link href={`/erp/deals?period=${d.period}${self ? '' : `&person=${d.person.id}`}`}>Open in Billing</Link> : undefined} />
        <p className={css.headline}>{dealsSummary(deals.data.summary, when)}{deals.data.summary.won && self ? <span> Before the next discount, try better terms, a bonus or one package down.</span> : null}</p>
        <Disclosure summary="Show the details">
          <DealsBoard d={deals.data} own={self} list={false} />
        </Disclosure>
      </section> : null}
      <SalesDesk person={self ? undefined : d.person.id} canOpenErp={d.canOpenErp} today={false} />
      {fresh ? null : <div className={css.grid}>
        <Panel stripe="in" icon={FileText} title="Quotations" sub={`Sent in ${when}, and drafts started in it`}><div>
          {d.quotes.items.length ? <LineList label="Quotations">{d.quotes.items.map((x) => <LineRow key={x.id} href={quoteHref(x)}
            title={`${x.number ?? 'Draft quotation'}${x.buyer ? ` · ${x.buyer}` : ''}`} sub={x.issueDate ? date(x.issueDate) : 'Not sent yet'}
            amount={rupees(x.taxable)} amountSub={x.ownerApprovalNeeded ? <Badge tone="warning">Owner approval needed</Badge> : <Badge tone={TONE[x.status]}>{statusLabel(x.status)}</Badge>} />)}</LineList>
            : <Empty compact icon={FileText} title="No quotations in this period" text={self ? `${d.canOpenErp ? 'Quotations you make or send appear here.' : 'Quotations that name you appear here.'} Pick a longer period to see older ones.` : 'None made or sent by this person in the period.'} />}
        </div></Panel>
        <Panel stripe="in" icon={Receipt} title="Invoices" sub="Issued in the period, with what is still due"><div>
          {d.invoices.items.length ? <LineList label="Invoices">{d.invoices.items.map((x) => <LineRow key={x.id} href={d.canOpenErp ? `/erp/documents/${x.id}` : undefined}
            title={`${x.number}${x.buyer ? ` · ${x.buyer}` : ''}`} sub={`${date(x.issueDate)} · ${dueText(x.baseDue, x.gstDue)}`}
            amount={rupees(x.total)} amountSub={<Badge tone={TONE[x.status]}>{INVOICE_WORD[x.status] ?? statusLabel(x.status)}</Badge>} />)}</LineList>
            : <Empty compact icon={Receipt} title="No invoices in this period" text="An invoice made from your quotation is yours, with what the client still owes." />}
        </div></Panel>
      </div>}
    </div>
  </Page>;
}
