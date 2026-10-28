import Link from "next/link";
import { CalendarClock, ChevronRight, CircleCheck, FolderX, GitBranch, KeyRound, Lock, UserRoundX, Users, type LucideIcon } from "lucide-react";
import type { Insights } from "./lib/api";
import { count, day, plural } from "./lib/format";
import { BarList, Columns, SparseFacts, Split, Stat } from "./charts";
import { sparse } from "./lib/sparse.mjs";
import { Badge, Empty, Panel, Why, styles, viewNames } from "./ui";
import d from "./dashboard/dash.module.css";

import { POD_TEAM } from "./pod-team";
import { W } from "./kit/word";
export { POD_TEAM };
/** The one place the two words are explained; shown wherever both appear. */
import { PodTeamHint } from "./pod-team-hint";
export { PodTeamHint };

const pct = (part: number, whole: number) => whole ? Math.round((part / whole) * 100) : 0;
const daysSince = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 86400000));

type Issue = { key: string; Icon: LucideIcon; tone: "danger" | "warning" | "neutral"; title: string; detail: string; href: string; action: string };
/** What stands between the data Pulse has and a view leadership can trust; each one names where it is fixed. */
export function issues(d: Insights): Issue[] {
  const out: Issue[] = []; const { identity: id, people: p, hrQueue: q, portfolio: f } = d; const corrections = d.attendanceEnabled === true ? q.corrections : 0;
  if (id.recent && id.shared) out.push({ key: "shared", Icon: KeyRound, tone: id.shared === id.recent ? "danger" : "warning", href: "/people?tab=tracking", action: "Fix",
    title: `${pct(id.shared, id.recent)}% of deliveries come through shared logins`, detail: `${count(id.shared)} of ${count(id.recent)} files in 8 weeks cannot be credited to a person` });
  if (q.leave + corrections) out.push({ key: "queue", Icon: CalendarClock, tone: "warning", href: "/hr", action: "Decide",
    title: `${plural(q.leave + corrections, "request")} waiting for a decision`, detail: [q.leave ? plural(q.leave, "leave request") : "", corrections ? plural(corrections, "attendance correction") : ""].filter(Boolean).join(" · ") });
  if (p.headcount - p.canSignIn > 0) out.push({ key: "signin", Icon: UserRoundX, tone: "warning", href: "/settings?tab=sign-in", action: "Give sign-in",
    title: `${count(p.headcount - p.canSignIn)} of ${count(p.headcount)} people cannot sign in`, detail: d.attendanceEnabled === true ? "Without a sign-in they cannot check in, apply for leave or be credited" : "A sign-in lets them apply for leave and be credited for their work" });
  if (!p.withManager) out.push({ key: "managers", Icon: GitBranch, tone: "neutral", href: "/settings?tab=team", action: "Set",
    title: "No reporting lines yet", detail: "Managers approve leave and corrections; today only HR and admins can" });
  if (p.noPod) out.push({ key: "nopod", Icon: Users, tone: "neutral", href: "/people?pod=none", action: "Assign",
    title: `${plural(p.noPod, "person", "people")} without a pod`, detail: `They are left out of every pod comparison` });
  if (f.projectsNoClient) out.push({ key: "noclient", Icon: FolderX, tone: "neutral", href: "/projects", action: "Review",
    title: `${plural(f.projectsNoClient, "client-work project")} without a client`, detail: "They are missing from the client portfolio" });
  return out;
}

/** Needs attention: the issues to fix first, then the projects that have gone quiet, longest silence first. */
export function AttentionPanel({ data, quietOnly, issuesOnly, className }: { data: Insights; quietOnly?: boolean; /** Issues only: quiet projects are shown in their own panel. */ issuesOnly?: boolean; className?: string }) {
  const list = quietOnly ? [] : issues(data); const quiet = issuesOnly ? [] : [...data.quiet].sort((a, b) => a.lastDeliveredAt.localeCompare(b.lastDeliveredAt));
  const total = list.length + (issuesOnly ? 0 : data.quietTotal);
  return (
    <Panel fill className={className} title={quietOnly ? "Quiet projects" : "Needs attention"} sub={quietOnly ? `${data.quietTotal} · longest silence first` : issuesOnly ? `${list.length} to fix` : total ? `${list.length} to fix · ${data.quietTotal} quiet` : undefined}
      tools={<Why detail="Quiet: a project that delivered in the last 8 weeks and then nothing for 14 days or more." more="Pulse reads Drive only, so it cannot yet tell a paused project from a blocked one." />}
      action={data.quietTotal && !issuesOnly ? { href: "/projects?show=quiet", label: "All" } : undefined}>
      {total ? <>
        <ul className={styles.attn}>{list.map((i) => (
          <li key={i.key}><Link href={i.href} className={styles.attnRow} data-tone={i.tone} title={`${i.title}. ${i.detail}`}>
            <span className={styles.attnIcon}><i.Icon size={15} strokeWidth={1.75} aria-hidden="true" /></span>
            <span className={styles.rowMain}><span className={styles.rowTitle}>{i.title}</span><span className={styles.rowMeta}><span>{i.detail}</span></span></span>
            <span className={styles.attnAction}>{i.action}<ChevronRight size={13} aria-hidden="true" /></span>
          </Link></li>
        ))}</ul>
        {quiet.length && !quietOnly ? <div className={styles.subhead}><span>Quiet projects</span><span>days without a delivery</span></div> : null}
        <ul className={styles.list}>{quiet.map((q) => { const n = daysSince(q.lastDeliveredAt, data.generatedAt); return (
          <li key={q.projectId}><Link href={`/projects/${q.projectId}`} className={styles.row} title={q.projectName}>
            <span className={styles.rowMain}><span className={styles.rowTitle}>{q.title}</span>
              <span className={styles.rowMeta}>{q.clientName ? <span>{q.clientName}</span> : null}<span>last {day(q.lastDeliveredAt)}</span><span>{q.recent} in 8 wk</span></span></span>
            <span className={styles.quiet} data-long={n >= 28 ? "" : undefined}><b>{n}</b><i aria-hidden="true"><u style={{ width: `${Math.min(100, (n / 56) * 100)}%` }} /></i></span>
          </Link></li>
        ); })}</ul>
      </> : <Empty first icon={CircleCheck} title="Nothing needs attention" text="No open issue, and every project that delivered in the last eight weeks delivered in the last 14 days." />}
    </Panel>
  );
}

export function MixPanel({ data, className }: { data: Insights; className?: string }) {
  const total = data.mix.reduce((n, m) => n + m.count, 0);
  return (
    <Panel fill className={className} title="Creative mix" sub="Last 8 weeks" tools={<Why detail="What each delivered file is, read from its name: “Hook 3” is a hook variation, “No Hook” the main film, an image a static." more="Files named differently fall under “Other video”. Naming files the same way everywhere makes this exact." />}>
      <BarList total={total} items={data.mix.map((m) => ({ key: m.type, label: m.type, value: m.count }))} empty="No deliveries in the last eight weeks." />
    </Panel>
  );
}

export function SegmentsPanel({ data }: { data: Insights }) {
  const total = data.weeks.slice(-8).reduce((n, w) => n + w.deliveries, 0);
  return <Panel fill title="By segment" sub="Last 8 weeks" tools={<Why detail="The segment written at the end of each project folder name: R residential, Lux luxury, P plotting, C commercial, and combinations." />}>
    <BarList total={total} items={data.segments.map((s) => ({ key: s.segment, label: s.segment, sub: plural(s.projects, "project"), value: s.count }))} /></Panel>;
}

export function LocationsPanel({ data }: { data: Insights }) {
  return <Panel fill title="By location" sub="Last 8 weeks" tools={<Why detail="The place written in each project folder name. Projects without one are counted under “Not set”." />}>
    <BarList items={data.locations.map((s) => ({ key: s.location, label: s.location, sub: plural(s.projects, "project"), value: s.count }))} /></Panel>;
}

export function ClientsPanel({ data }: { data: Insights }) {
  const total = data.weeks.slice(-8).reduce((n, w) => n + w.deliveries, 0);
  return (
    <Panel fill title="Clients" sub="Last 8 weeks" action={{ href: "/clients", label: "All" }}
      tools={<Why detail="Deliveries in the last eight weeks, by the client of each project." more="The share shows how much of the work one client takes." />}>
      <BarList total={total} items={data.clients.map((c) => ({ key: c.clientId ?? "none", label: c.name, sub: plural(c.projects, "project"), value: c.count, href: c.clientId ? `/clients/${c.clientId}` : "/projects" }))} empty="No deliveries in the last eight weeks." />
    </Panel>
  );
}

/** Pods side by side. Teams are listed inside each pod so the two are never confused. */
export function PodsPanel({ data, wide, className }: { data: Insights; wide?: boolean; className?: string }) {
  const assigned = data.pods.some((p) => p.projects); const maxPeople = Math.max(1, ...data.pods.map((p) => p.people));
  return (
    <Panel fill className={className} title={`Pods side by side`} sub="Client delivery units" tools={<PodTeamHint />} action={{ href: "/settings?tab=team", label: "Manage" }}
      foot={assigned ? undefined : <><span>No project has a <W k="team" lc /> yet, so deliveries cannot be split.</span><Link href="/projects">Assign in Projects</Link></>}>
      {wide ? <div className={`${styles.pods} ${d.podCards}`} data-items="">{data.pods.map((p) => (
        <Link key={p.pod} href={p.pod === "No pod" ? "/people?pod=none" : `/people?pod=${encodeURIComponent(p.pod)}`} className={styles.pod} data-none={p.pod === "No pod" ? "" : undefined}>
          <span className={styles.podName}>{p.pod}</span>
          <span className={styles.podFigure}><b>{p.people}</b> {p.people === 1 ? "person" : "people"}</span>
          <dl className={styles.podFacts}>
            {data.attendanceEnabled === true ? <div><dt>In today</dt><dd>{p.inToday}{p.onLeave ? <small> · {p.onLeave} away</small> : null}</dd></div> : null}
            <div><dt>Projects</dt><dd>{assigned ? p.projects : "–"}</dd></div>
            <div><dt>Deliveries, 8 wk</dt><dd>{assigned ? p.deliveries : "–"}</dd></div>
          </dl>
          <span className={styles.podTeams}>{(p.teams ?? []).length ? p.teams!.join(" · ") : "No team set"}</span>
        </Link>
      ))}</div> : <div className={styles.tableWrap} style={{ borderTop: 0 }}><table className={`${styles.table} ${styles.tableDense}`}>
        <thead><tr><th><W k="team" /></th><th className={styles.right}>People</th>{data.attendanceEnabled === true ? <th className={styles.right}>In today</th> : null}<th className={styles.right}>Projects</th><th className={styles.right} title="Deliveries in the last 8 weeks">8 wk</th></tr></thead>
        <tbody>{data.pods.map((p) => (
          <tr key={p.pod}><td><Link className={styles.cellLink} href={p.pod === "No pod" ? "/people?pod=none" : `/people?pod=${encodeURIComponent(p.pod)}`}>{p.pod}</Link></td>
            <td className={styles.right}><span className={styles.cellBar}><i style={{ width: `${(p.people / maxPeople) * 100}%` }} /></span>{p.people}</td>
            {data.attendanceEnabled === true ? <td className={styles.right}>{p.inToday}</td> : null}<td className={styles.right}>{assigned ? p.projects : "–"}</td><td className={styles.right}>{assigned ? p.deliveries : "–"}</td></tr>
        ))}</tbody>
      </table></div>}
    </Panel>
  );
}

/** The last 14 days of check-ins as columns that take the panel's height; weekends and holidays are hatched, today is written out. */
export function AttendancePanel({ data, className }: { data: Insights; className?: string }) {
  if (data.attendanceEnabled !== true) return null;
  const p = data.people; const attendance = data.attendance ?? []; const max = Math.max(1, p.canSignIn, ...attendance.map((a) => a.in)); const waiting = data.hrQueue.leave + data.hrQueue.corrections;
  return (
    <Panel fill className={className} title="Attendance" sub="Last 14 days" action={{ href: "/hr", label: "HR desk" }}
      tools={<Why detail="People checked in per day over the last 14 days. Sundays and holidays are hatched." more={p.canSignIn < p.headcount ? `Only ${plural(p.canSignIn, "person", "people")} of ${p.headcount} can sign in today, so this covers them alone.` : undefined} />}>
      <div className={styles.stats}><Stat label="In today" value={p.inToday} /><Stat label="On leave" value={p.onLeave} /><Stat label="To decide" value={waiting} tone={waiting ? "warning" : undefined} /></div>
      {sparse(attendance, (a) => a.in) ? <SparseFacts label="People checked in per day, last 14 days" total={attendance.length} empty="Nobody checked in during the last 14 days."
        facts={(sparse(attendance, (a) => a.in) ?? []).map((a) => ({ key: a.day, n: a.in, value: a.in, text: `checked in on ${day(a.day)}`, sub: [a.home ? `${a.home} from home` : "", a.late ? `${a.late} late` : "", `of ${p.canSignIn} who can sign in`].filter(Boolean).join(" · ") }))} /> :
      <div className={d.days} role="img" aria-label={`People checked in per day, last 14 days: ${attendance.map((a) => `${day(a.day)} ${a.in}`).join(", ")}`}>
        {attendance.map((a) => { const today = a.day === data.period.today; return (
          <span key={a.day} className={d.day} data-off={a.dow === 7 || a.holiday ? "" : undefined} data-today={today ? "" : undefined} title={`${day(a.day)}: ${a.in} in${a.home ? `, ${a.home} from home` : ""}${a.late ? `, ${a.late} late` : ""}${a.leave ? `, ${a.leave} on leave` : ""}${a.holiday ? " · holiday" : ""}`}>
            <b>{today ? a.in : ""}</b><i><u style={{ height: `${(a.in / max) * 100}%` }} /></i><small>{"MTWTFSS"[a.dow - 1]}</small>
          </span>
        ); })}
      </div>}
    </Panel>
  );
}

/** Where every project stands by its last delivery. */
export function PipelinePanel({ data, className }: { data: Insights; className?: string }) {
  const s = data.stages;
  return (
    <Panel fill className={className} title="Project pipeline" sub={`${count(data.portfolio.projects)} projects`} action={{ href: "/projects", label: "Projects" }}
      tools={<Why detail="Where every project stands by its last delivery: delivering (within 14 days), quiet (14 to 56 days), dormant (longer)." more="Projects with no delivery on record are mostly older folders and shoots that never reached a delivery folder." />}>
      <Split unit="projects" parts={[
        { key: "delivering", label: "Delivering", value: s.delivering, tone: "success" }, { key: "quiet", label: "Quiet", value: s.quiet, tone: "warning" },
        { key: "dormant", label: "Dormant", value: s.dormant, tone: "neutral" }]} />
      <ul className={d.stages}>{([["delivering", "Delivering", s.delivering, "success", "Delivered in the last 14 days"], ["quiet", "Quiet", s.quiet, "warning", "Last delivery 14 to 56 days ago"],
        ["dormant", "Dormant", s.dormant, "neutral", "Nothing for more than 56 days"], [null, "Never delivered", s.noDeliveries, "neutral", "No delivery file on record"]] as const).map(([key, label, value, tone, note]) => {
        const body = <><span className={styles.stateDot} data-tone={tone} /><span className={d.stageText}><b>{label}</b><small>{note}</small></span><span className={d.stageValue}>{count(value)}</span>{key ? <ChevronRight size={14} aria-hidden="true" /> : <span />}</>;
        return <li key={label}>{key ? <Link href={`/projects?stage=${key}&view=list`} className={d.stage}>{body}</Link> : <div className={d.stage}>{body}</div>}</li>;
      })}</ul>
    </Panel>
  );
}

/** Teams are what people do; the pods their people sit in are written beside each. */
export function TeamsPanel({ data, className }: { data: Insights; className?: string }) {
  return (
    <Panel fill className={className} title="Teams" sub="Functions" tools={<PodTeamHint />} action={{ href: "/people", label: "Directory" }}
      foot={<span>A team is what someone does; a pod is whom they do it for.</span>}>
      <BarList items={data.teams.map((t) => ({ key: t.team, label: t.team, sub: (t.pods ?? []).join(", ") || `no pod`, value: t.people, href: t.team === "No team" ? "/people" : `/people?team=${encodeURIComponent(t.team)}` }))} />
    </Panel>
  );
}

/** How ready the people records are: who can sign in, who has a manager, who sits in a pod. */
export function ReadinessPanel({ data, className }: { data: Insights; className?: string }) {
  const p = data.people;
  return (
    <Panel fill className={className} title="Sign-in and reporting" sub={`${p.headcount} people`} action={{ href: "/settings?tab=sign-in", label: "Settings" }}>
      <div className={d.block}><span className={d.blockLabel}>Sign-in</span><Split unit="people" parts={[{ key: "yes", label: "Can sign in", value: p.canSignIn, tone: "success" }, { key: "no", label: "No sign-in yet", value: p.headcount - p.canSignIn, tone: "warning" }]} /></div>
      <div className={d.block}><span className={d.blockLabel}>Reporting line</span><Split unit="people" parts={[{ key: "yes", label: "Has a manager", value: p.withManager, tone: "success" }, { key: "no", label: "No manager set", value: p.headcount - p.withManager, tone: "neutral" }]} /></div>
      <div className={d.block}><span className={d.blockLabel}><W k="team" /></span><Split unit="people" parts={[{ key: "yes", label: `In a pod`, value: p.headcount - p.noPod, tone: "accent" }, { key: "no", label: `No pod`, value: p.noPod, tone: "neutral" }]} /></div>
    </Panel>
  );
}

export function MoneyTeaser({ fill, compact }: { fill?: boolean; compact?: boolean }) {
  return (
    <Panel fill={fill} title="Finance" sub={<span className={styles.inlineLock}><Lock size={11} aria-hidden="true" />Leadership only</span>} action={{ href: "/finance", label: "Open Finance" }}>
      <div className={styles.money}>
        <p>{compact ? "Cash flow, spend, renewals and revenue are in Finance, counted from reconciled ledger entries." : "Cash flow, spend, subscriptions, renewals and client revenue are in Finance, counted from ledger entries leadership has reconciled."}</p>
        {compact ? null : <ul><li>Revenue this month</li><li>Costs and tools</li><li>Renewals due</li></ul>}
      </div>
    </Panel>
  );
}

const MONEY = [["Overview", "Cash in and out by month, runway, what needs review", "overview"], ["Spend", "Categories and vendors, month by month", "spend"], ["Subscriptions & tools", "Renewal calendar, seats and contracts", "subscriptions"],
  ["Payroll cost", "Salary cost trend, in total only", "payroll"], ["Revenue & clients", "Client lifetime revenue and repeat clients", "revenue"], ["Budget", "Next month's plan from reconciled spending", "budget"], ["Ledger", "Reconcile entries, categories and project matches", "ledger"]] as const;
/** Finance has its own private, audited workspace; the dashboard points there and shows no figure itself. */
export function MoneyState() {
  return <>
    <section className={`${styles.panel} ${d.calm}`}>
      <span className={d.calmIcon}><Lock size={20} strokeWidth={1.75} aria-hidden="true" /></span>
      <h3>Finance has its own workspace</h3>
      <p>Cash flow, spend, subscriptions, payroll cost, revenue and the budget live in Finance, for leadership with finance access. Totals count only ledger entries someone has reconciled, so they start once the ledger is reviewed.</p>
      <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/finance">Open Finance</Link>
      <small>Every view of Finance is recorded. Figures never appear for other roles, in notifications or in exports.</small>
    </section>
    <Panel fill title="In Money" sub="Seven views">
      <ul className={`${styles.list} ${d.rows}`}>{MONEY.map(([t, text, tab]) => (
        <li key={t}><Link href={tab === "overview" ? "/finance" : `/finance?tab=${tab}`} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{t}</span><span className={styles.rowMeta}><span>{text}</span></span></span><ChevronRight size={14} aria-hidden="true" className={styles.muted} /></Link></li>
      ))}</ul>
    </Panel>
  </>;
}

/** Who the work is credited to: honest about how much of it reaches Pulse through logins several people share. */
export function IdentityPanel({ data, className }: { data: Insights; className?: string }) {
  const id = data.identity;
  return (
    <Panel fill className={className} title="Who delivered" sub="Last 8 weeks" action={{ href: "/people?tab=tracking", label: "Tracking" }}
      tools={<Why detail="Drive records the account that uploaded a file. When several people share one login, Pulse knows the login, not the person." more="Credit appears as soon as each person uploads from an account of their own that is linked to their record." />}>
      <Split unit="files" parts={[
        { key: "credited", label: "Credited to a person", value: id.credited, tone: "success" },
        { key: "shared", label: "Shared login", value: id.shared, tone: "warning" },
        { key: "unlinked", label: "Account not linked", value: id.unlinked, tone: "neutral" }]} />
      <div className={styles.stats}><Stat label="Files, 8 weeks" value={count(id.recent)} /><Stat label="Shared logins" value={id.sharedLogins} tone={id.sharedLogins ? "warning" : undefined} /><Stat label="Accounts not linked" value={id.unlinkedAccounts} /></div>
      <ul className={`${styles.list} ${d.rows}`}>{data.accounts.filter((a) => a.recent || a.total > 20).map((a) => (
        <li key={a.account}><Link href={`/people/accounts/${encodeURIComponent(a.account)}`} className={styles.row}>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{a.person ?? a.account}</span>
            <span className={styles.rowMeta}><span>{a.shared ? "Shared login" : a.person ? a.account : "Not linked to a person"}</span><span>{count(a.total)} all time</span></span></span>
          <span className={styles.rowEnd}>{a.shared ? <Badge tone="warning">Shared</Badge> : a.person ? <Badge tone="success">Linked</Badge> : <Badge>Unlinked</Badge>}<span className={styles.rowValue}>{a.recent}</span></span>
        </Link></li>
      ))}</ul>
    </Panel>
  );
}

/** Weekly deliveries, optionally another weekly figure, as columns that link to the week. */
export function WeeklyColumns({ data, pick, label, suffix, max, href, steps }: { steps?: 2 | 4; data: Insights; pick: (w: Insights["weeks"][number]) => number; label: (w: Insights["weeks"][number]) => string; suffix?: string; max?: number; href?: (week: string) => string }) {
  const last = data.weeks.length - 1;
  return <Columns label="Per week, last 12 weeks" suffix={suffix} max={max} steps={steps} items={data.weeks.map((w, i) => ({ key: w.week, label: day(w.start), value: pick(w), on: i === last,
    tip: label(w), tipSub: `Week ${Number(w.week.slice(-2))} · from ${day(w.start)}`, href: href?.(w.week), muted: !w.deliveries }))} />;
}
viewNames({ AttentionPanel, MixPanel, SegmentsPanel, LocationsPanel, ClientsPanel, PodsPanel, AttendancePanel, IdentityPanel });
