import Link from "next/link";
import { BarChart3, Hourglass, Sparkles, Target, Trophy } from "lucide-react";
import { api, getMe, teamWords } from "../../lib/api";
import { plural } from "../../lib/format";
import { Avatar, Badge, Message, Page, PageHeader, styles } from "../../ui";
import { KpiProgress, LogTime, TaskRow, TimeProposals } from "../client";
import { shortDay } from "../parts";
import { DayCalendar, Spark, ValueByWeek, WeekColumns } from "../outcome-charts";
import o from "../outcomes.module.css";
import type { Task } from "../types";
import { TaskSignals, type Help, type Signals } from "../signals";
import css from "../tasks.module.css";

type Outcomes = { today: string; week: string; self: boolean;
  profile: { id: string; name: string; role: string | null; pod: string | null; photoAt: string | null; workMode: "shift" | "outcome"; roleTitle: string | null; roleStatus: string | null; hoursMin: number | null; hoursMax: number | null; officeMin: number | null; officeMax: number | null; otherRoles: string[] | null; note: string | null };
  weeks: { week: string; minutes: number; proposed: number; done: number }[]; byProject: { projectId: string | null; name: string; minutes: number | null; proposed: number | null }[];
  value: Task[]; open: Task[]; done: { n: number; accepted: number }; domains?: { id: string; title: string; basis: string; status: string }[];
  kpis: { id: string; area: string | null; title: string; target: string | null; measure: string | null; dueOn: string | null; progress: number | null; status: string; note: string | null; source: string; updatedAt: string; updatedBy: string | null }[];
  proposals: { n: number; minutes: number }; charts?: Charts; signals?: Signals; help?: Help };
type Series = { key: string; label: string; values: number[] };
type Charts = { weeks: string[]; value: number[]; byProject: Series[]; byDomain: Series[]; tasks: { accepted: number; waiting: number }[]; hours: { week: string; confirmed: number; proposed: number }[];
  hoursByProject: { projectId: string | null; name: string; minutes: number }[];
  extra: { points: number; weeks: number[]; plan: { usual: number | null; above: number }[]; reasons: { outside_domains: number; pool: number; volunteered: number; above_plan: number }; hasDomains: boolean; share: number;
    items: { taskId: string; title: string; points: number; reasons: string[]; day: string; projectName: string | null }[] };
  streaks: { weeks: number; bestWeeks: number; days: number; bestDays: number; calendar: { day: string; done: number }[] };
  accepted: { points: number; tasks: number; extra: number }; pending: { points: number; tasks: number; items: { id: string; title: string; points: number | null; reviewer: string | null; doneOn: string }[] } };
type TeamRow = { id: string; name: string; pod: string | null; role: string | null; photoAt: string | null; values: number[]; value: number; usual: number | null; extraWeek: number; extra8: number; done: number; pending: number; minutes: number; streak: number;
  /** TASKS-4B: help given, as totals (never ranked). */ help?: { answered: number; helpful: number; somewhat: number; notHelpful: number } | null };
type TimeRows = { rows: { id: string; date: string; minutes: number; note: string | null; source: string; status: string; taskTitle: string | null; projectName: string | null }[] };
const KPI: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "accent" }> = { not_started: { label: "Not started", tone: "neutral" }, on_track: { label: "On track", tone: "success" }, at_risk: { label: "At risk", tone: "warning" }, behind: { label: "Behind", tone: "danger" }, met: { label: "Met", tone: "success" }, missed: { label: "Missed", tone: "danger" } };
const h = (m: number) => (m / 60).toFixed(m % 60 ? 1 : 0);
const range = (a: number | null, b: number | null, unit: string) => a === null && b === null ? null : a === b || b === null ? `${a} ${unit}` : `${a}–${b} ${unit}`;

const REASON: Record<string, string> = { outside_domains: "Outside your domains", pool: "Claimed from the pool", volunteered: "Taken on yourself", above_plan: "Above your usual week" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };

/** TASKS-3: what a person delivered, clearly: this week against their usual week, accepted work per week by project or
 *  domain, tasks done (accepted or waiting), hours, extra work and why it counts, streaks, and accepted vs pending.
 *  INTEGRITY (owner, 22 Oct 2026): tasks carry no value points; the numbers are tasks someone else accepted, one each.
 *  Outcome-based people are also measured by KPIs; their time comes from work, not punches. Leaders get the same
 *  summary per person. */
export default async function OutcomesPage({ searchParams }: { searchParams: Promise<{ person?: string; view?: string }> }) {
  const { person, view } = await searchParams;
  const me = (await getMe()).data;
  const leads = !!me && ["admin", "leadership", "hr"].includes(me.role);
  if (view === "team") return <TeamOutcomes />;
  const r = await api<Outcomes>(`outcomes${person ? `?person=${encodeURIComponent(person)}` : ""}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!; const p = d.profile; const c = d.charts;
  const time = d.self ? (await api<TimeRows>("time")).data : undefined;
  const rhythm = [range(p.hoursMin, p.hoursMax, "h a week"), range(p.officeMin, p.officeMax, p.officeMax === 1 ? "office day" : "office days")].filter(Boolean).join(" · ");
  const metOrOn = d.kpis.filter((k) => ["on_track", "met"].includes(k.status)).length;
  const now = c ? c.weeks.length - 1 : 0;
  const valueNow = c?.value[now] ?? 0, usual = c?.extra.plan[now]?.usual ?? null, extraNow = (c?.extra.weeks[now] ?? 0) + (c?.extra.plan[now]?.above ?? 0);
  const doneNow = c ? c.tasks[now].accepted + c.tasks[now].waiting : 0, minutesNow = c?.hours[now]?.confirmed ?? 0;
  const you = d.self ? "you" : p.name.split(" ")[0];
  const sentence = c ? [`This week ${you} finished ${plural(doneNow, "task")}, and ${plural(valueNow, "task was", "tasks were")} accepted${usual !== null ? ` (a usual week is ${usual})` : ""}.`,
    extraNow ? `${extraNow} of them count as extra work.` : null, c.pending.tasks ? `${plural(c.pending.tasks, "task waits", "tasks wait")} for acceptance.` : null,
    c.streaks.weeks > 1 ? `${c.streaks.weeks} weeks in a row with something finished.` : null].filter(Boolean).join(" ") : null;
  const reasonTotal = c ? Math.max(1, ...Object.values(c.extra.reasons)) : 1;
  return (
    <Page>
      <PageHeader title={d.self ? "My outcomes" : `${p.name} · outcomes`} back={{ href: "/tasks", label: "Work" }}
        context={[p.roleTitle ?? p.role, p.workMode === "outcome" ? "Outcome-based" : "Shift", rhythm || null]}
        actions={<>{leads ? <span className={o.seg} role="group" aria-label="Whose outcomes"><Link href="/tasks/outcomes" aria-current={!person ? "true" : undefined}>Me</Link><Link href="/tasks/outcomes?view=team">Team</Link></span> : null}
          {!d.self ? <Link className={styles.btn} href={`/people/${p.id}`}>Profile</Link> : null}</>} />
      <div className={`${o.viz} ${o.page}`}>
        <section className={o.card} aria-label="Summary">
          <div className={o.hero}>
            <div>
              <div className={o.who}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={46} /><span><h2>{p.name}</h2><p>{[p.roleTitle ?? p.role, p.pod].filter(Boolean).join(" · ")}</p></span></div>
              <div className={o.big}><b>{valueNow}</b><span>accepted this week</span>{usual !== null ? <span className={o.delta} data-tone={valueNow > usual ? "up" : undefined}>{valueNow > usual ? `${valueNow - usual} above a usual week` : valueNow < usual ? `${usual - valueNow} below a usual week` : "Same as a usual week"}</span> : null}</div>
              {sentence ? <p className={o.sentence}>{sentence}</p> : null}
            </div>
            <div className={o.tiles}>
              <span className={o.tile}><b>{doneNow}</b><span>finished this week</span></span>
              <span className={o.tile}><b>{c?.accepted.tasks ?? d.done.accepted}</b><span>accepted in all</span></span>
              <span className={o.tile} data-tone="extra"><b>{extraNow}</b><span>extra this week</span></span>
              <span className={o.tile} data-tone="wait"><b>{c?.pending.tasks ?? 0}</b><span>waiting for acceptance</span></span>
              <span className={o.tile}><b>{h(minutesNow)}</b><span>hours this week</span></span>
            </div>
          </div>
        </section>
        {c ? <ValueByWeek weeks={c.weeks} byProject={c.byProject} byDomain={c.byDomain} note="One per task someone else accepted. Tasks carry no value points, so nobody moves this number alone." /> : null}
        {c ? <div className={o.cards2}>
          {/* TASKS-4B: the person's record, kindly (leadership: outcomes, not ratings). */}
          {d.signals ? <TaskSignals s={d.signals} help={d.help} self={d.self} name={d.profile.name} /> : null}
          <section className={o.card} aria-labelledby="done-title"><div className={o.cardHead}><h2 id="done-title">Tasks finished per week</h2><small>accepted · waiting for acceptance</small></div>
            <div className={o.cardBody}><WeekColumns title="Tasks finished per week" weeks={c.weeks} unit="tasks" series={[{ key: "accepted", label: "Accepted", values: c.tasks.map((t) => t.accepted), slot: 3 }, { key: "waiting", label: "Waiting", values: c.tasks.map((t) => t.waiting), slot: 3, faint: true }]} /></div></section>
          <section className={o.card} aria-labelledby="hours-title"><div className={o.cardHead}><h2 id="hours-title">Hours per week</h2><small>confirmed · proposed</small></div>
            <div className={o.cardBody}><WeekColumns title="Hours per week" weeks={c.weeks} unit="h" series={[{ key: "confirmed", label: "Confirmed", values: c.hours.map((x) => x.confirmed), slot: 1 }, { key: "proposed", label: "Proposed", values: c.hours.map((x) => x.proposed), slot: 1, faint: true }]} />
              {c.hoursByProject.length ? <ul className={o.items}>{c.hoursByProject.map((x) => <li key={x.projectId ?? x.name}>{x.projectId ? <Link href={`/tasks/projects/${x.projectId}`}>{x.name}</Link> : <span>{x.name}</span>}<span className={o.pts}>{h(x.minutes)} h</span></li>)}</ul> : null}</div></section>
        </div> : null}
        {c ? <div className={o.cards3}>
          <section className={o.card} aria-labelledby="extra-title"><div className={o.cardHead}><h2 id="extra-title"><Sparkles size={15} aria-hidden="true" />Extra work</h2><small>{plural(c.extra.points + c.extra.plan.reduce((n, x) => n + x.above, 0), "task")} in 12 weeks{c.extra.share ? ` · ${c.extra.share}% of accepted work` : ""}</small></div>
            <div className={o.cardBody}>
              <ul className={o.reasons}>{Object.entries(c.extra.reasons).map(([k, v]) => <li key={k}><span>{REASON[k]}</span><b>{v}</b><span className={o.meter} aria-hidden="true"><i style={{ width: `${Math.round((100 * v) / reasonTotal)}%` }} /></span></li>)}</ul>
              {c.extra.items.length ? <ul className={o.items}>{c.extra.items.slice(0, 6).map((x) => <li key={x.taskId}><Link href={`/tasks/${x.taskId}`} title={x.title}>{x.title}</Link><span className={o.pts}>+{x.points}</span>
                <small>{x.reasons.map((r) => REASON[r]).join(" · ")} · {day(x.day)}{x.projectName ? ` · ${x.projectName}` : ""}</small></li>)}</ul>
                : <p className={o.empty}>Nothing extra yet. Work outside {c.extra.hasDomains ? "your domains" : "the domains you agree"}, tasks claimed from the pool or taken on yourself, and weeks above your usual show here once someone accepts them.</p>}
              <p className={o.empty}>Your usual week is the middle of your previous eight weeks; anything above it counts as extra.</p>
            </div></section>
          <section className={o.card} aria-labelledby="pending-title"><div className={o.cardHead}><h2 id="pending-title"><Hourglass size={15} aria-hidden="true" />Accepted and waiting</h2></div>
            <div className={o.cardBody}>
              <div className={o.pair}><div><b>{c.accepted.tasks}</b><span>accepted</span></div><div><b>{c.pending.tasks}</b><span>waiting</span></div></div>
              <span className={o.split} role="img" aria-label={`${c.accepted.tasks} tasks accepted, ${c.pending.tasks} waiting`}>
                <i data-part="accepted" style={{ width: `${Math.round((100 * c.accepted.tasks) / Math.max(1, c.accepted.tasks + c.pending.tasks))}%` }} /><i data-part="waiting" style={{ flex: 1 }} /></span>
              {c.pending.items.length ? <ul className={o.items}>{c.pending.items.slice(0, 6).map((x) => <li key={x.id}><Link href={`/tasks/${x.id}`} title={x.title}>{x.title}</Link><span className={o.pts} data-tone="wait">waiting</span>
                <small>Done {day(x.doneOn)} · waiting for {x.reviewer ? x.reviewer.split(" ")[0] : "leadership"}</small></li>)}</ul> : <p className={o.empty}>Nothing waits for acceptance.</p>}
            </div></section>
          <section className={o.card} aria-labelledby="streak-title"><div className={o.cardHead}><h2 id="streak-title"><Trophy size={15} aria-hidden="true" />Streaks</h2><small>Sundays are skipped</small></div>
            <div className={o.cardBody}>
              <div className={o.streaks}><div><b>{c.streaks.weeks}</b><span>weeks in a row · best {c.streaks.bestWeeks}</span></div><div><b>{c.streaks.days}</b><span>working days in a row · best {c.streaks.bestDays}</span></div></div>
              <DayCalendar days={c.streaks.calendar} />
            </div></section>
        </div> : null}
        <div className={o.cards2}>
          <section className={o.card} aria-label="KPIs"><div className={o.cardHead}><h2><Target size={15} aria-hidden="true" />KPIs</h2><small>{d.kpis.length ? `${metOrOn} of ${d.kpis.length} on track` : null}</small></div>
            <div className={o.cardBody}>{d.kpis.length ? <ul className={css.kpis}>{d.kpis.map((k) => <li key={k.id} className={css.kpi}>
              <b>{k.title}</b><span className={css.meta}><Badge tone={KPI[k.status]?.tone}>{KPI[k.status]?.label ?? k.status}</Badge><KpiProgress kpi={k} /></span>
              <span className={css.meter} aria-label={`${k.progress ?? 0}% done`}><i style={{ width: `${k.progress ?? 0}%` }} /></span>
              <p>{[k.target ? `Target: ${k.target}` : null, k.measure ? `Measured by ${k.measure}` : null, k.dueOn ? `by ${shortDay(k.dueOn)} ${k.dueOn.slice(0, 4)}` : null].filter(Boolean).join(" · ")}</p>
              {k.note ? <p>Latest: {k.note}{k.updatedBy ? ` (${k.updatedBy})` : ""}</p> : null}</li>)}</ul> : <p className={o.empty}>No KPIs yet. HR or leadership adds them from the role terms; progress is updated here with evidence.</p>}</div></section>
          {d.self ? <section className={o.card} aria-label="Time to confirm"><div className={o.cardHead}><h2><BarChart3 size={15} aria-hidden="true" />Time to confirm</h2><small>{d.proposals.n ? `${plural(d.proposals.n, "entry", "entries")} · ${h(d.proposals.minutes)} h` : null}</small></div>
            <div className={o.cardBody}><TimeProposals rows={time?.rows ?? []} /><LogTime today={d.today} /></div></section>
            : <section className={o.card} aria-label="Open tasks"><div className={o.cardHead}><h2>Open tasks</h2><small>{d.open.length || null}</small></div>
              <div className={o.cardBody}>{d.open.length ? <ul className={css.list}>{d.open.slice(0, 12).map((t) => <TaskRow key={t.id} task={t} today={d.today} me={null} showAssignee={false} />)}</ul> : <p className={o.empty}>Nothing open.</p>}</div></section>}
        </div>
      </div>
    </Page>
  );
}

/** Leaders: each person's week against their usual week, extra and waiting, without ranking anyone. */
async function TeamOutcomes() {
  const [r, words] = await Promise.all([api<{ week: string; people: TeamRow[] }>("outcomes/team"), teamWords()]);
  if (r.error) return <Message text={r.error} />;
  const rows = r.data!.people;
  return <Page>
    <PageHeader title="Team outcomes" back={{ href: "/tasks?view=team", label: `${words.team} dashboard` }} context={[`Week of ${day(r.data!.week)}`, "accepted work against each person's usual week"]}
      actions={<span className={o.seg} role="group" aria-label="Whose outcomes"><Link href="/tasks/outcomes">Me</Link><Link href="/tasks/outcomes?view=team" aria-current="true">Team</Link></span>} />
    <div className={`${o.viz} ${o.page}`}>
      {rows.length ? <ul className={o.team} style={{ listStyle: "none", margin: 0, padding: 0 }}>{rows.map((x) => <li key={x.id}><Link className={o.person} href={`/tasks/outcomes?person=${x.id}`}>
        <span className={o.personTop}><Avatar name={x.name} id={x.id} photoAt={x.photoAt} size={34} status /><span><b>{x.name}</b><small>{[x.role, x.pod].filter(Boolean).join(" · ")}</small></span></span>
        <span className={o.personValue}><span><b>{x.value}</b><small>accepted this week{x.usual !== null ? ` · usual ${x.usual}` : ""}</small></span><Spark values={x.values} label={`${x.name}: accepted tasks per week, last 9 weeks`} /></span>
        <span className={o.facts}><span>{plural(x.done, "task")} done</span><span>{h(x.minutes)} h</span>{x.extraWeek || x.extra8 ? <span data-tone="extra">{x.extraWeek ? `+${x.extraWeek} extra` : `${x.extra8} extra in 8 wks`}</span> : null}
          {x.pending ? <span data-tone="wait">{x.pending} waiting</span> : null}{x.streak > 1 ? <span>{x.streak}-week streak</span> : null}
          {x.help?.answered ? <span title={`${x.help.helpful} helpful · ${x.help.somewhat} somewhat · ${x.help.notHelpful} not helpful (90 days)`}>helped {plural(x.help.answered, "time")}{x.help.helpful ? ` · ${x.help.helpful} helpful` : ""}</span> : null}</span>
      </Link></li>)}</ul> : <p className={o.empty}>Nobody reports to you yet. Leadership, HR, pod heads and managers see their people here.</p>}
      <p className={o.empty}>Sorted by pod and name. Pulse never ranks people against each other; a usual week is the middle of each person’s previous eight.</p>
    </div>
  </Page>;
}
