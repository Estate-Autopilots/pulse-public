import Link from "next/link";
import { AlertTriangle, ArrowRight, CircleCheck, Hourglass, LifeBuoy, ListChecks, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { Avatar, Panel, Why, styles } from "../ui";
import { KindChip } from "../work-kind";
import { shortDay } from "./parts";
import css from "./dashboard.module.css";
import { vocabulary } from "../lib/api";

type Person = { id: string; name: string; pod: string | null; photoAt: string | null };
type Load = Person & { open: number; doing: number; dueWeek: number; overdue: number; blocked: number; doneWeek: number; untriaged: number;
  department?: string | null; workMode?: string; minutes: number; proposed: number; value: number; value8: number; estimateOpen: number; now: { id: string; title: string } | null };
type Group = { name: string; people: number; open: number; doing: number; overdue: number; doneWeek: number; minutes: number; proposed: number; value: number; estimateOpen: number; weeks: { week: string; done: number; value: number }[] };
type ClientWork = { id: string; name: string; clientName: string | null; ownerName: string | null; dueOn: string | null; total: number; finished: number; open: number; overdue: number; blocked: number;
  nextDue: string | null; percent: number; atRisk: boolean; risk: string | null };
type Act = { kind: string; title: string; detail: string; href: string; action: string };
export type Dashboard = { today: string; week: string; weekEnd: string; role: string; roleLabel: string; pods: string[]; pod: string | null; department: string | null; scope: string;
  totals: { open: number; dueWeek: number; overdue: number; blocked: number; doneWeek: number; doneLastWeek: number; untriaged: number; unowned: number; minutes: number; proposed: number; value: number; valueLastWeek: number };
  workload: Load[]; throughput: { week: string; done: number; added: number }[]; group: "person" | "pod" | "department"; groups: { pod: Group[]; department: Group[] };
  labels?: { clientProjects: string | null; fulfilmentChip: string; team?: string; teams?: string };
  blockers: { ownerId: string | null; ownerName: string; ownerPhotoAt: string | null; oldest: string; waiting: { id: string; title: string; owner: string | null; blockerId: string; blockerTitle: string }[] }[];
  manualBlocked: number; clientWork: ClientWork[]; clientCount: number; atRisk: number; help: (Person & { reasons: string[] })[]; act: Act[] };

const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(from)) / 86400000));
const ACT_ICON: Record<string, typeof Sparkles> = { ask: Sparkles, review: CircleCheck, overdue: AlertTriangle, blocked: Hourglass, unowned: LifeBuoy, risk: AlertTriangle, tidy: ListChecks, file: ListChecks };
const h = (m: number) => m ? `${(m / 60).toFixed(m % 60 && m < 600 ? 1 : 0)} h` : "0 h";

/** The leader's view: one calm screen of who is working on what and how much (hours from task time, outcome-based
 *  people included), the work accepted per person, pod and department with eight weeks of output (tasks someone else
 *  accepted, one each: INTEGRITY, no points), what is stuck,
 *  which client work is at risk, and the ten things to act on today. Leadership and HR see everyone; a pod head their pods. */
export async function TeamDashboard({ q }: { q: Record<string, string> }) {
  const words = await vocabulary();
  const params = new URLSearchParams(); for (const k of ["pod", "group", "department"]) if (q[k] !== undefined) params.set(k, q[k]);
  const r = await api<Dashboard>(`work/dashboard${params.size ? `?${params}` : ""}`);
  if (r.error) return <p className={css.empty}>{r.error}</p>;
  const d = r.data!;
  const t = d.totals;
  const delta = t.doneWeek - t.doneLastWeek, valueDelta = t.value - t.valueLastWeek;
  const actItem = (a: Act, i: number) => { const Icon = ACT_ICON[a.kind] ?? Sparkles; return <li key={`${a.kind}:${a.href}:${i}`} data-kind={a.kind}>
    <span className={css.actIcon} aria-hidden="true"><Icon size={15} /></span>
    <span className={css.actMain}><Link href={a.href} className={css.actTitle} title={a.title}>{a.title}</Link><small>{a.detail}</small></span>
    <Link href={a.href} className={css.actBtn} aria-label={`${a.action}: ${a.title}`}>{a.action}<ArrowRight size={13} aria-hidden="true" /></Link>
  </li>; };
  const link = (over: Record<string, string | undefined>) => { const n = new URLSearchParams({ view: "team" }); for (const [k, v] of Object.entries({ pod: d.pod ?? undefined, group: d.group === "person" ? undefined : d.group, department: d.department ?? undefined, ...over })) if (v !== undefined) n.set(k, v); return `/tasks?${n}`; };
  return <div className={css.dash} data-grow="">
    <nav className={css.scope} aria-label="Whose work">
      <span className={css.scopeLabel}>Showing</span>
      <div className={styles.segmented}>
        <Link className={styles.segment} href={link({ pod: undefined, department: undefined })} aria-current={!d.pod && d.department === null ? "true" : undefined}>{d.role === "leadership" || d.role === "hr" ? "Everyone" : `My ${(d.labels?.teams ?? `${words.teams}`).toLowerCase()}`}</Link>
        {d.pods.length > 1 ? d.pods.map((p) => <Link key={p} className={styles.segment} href={link({ pod: p, department: undefined })} aria-current={d.pod === p ? "true" : undefined}>{p}</Link>) : null}
        {d.department !== null ? <span className={styles.segment} aria-current="true">{d.department || "No department"}</span> : null}
      </div>
      <span className={css.scopeLabel}>Group by</span>
      <div className={styles.segmented} role="group" aria-label="Group by">
        {([["person", "People"], ["pod", d.labels?.teams ?? `${words.teams}`], ["department", "Departments"]] as const).map(([k, l]) => <Link key={k} className={styles.segment} href={link({ group: k === "person" ? undefined : k, department: k === "person" ? d.department ?? undefined : undefined })} aria-current={d.group === k ? "true" : undefined}>{l}</Link>)}
      </div>
    </nav>
    <section className={css.tiles} aria-label="This week at a glance">
      <Tile label="Open" value={t.open} note={`${t.dueWeek} due this week${t.unowned ? ` · ${t.unowned} unowned` : ""}`} />
      <Tile label="Overdue" value={t.overdue} tone={t.overdue ? "danger" : undefined} note={t.overdue ? "past their due day" : "nothing late"} />
      <Tile label="Blocked" value={t.blocked} tone={t.blocked ? "warning" : undefined} note={d.blockers.length ? `waiting on ${plural(d.blockers.length, "person", "people")}` : "nothing stuck"} />
      <Tile label="Done this week" value={t.doneWeek} note={delta ? `${delta > 0 ? `+${delta}` : `−${-delta}`} on last week` : "same as last week"} />
      <Tile label="Hours this week" value={Math.round(t.minutes / 60)} note={t.proposed ? `+${h(t.proposed)} proposed` : "from task time"} />
      <Tile label="Accepted this week" value={t.value} note={t.valueLastWeek || t.value ? (valueDelta ? `${valueDelta > 0 ? `+${valueDelta}` : `−${-valueDelta}`} on last week` : "same as last week") : "tasks someone else accepted"} />
    </section>
    <div className={css.grid}>
      <WhoPanel d={d} link={link} />
      <section className={`${styles.panel} ${css.act}`} aria-labelledby="act-today">
        <div className={styles.panelHead}><h3 className={styles.panelTitle} id="act-today">Act on today<small>{d.act.length ? `${d.act.length} of the most pressing` : "all clear"}</small></h3></div>
        {d.act.length ? <ol className={css.actList}>{d.act.slice(0, 4).map(actItem)}
          {d.act.length > 4 ? <li className={css.actMore} data-pager-skip=""><details><summary>Show {d.act.length - 4} more</summary><ol className={css.actList}>{d.act.slice(4).map(actItem)}</ol></details></li> : null}</ol>
          : <p className={css.empty}><b>Nothing needs you today</b>Asks, reviews, late or stuck work and client projects at risk show here first.</p>}
      </section>
      <Panel fill className={css.client} title={d.labels?.clientProjects ?? "Client projects"} sub={d.clientCount ? `${d.clientCount} in delivery${d.atRisk ? ` · ${d.atRisk} at risk` : ""}` : undefined} unit="projects" min={3}
        tools={<Why detail="Fulfilment projects with open work, with the projects placed under them. Progress is finished tasks of all tasks. At risk: any task overdue or blocked, past the project's due date, or due within a week at under 60% done." />}>
        {d.clientWork.length ? <ul className={css.clientList} data-items="">{d.clientWork.map((p) => <li key={p.id} data-risk={p.atRisk ? "" : undefined}>
          <span className={css.clientTop}><KindChip kind="fulfilment" short label={d.labels?.fulfilmentChip} /><Link href={`/tasks/projects/${p.id}`} className={css.clientName}>{p.name}</Link>
            {p.atRisk ? <span className={css.risk}><AlertTriangle size={11} aria-hidden="true" />At risk</span> : null}</span>
          <span className={css.meter} role="img" aria-label={`${p.percent}% done: ${p.finished} of ${p.total} tasks`}><i style={{ width: `${p.percent}%` }} /></span>
          <span className={css.clientMeta}><b>{p.percent}%</b> · {p.finished}/{p.total} done{p.nextDue ? ` · next ${p.nextDue === d.today ? "today" : shortDay(p.nextDue)}` : ""}{p.risk ? ` · ${p.risk}` : ""}{p.ownerName ? ` · ${p.ownerName.split(" ")[0]}` : ""}</span>
        </li>)}</ul> : <p className={css.empty}><b>No client work in delivery</b>Set up a fulfilment project from + Create to track a client package’s tasks here.</p>}
      </Panel>
      <section className={`${styles.panel} ${css.flow}`} aria-labelledby="throughput">
        <div className={styles.panelHead}><h3 className={styles.panelTitle} id="throughput">Finished per week<small>last 8 weeks</small></h3></div>
        <Throughput weeks={d.throughput} />
      </section>
      <section className={`${styles.panel} ${css.stuck}`} aria-labelledby="stuck">
        <div className={styles.panelHead}><h3 className={styles.panelTitle} id="stuck">Blocked, and who it waits on<small>{d.blockers.length ? plural(d.blockers.reduce((n, b) => n + b.waiting.length, 0), "task") : d.manualBlocked ? `${d.manualBlocked} marked blocked` : "nothing"}</small></h3>
          <Link href="/tasks?view=blocking" className={styles.panelAction}>All<ArrowRight size={13} aria-hidden="true" /></Link></div>
        {d.blockers.length ? <ul className={css.people}>{d.blockers.slice(0, 3).map((b) => <li key={b.ownerId ?? "nobody"}>
          <Avatar name={b.ownerName} id={b.ownerId ?? undefined} photoAt={b.ownerPhotoAt} size={26} />
          <span><b>{b.ownerName}</b><small>{plural(b.waiting.length, "task")} waiting · {days(b.oldest, d.today) ? `${days(b.oldest, d.today)} days` : "since today"} · “{b.waiting[0].blockerTitle}”</small></span>
        </li>)}</ul> : <p className={css.empty}>{d.manualBlocked ? `${plural(d.manualBlocked, "task")} marked blocked without saying on what.` : "Nothing is waiting on anyone."}</p>}
        <div className={styles.panelHead}><h3 className={styles.panelTitle}>Who needs help<small>{d.help.length ? plural(d.help.length, "person", "people") : "nobody"}</small></h3></div>
        {d.help.length ? <ul className={css.people}>{d.help.slice(0, 3).map((x) => <li key={x.id}>
          <Avatar name={x.name} id={x.id} photoAt={x.photoAt} size={26} status /><span><Link href={`/tasks/people/${x.id}`}><b>{x.name}</b></Link><small>{x.reasons.join(" · ")}</small></span>
        </li>)}</ul> : <p className={css.empty}>Nobody is behind, blocked or carrying far more than the team.</p>}
      </section>
    </div>
  </div>;
}

/** Who is working on what: people (now doing, open, hours, accepted), or pods and departments with eight weeks of accepted work
 *  as small multiples on one shared scale. Every row drills down. */
function WhoPanel({ d, link }: { d: Dashboard; link: (o: Record<string, string | undefined>) => string }) {
  // The People / Pods / Departments switch lives in the Showing row above.
  const busy = d.workload.filter((w) => w.open || w.doneWeek || w.minutes || w.value);
  const groups = d.group === "person" ? [] : d.groups[d.group];
  const top = Math.max(1, ...d.workload.map((w) => w.open));
  const peak = Math.max(1, ...groups.flatMap((g) => g.weeks.map((w) => w.value)));
  return <Panel fill className={css.load} title="Who is working on what" sub={d.group === "person" ? "now · open · hours · accepted this week" : `${d.group === "pod" ? "pods" : "departments"} · accepted per week, last 8`} unit={d.group === "person" ? "people" : d.group === "pod" ? "pods" : "departments"} min={3}
    tools={<><Link href="/tasks/outcomes?view=team" className={styles.panelAction}>Outcomes<ArrowRight size={13} aria-hidden="true" /></Link><Why detail="Hours come from task time entries this week (confirmed; proposed ones are shown apart), for everyone including outcome-based people. Accepted counts tasks someone other than the doer accepted, one each; tasks carry no value points, so nobody moves this number alone. Open is To do, Doing and Blocked." /></>}>
    {d.group === "person" ? busy.length ? <ul className={css.whoList} data-items="">{busy.map((w) => <li key={w.id}>
      <Link href={`/tasks/people/${w.id}`} className={css.who}><Avatar name={w.name} id={w.id} photoAt={w.photoAt} size={28} status /><span>{w.name}<small>{w.now ? <>Now: {w.now.title}</> : w.workMode === "outcome" ? "Outcome-based · nothing in progress" : "Nothing in progress"}</small></span></Link>
      <span className={css.bar} aria-hidden="true"><i style={{ width: `${Math.round(100 * w.open / top)}%` }} data-empty={w.open ? undefined : ""} /></span>
      <span className={css.whoNums}><span title="Open tasks"><b>{w.open}</b> open{w.overdue ? <em className={css.late}><AlertTriangle size={10} aria-hidden="true" />{w.overdue}</em> : null}</span>
        <span title={`Hours from task time this week${w.proposed ? `, plus ${h(w.proposed)} proposed` : ""}`}>{h(w.minutes)}</span>
        <span title="Tasks someone else accepted this week"><b>{w.value}</b> accepted</span></span>
    </li>)}{d.workload.length > busy.length ? <li className={css.rest} data-pager-skip="">{plural(d.workload.length - busy.length, "person", "people")} with nothing open, logged or credited this week</li> : null}</ul>
      : <p className={css.empty}>Nobody in view has open work.</p>
    : groups.length ? <ul className={css.groupList} data-items="">{groups.map((g) => <li key={g.name}>
      <Link href={d.group === "pod" ? link({ group: undefined, pod: g.name === "No pod" ? undefined : g.name, department: undefined }) : link({ group: undefined, department: g.name === "No team" ? "" : g.name, pod: undefined })} className={css.groupName}>
        <b>{g.name}</b><small>{plural(g.people, "person", "people")} · {g.doing} doing · {g.open} open{g.overdue ? ` · ${g.overdue} late` : ""}</small></Link>
      <span className={css.minis} role="img" aria-label={`${g.name}: accepted per week ${g.weeks.map((w) => w.value).join(", ")}; ${g.value} this week`}>
        {g.weeks.map((w, i) => <span key={w.week} className={css.mini} tabIndex={-1} data-now={i === g.weeks.length - 1 ? "" : undefined}>
          <i style={{ height: `${Math.max(w.value ? 8 : 0, Math.round(100 * w.value / peak))}%` }} data-zero={w.value ? undefined : ""} />
          <span className={css.tip} role="tooltip"><b>{w.value} accepted</b><span>{w.done} finished</span><span>Week of {shortDay(w.week)}</span></span>
        </span>)}
      </span>
      <span className={css.groupNums}><span><b>{g.value}</b> accepted</span><span>{g.doneWeek} done</span><span>{h(g.minutes)}</span></span>
    </li>)}</ul> : <p className={css.empty}>No {d.group === "pod" ? "pods" : "departments"} in view.</p>}
    {d.group !== "person" && groups.length ? <table className={css.srOnly}><caption>Tasks accepted per week by {d.group}</caption><thead><tr><th>{d.group === "pod" ? `Pod` : "Department"}</th>{groups[0].weeks.map((w) => <th key={w.week}>{w.week}</th>)}</tr></thead>
      <tbody>{groups.map((g) => <tr key={g.name}><th>{g.name}</th>{g.weeks.map((w) => <td key={w.week}>{w.value} accepted, {w.done} finished</td>)}</tr>)}</tbody></table> : null}
  </Panel>;
}

function Tile({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "danger" | "warning" }) {
  return <div className={css.tile} data-tone={tone}><span className={css.tileLabel}>{tone === "danger" ? <AlertTriangle size={12} aria-hidden="true" /> : tone === "warning" ? <Hourglass size={12} aria-hidden="true" /> : null}{label}</span>
    <b className={css.tileValue}>{value.toLocaleString("en-IN")}</b><small>{note}</small></div>;
}

/** Finished tasks per week: one series, so no legend; the current week in full colour, the rest a step lighter. Each
 *  column takes focus and shows its numbers; the same numbers are in a table for screen readers. */
function Throughput({ weeks }: { weeks: { week: string; done: number; added: number }[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.done));
  const ticks = max <= 4 ? [max] : [Math.round(max / 2), max];
  const peak = weeks.reduce((m, w, i) => w.done > weeks[m].done ? i : m, 0);
  return <figure className={css.chart}>
    <div className={css.plot} role="presentation">
      {ticks.map((v) => <span key={v} className={css.gridline} style={{ bottom: `${(100 * v) / max}%` }}><i>{v}</i></span>)}
      {weeks.map((w, i) => { const now = i === weeks.length - 1;
        return <span key={w.week} className={css.col} tabIndex={0} aria-label={`Week of ${shortDay(w.week)}: ${w.done} finished, ${w.added} added`} data-now={now ? "" : undefined}>
          <span className={css.colBar} style={{ height: `${(100 * w.done) / max}%` }} data-zero={w.done ? undefined : ""} />
          {now || (i === peak && w.done) ? <span className={css.colValue} style={{ bottom: `calc(${(100 * w.done) / max}% + 4px)` }}>{w.done}</span> : null}
          <span className={css.tip} role="tooltip"><b>{w.done} finished</b><span>{w.added} added</span><span>Week of {shortDay(w.week)}</span></span>
        </span>; })}
    </div>
    <div className={css.axis} aria-hidden="true">{weeks.map((w, i) => <span key={w.week}>{i === weeks.length - 1 ? "Now" : i % 2 === weeks.length % 2 ? shortDay(w.week).slice(4) : ""}</span>)}</div>
    <table className={css.srOnly}><caption>Tasks finished and added per week</caption><thead><tr><th>Week of</th><th>Finished</th><th>Added</th></tr></thead>
      <tbody>{weeks.map((w) => <tr key={w.week}><td>{w.week}</td><td>{w.done}</td><td>{w.added}</td></tr>)}</tbody></table>
  </figure>;
}
