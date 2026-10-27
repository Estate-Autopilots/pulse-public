import Link from "next/link";
import { Compass, Inbox, Sparkles, UserRound } from "lucide-react";
import { api, teamWords } from "../../../lib/api";
import { plural } from "../../../lib/format";
import { Avatar, Message, Page, PageHeader, styles } from "../../../ui";
import { shortDay } from "../../parts";
import type { Domain, Task } from "../../types";
import { TaskViews } from "../../views/task-views";
import { readConfig, type ViewPrefs } from "../../views/model";
import { DomainCards, ValueWeek, type Shipped } from "../panels";
import { GiveTaskButton } from "../give";
import { ScoreCard } from "../scorecard";
import dash from "../../dashboard.module.css";
import css from "../person.module.css";
import { PersonSignals } from "../../signals";

type Week = { week: string; minutes: number; proposed: number; done: number };
type View = { today: string; week: string; self: boolean; firstName: string; person: { id: string; name: string; pod: string | null; department: string | null; role: string | null; workMode: string; photoAt?: string | null };
  now: Task[]; open: Task[]; weeks: Week[]; domains: Domain[];
  estimate: { minutes: number; unestimated: number }; pool: { n: number }; shipped?: Shipped[] };
type WorkList = { rows: Task[]; today: string; me: string | null; openCount: number };
const h = (m: number) => m ? `${(m / 60).toFixed(m % 60 && m < 600 ? 1 : 0)} h` : "0 h";

/** One person's Work (TASKS-4A): a header with their photo, what they are on in any view, what they finished this week
 *  as a chart, their domains as cards and eight weeks of hours and finished work (no points: INTEGRITY, 22 Oct 2026).
 *  For the person, their head, HR and leadership. */
export default async function PersonWork({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params; const q = await searchParams;
  const [r, list, prefs, words] = await Promise.all([api<View>(`work/people/${encodeURIComponent(id)}`), api<WorkList>(`work/list?scope=person&person=${encodeURIComponent(id)}`),
    api<ViewPrefs>("work/views?place=person"), teamWords()]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!; const w = d.weeks.at(-1)!; const prev = d.weeks.at(-2);
  const rows = list.data?.rows ?? [...d.now, ...d.open.filter((t) => !d.now.some((n) => n.id === t.id))];
  const p = prefs.data ?? null;
  const initial = readConfig(q, p?.config ?? null, "person", p?.defaultLayout ?? p?.layout ?? null);
  const open = list.data?.openCount ?? d.open.length;
  const late = rows.filter((t) => ["open", "in_progress", "blocked"].includes(t.status) && t.dueOn && t.dueOn < d.today).length;
  return <Page fit>
    <PageHeader title={d.person.name} back={d.self ? { href: "/tasks", label: "Work" } : { href: "/tasks?view=people", label: "People" }} recent={{ title: d.person.name }}
      context={[d.person.role, d.person.pod, d.person.workMode === "outcome" ? "Outcome-based" : null]} />
    <div className={css.page} data-grow="">
      <header className={css.head}>
        <Avatar name={d.person.name} id={d.person.id} photoAt={d.person.photoAt ?? null} size={72} status className={css.photo} />
        <div className={css.who}>
          <p className={css.name}>{d.person.name}</p>
          <p>{[d.person.role, d.person.pod ? `${d.person.pod}${/pod|team|squad/i.test(d.person.pod) ? "" : ` ${words.team.toLowerCase()}`}` : null, d.person.department].filter(Boolean).join(" · ") || "No role recorded"}</p>
          <span className={css.chips}>
            {d.person.workMode === "outcome" ? <span className={css.chip}><Sparkles size={12} aria-hidden="true" />Outcome-based</span> : null}
            {d.domains.filter((x) => x.status === "active").length ? <span className={css.chip}><Compass size={12} aria-hidden="true" />{plural(d.domains.filter((x) => x.status === "active").length, "domain")}</span> : null}
            {d.pool.n ? <span className={css.chip}><Inbox size={12} aria-hidden="true" />{plural(d.pool.n, "task")} from the pool</span> : null}
          </span>
        </div>
        <dl className={css.stats}>
          <div><dt>Open</dt><dd>{open}</dd><small>{late ? `${late} late` : d.estimate.minutes ? `about ${h(d.estimate.minutes)}` : "on track"}</small></div>
          <div><dt>Done this week</dt><dd>{w.done}</dd><small>{prev ? `${prev.done} last week` : ""}</small></div>
          <div><dt>Hours this week</dt><dd>{h(w.minutes)}</dd><small>{w.proposed ? `+${h(w.proposed)} proposed` : "from task time"}</small></div>
        </dl>
        <div className={css.actions}>
          {!d.self ? <GiveTaskButton personId={d.person.id} first={d.firstName} /> : null}
          <Link className={styles.btn} href={`/tasks/outcomes?person=${d.person.id}`}><Sparkles size={14} aria-hidden="true" />Outcomes</Link>
          <Link className={styles.btn} href={`/people/${d.person.id}`}><UserRound size={14} aria-hidden="true" />Profile</Link>
        </div>
      </header>
      <div className={css.grid} data-grow="">
        <section className={css.main} aria-label={`${d.firstName}’s tasks`} data-grow="">
          <TaskViews place="person" prefKey="person" rows={rows} today={d.today} me={list.data?.me ?? null} initial={initial} ask={p?.ask ?? null} saved={p?.saved ?? []}
            showAssignee={false} domainOwner={d.self ? undefined : d.firstName}
            empty={<p className={css.quiet}><b>No open work</b>{d.self ? "Take something from the pool or press N to add a task." : `${d.firstName} has nothing open.`}</p>} />
        </section>
        <aside className={css.side}>
          {/* WORK-TAB (27 Oct 2026): performance and quality first, Kazuk's number 1. */}
          <ScoreCard personId={d.person.id} first={d.firstName} self={d.self} />
          {w.done ? <ValueWeek week={d.week} today={d.today} shipped={d.shipped ?? []} lastWeek={prev?.done ?? 0} first={d.firstName} /> : null}
          <DomainCards domains={d.domains} personId={d.person.id} first={d.firstName} self={d.self} />
          <section className={css.card} aria-label="Eight weeks">
            <div className={css.cardHead}><h3>Eight weeks</h3><small>each on its own scale</small></div>
            {([["Hours", (x: Week) => x.minutes / 60, (x: Week) => h(x.minutes)], ["Finished", (x: Week) => x.done, (x: Week) => `${x.done} finished`]] as const).map(([label, val, text]) => {
              const peak = Math.max(1, ...d.weeks.map(val));
              return <div key={label} className={css.trend}><span className={css.trendLabel}>{label}<b>{text(w)}</b></span>
                <span className={dash.minis} role="img" aria-label={`${label} per week: ${d.weeks.map(text).join(", ")}`}>{d.weeks.map((x, i) => <span key={x.week} className={dash.mini} data-now={i === d.weeks.length - 1 ? "" : undefined}>
                  <i style={{ height: `${Math.max(val(x) ? 8 : 0, Math.round(100 * val(x) / peak))}%` }} data-zero={val(x) ? undefined : ""} /><span className={dash.tip} role="tooltip"><b>{text(x)}</b><span>Week of {shortDay(x.week)}</span></span></span>)}</span></div>;
            })}
            <table className={dash.srOnly}><caption>Hours and finished tasks per week</caption><thead><tr><th>Week of</th><th>Hours</th><th>Finished</th></tr></thead>
              <tbody>{d.weeks.map((x) => <tr key={x.week}><td>{x.week}</td><td>{h(x.minutes)}</td><td>{x.done}</td></tr>)}</tbody></table>
          </section>
          {/* TASKS-4B: the person's record, kindly (leadership: outcomes, not ratings). */}
          <PersonSignals personId={d.person.id} name={d.person.name} self={d.self} />
        </aside>
      </div>
    </div>
  </Page>;
}
