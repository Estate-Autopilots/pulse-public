import Link from "next/link";
import { PeopleCount } from "../home-views";
import { ChevronRight, Lock, ShieldAlert } from "lucide-react";
import type { HomeData, Insights } from "../lib/api";
import { count, day, periodLabel, periodQuery, plural, range } from "../lib/format";
import { BarList, Split, Stat } from "../charts";
import { FeedPanel, TopProjects } from "../home-views";
import { AttendancePanel, AttentionPanel, ClientsPanel, IdentityPanel, LocationsPanel, MixPanel, MoneyState, PipelinePanel, PodTeamHint, PodsPanel, SegmentsPanel, WeeklyColumns, issues } from "../insights";
import { PeriodSwitcher } from "../period-switcher";
import { Deck } from "../fit";
import dash from "../dashboard/dash.module.css";
import { Delta, Empty, Fit, Kpi, Page, PageHeader, Panel, QueryTabs, Spark, Tiles, Why, styles, viewNames, Workspace } from "../ui";

type Leadership = Extract<HomeData, { view: "leadership" }>;
export const TABS = [{ key: "overview", label: "Company pulse" }, { key: "delivery", label: "Delivery & quality" }, { key: "pods", label: `Pods & teams` }, { key: "clients", label: "Clients" },
  { key: "growth", label: "Growth" }, { key: "outcomes", label: "Lead outcomes" }, { key: "pipeline", label: "Our pipeline" }, { key: "performance", label: "Performance" }, { key: "people", label: "People" }, { key: "risks", label: "Risks" }, { key: "money", label: "Finance" }];
/** LIFECYCLE: People has views of its own (value against cost, role seats, staffing gaps). */
export const PEOPLE_VIEWS = [{ key: "overview", label: "Overview" }, { key: "value", label: "Value" }, { key: "seats", label: "Seats" }, { key: "staffing", label: "Staffing gaps" }];
const pct = (part: number, whole: number) => whole ? Math.round((part / whole) * 100) : 0;
const sum = (list: number[]) => list.reduce((n, v) => n + v, 0);

/** Risks leadership should know about, worst first: each one is a fact from the data with the place to act on it. */
function risks(d: Insights) {
  const out = issues(d).map((i) => ({ ...i })); const total = sum(d.clients.map((c) => c.count)) || 1;
  const named = d.clients.filter((c) => c.clientId); const top3 = sum(named.slice(0, 3).map((c) => c.count));
  const eight = sum(d.weeks.slice(-8).map((w) => w.deliveries));
  if (named.length >= 3 && pct(top3, eight) >= 40) out.push({ key: "concentration", Icon: ShieldAlert, tone: "warning", href: "/leadership?tab=clients", action: "See clients",
    title: `Three clients take ${pct(top3, eight)}% of the work`, detail: named.slice(0, 3).map((c) => c.name).join(", ") });
  const one = d.accounts[0];
  if (one && d.identity.recent && pct(one.recent, d.identity.recent) >= 80) out.push({ key: "onelogin", Icon: Lock, tone: "warning", href: "/people?tab=tracking", action: "See accounts",
    title: `One login carries ${pct(one.recent, d.identity.recent)}% of all uploads`, detail: `If ${one.account} is lost or locked, delivery stops and its history has no owner` });
  if (d.stages.quiet) out.push({ key: "quiet", Icon: ShieldAlert, tone: d.stages.quiet > d.stages.delivering ? "warning" : "neutral", href: "/projects?show=quiet", action: "Review",
    title: `${plural(d.stages.quiet, "project")} went quiet`, detail: `Delivered in the last 8 weeks, then nothing for 14 days; ${d.stages.delivering} are delivering` });
  void total;
  const order = { danger: 0, warning: 1, neutral: 2 } as const;
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

function RiskList({ data, limit }: { data: Insights; limit?: number }) {
  const list = risks(data);
  return (
    <Panel fill title="Risks" sub={`${list.length} open`} action={limit ? { href: "/leadership?tab=risks", label: "All" } : undefined}>
      {list.length ? <ul className={styles.attn}>{list.slice(0, limit ?? list.length).map((i) => (
        <li key={i.key}><Link href={i.href} className={styles.attnRow} data-tone={i.tone} title={`${i.title}. ${i.detail}`}>
          <span className={styles.attnIcon}><i.Icon size={15} strokeWidth={1.75} aria-hidden="true" /></span>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{i.title}</span><span className={styles.rowMeta}><span>{i.detail}</span></span></span>
          <span className={styles.attnAction}>{i.action}<ChevronRight size={13} aria-hidden="true" /></span>
        </Link></li>
      ))}</ul> : <Empty first icon={ShieldAlert} title="No open risk" text="Nothing in the data needs a decision from leadership today." />}
    </Panel>
  );
}

function ChartPanel({ title, sub, why, children, className }: { title: string; sub: string; why: string; children: React.ReactNode; className?: string }) {
  return <Panel fill className={className} title={title} sub={sub} tools={<Why detail={why} />}>{children}</Panel>;
}

export function LeadershipView({ data, insights: d, tab, orgName }: { data: Leadership; insights: Insights; tab?: string; orgName: string }) {
  const pq = periodQuery(data.period); const current = TABS.find((t) => t.key === tab)?.key ?? "overview";
  const weeks = d.weeks; const eight = weeks.slice(-8); const deliveries8 = sum(eight.map((w) => w.deliveries));
  const before = weeks.slice(0, 4); const usualBefore = sum(before.map((w) => w.deliveries)) / Math.max(1, before.length);
  const finalsPct = pct(sum(eight.map((w) => w.finals)), deliveries8); const revisedPct = pct(sum(eight.map((w) => w.revised)), deliveries8);
  const makers = d.teams.filter((t) => /creative|production/i.test(t.team)).reduce((n, t) => n + t.people, 0);
  const weekHref = (week: string) => `/leadership?week=${week}&tab=delivery`;
  const riskCount = risks(d).length;
  return (
    <Page fit>
      <PageHeader title="Leadership" context={[`${periodLabel(data.period)}, ${range(data.period.from, data.period.to)}`, `${orgName}, whole company`]} actions={<PeriodSwitcher period={data.period} />} />
      {current === "overview" ? <Deck tall={960} head={<QueryTabs base="/leadership" items={TABS} current={current} keep={pq.slice(1)} />}
        views={[
          { label: "Trend & risks", content: <><Tiles dense>
          <Kpi label="Deliveries" value={count(data.deliveries)} delta={<Delta value={data.deliveries} previous={data.deliveriesPrev} />} note={data.usual ? `Usual ${data.usual.toFixed(1)} a week` : "None yet"} href={`/leadership${periodQuery(data.period, { tab: "delivery" })}`}
            spark={<Spark values={weeks.map((w) => w.deliveries)} label="Deliveries per week, last 12 weeks" />} />
          <Kpi label="Projects delivering" value={d.stages.delivering} note={`${d.stages.quiet} quiet · ${d.stages.dormant} dormant`} href="/projects" spark={<Spark values={weeks.map((w) => w.projects)} label="Projects with deliveries per week" />} />
          <Kpi label="Active clients" value={d.portfolio.activeClients} delta={<Delta value={d.portfolio.activeClients} previous={d.portfolio.activeClientsBefore} />} note="8 weeks, vs the 8 before" href="/leadership?tab=clients" spark={<Spark values={weeks.map((w) => w.clients)} label="Clients with deliveries per week" />} />
          <Kpi label="Team" value={<PeopleCount headcount={d.people.headcount} ai={d.people.ai} />} note={d.attendanceEnabled === true ? `${d.people.inToday} in today · ${d.people.onLeave} on leave` : "Current members"} href="/leadership?tab=people" />
          <Kpi label="Credited to a person" value={`${pct(d.identity.credited, d.identity.recent)}%`} tone={d.identity.credited ? "success" : "warning"} note={`${pct(d.identity.shared, d.identity.recent)}% through shared logins`} href="/people?tab=tracking" />
          <Kpi label="Open risks" value={riskCount} tone={riskCount ? "warning" : "success"} note={riskCount ? "Each names where to act" : "Nothing to decide"} href="/leadership?tab=risks" />
        </Tiles><Fit className={dash.pair}>
          <ChartPanel className={styles.leadTrend} title="Deliveries per week" sub={`12 weeks · ${usualBefore.toFixed(0)} a week at the start, ${(deliveries8 / 8).toFixed(0)} now`} why="One delivery is one media file in a delivery folder, dated by its last change in Drive (Asia/Kolkata). The current week is still filling.">
            <WeeklyColumns data={d} pick={(w) => w.deliveries} label={(w) => `${plural(w.deliveries, "delivery", "deliveries")} · ${plural(w.projects, "project")}`} href={weekHref} />
          </ChartPanel>
            <RiskList data={d} limit={4} />
          </Fit></> },
          { label: `Clients, pipeline & pods`, content: <Fit className={dash.trio}><ClientsPanel data={d} /><PipelinePanel data={d} /><PodsPanel data={d} /></Fit> },
        ]} /> : <QueryTabs base="/leadership" items={TABS} current={current} keep={pq.slice(1)} />}
      {current === "delivery" ? <Workspace>
        <ChartPanel title="Deliveries" sub="Per week, 12 weeks" why="Media files landing in delivery folders, per week."><WeeklyColumns data={d} pick={(w) => w.deliveries} label={(w) => plural(w.deliveries, "delivery", "deliveries")} href={weekHref} /></ChartPanel>
        <ChartPanel title="Projects delivering" sub="Per week" why="Projects with at least one delivery in the week: how widely the work is spread."><WeeklyColumns data={d} pick={(w) => w.projects} label={(w) => `${plural(w.projects, "project")} · ${plural(w.clients, "client")}`} href={weekHref} /></ChartPanel>
        <ChartPanel title="Clients served" sub="Per week" why="Clients with at least one delivery in the week."><WeeklyColumns data={d} pick={(w) => w.clients} label={(w) => plural(w.clients, "client")} href={weekHref} /></ChartPanel>
        <Panel fill title="Quality signals" sub="Last 8 weeks" tools={<Why detail="Pulse reads Drive, so quality is only what the folders show: whether a file sits in a draft or a final folder, and whether it changed again after it landed." more="Review rounds, client feedback and approvals are not recorded anywhere Pulse can read yet." />}>
          <div className={styles.stats}><Stat label="Filed as final" value={`${finalsPct}%`} note={`${sum(eight.map((w) => w.drafts))} drafts seen`} /><Stat label="Changed after upload" value={`${revisedPct}%`} note={`${sum(eight.map((w) => w.revised))} of ${deliveries8} files`} /></div>
          <div className={styles.stats}><Stat label="Videos" value={sum(eight.map((w) => w.videos))} /><Stat label="Statics" value={sum(eight.map((w) => w.images))} /><Stat label="Files a week" value={(deliveries8 / 8).toFixed(1)} /></div>
          <p className={styles.panelFoot}>Almost everything is filed straight into a final folder, so drafts and review rounds are invisible today. A review step in Pulse would make quality measurable.</p>
        </Panel>
        <MixPanel data={d} />
        <FeedPanel data={data} href="/projects?show=active" fill title="Latest deliveries" />
      </Workspace> : null}
      {current === "pods" ? <Workspace>
        <PodsPanel data={d} wide />
        <Panel fill title="Teams" sub="Functions" tools={<PodTeamHint />} action={{ href: "/people", label: "Directory" }}>
          <BarList items={d.teams.map((t) => ({ key: t.team, label: t.team, sub: (t.pods ?? []).join(", ") || `no pod`, value: t.people, href: t.team === "No team" ? "/people" : `/people?team=${encodeURIComponent(t.team)}` }))} />
          <p className={styles.panelFoot}>A team is what someone does; a pod is whom they do it for. The pods a team’s people sit in are written beside it.</p>
        </Panel>
        <TopProjects data={data} href="/projects?show=active" fill title="Most active projects" />
      </Workspace> : null}
      {current === "clients" ? <Workspace>
        <ClientsPanel data={d} />
        <Panel fill title="Portfolio" sub={`${count(d.portfolio.clients)} clients on record`} action={{ href: "/clients", label: "Clients" }}>
          <Split unit="clients" parts={[{ key: "dev", label: "Developers", value: d.portfolio.developers, tone: "accent" }, { key: "cp", label: "Channel partners", value: d.portfolio.partners, tone: "success" }, { key: "none", label: "Type not set", value: d.portfolio.untyped, tone: "neutral" }]} />
          <div className={styles.stats}><Stat label="Active, 8 weeks" value={d.portfolio.activeClients} note={`${d.portfolio.activeClientsBefore} in the 8 before`} /><Stat label="Projects" value={count(d.portfolio.projects)} note={`${d.portfolio.projectsNoClient} without a client`} /></div>
          <div className={styles.stats}><Stat label="Largest client" value={`${pct(d.clients.find((c) => c.clientId)?.count ?? 0, deliveries8)}%`} note={d.clients.find((c) => c.clientId)?.name ?? "–"} /><Stat label="Files per active client" value={(deliveries8 / Math.max(1, d.portfolio.activeClients)).toFixed(1)} note="8 weeks" /></div>
        </Panel>
        <LocationsPanel data={d} />
        <SegmentsPanel data={d} />
      </Workspace> : null}
      {current === "people" ? <QueryTabs base="/leadership" keep="tab=people" param="view" sub current="overview" items={PEOPLE_VIEWS} /> : null}
      {current === "people" ? <Workspace>
        <Panel fill title="Capacity" sub="Team-level, 8 weeks" action={{ href: "/people?tab=tracking", label: "Tracking" }}
          tools={<Why detail="Deliveries divided by the people in Creative and Production. It is a team figure: with shared logins Pulse cannot tell how the work was split between them." />}>
          <div className={styles.stats}><Stat label="Files a week" value={(deliveries8 / 8).toFixed(1)} /><Stat label="Makers" value={makers} note="Creative and Production" /><Stat label="Per maker, a week" value={makers ? (deliveries8 / 8 / makers).toFixed(1) : "–"} /></div>
          <BarList items={d.teams.map((t) => ({ key: t.team, label: t.team, sub: d.attendanceEnabled === true ? `${t.inToday} in today` : undefined, value: t.people }))} />
        </Panel>
        <IdentityPanel data={d} />
        <Panel fill title="Sign-in and reporting" sub={`${d.people.headcount} people`} action={{ href: "/settings?tab=sign-in", label: "Settings" }}>
          <Split unit="people" parts={[{ key: "yes", label: "Can sign in", value: d.people.canSignIn, tone: "success" }, { key: "no", label: "No sign-in yet", value: d.people.headcount - d.people.canSignIn, tone: "warning" }]} />
          <Split unit="people" parts={[{ key: "yes", label: "Has a manager", value: d.people.withManager, tone: "success" }, { key: "no", label: "No manager set", value: d.people.headcount - d.people.withManager, tone: "neutral" }]} />
          <Split unit="people" parts={[{ key: "yes", label: `In a pod`, value: d.people.headcount - d.people.noPod, tone: "accent" }, { key: "no", label: `No pod`, value: d.people.noPod, tone: "neutral" }]} />
        </Panel>
        {d.attendanceEnabled === true ? <AttendancePanel data={d} /> : null}
      </Workspace> : null}
      {current === "risks" ? <Workspace>
        <RiskList data={d} />
        <AttentionPanel data={d} quietOnly />
        <PipelinePanel data={d} />
      </Workspace> : null}
      {current === "money" ? <Fit className={dash.pairEven}><MoneyState /></Fit> : null}
    </Page>
  );
}
viewNames({ RiskList });
