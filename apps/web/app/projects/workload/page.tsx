import Link from "next/link";
import { api } from "../../lib/api";
import { Avatar } from "../../avatar";
import { Message, Page, PageHeader } from "../../ui";
import { day } from "../pm-shared";
import { ReassignButton } from "./reassign";
import css from "./workload.module.css";

/** PM-BUILD-3 (the Mac's screen 09, SPEC v1.1 §5.9): the team's load. People × working days (this week and next), each
 *  cell the hours of open work that day, over 9 hours red, over 8 amber; each person's total against 8 hours a day; and
 *  one suggestion (move a step from the most loaded person to someone with room) with one Reassign. No money, no project
 *  header. Data: GET /api/v0/projects/workload. */
export const metadata = { title: "Team workload" };
export const dynamic = "force-dynamic";
type Cell = { day: string; hours: number };
type Person = { id: string; name: string; pod: string | null; role: string | null; total: number; cap: number; over: number; state: "ok" | "high" | "over"; cells: Cell[]; steps: { id: string; title: string; project: string | null; hours: number; days: string[] }[] };
type Data = { today: string; days: string[]; cap: number; scope: string; people: Person[]; suggestion: { step: { id: string; title: string; project: string | null; hours: number; day: string }; from: { id: string; name: string; hours: number }; to: { id: string; name: string; total: number } } | null };
const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" });
const tone = (h: number) => h > 9 ? "over" : h > 8 ? "high" : h > 0 ? "ok" : "none";
const hrs = (n: number) => `${Math.round(n * 10) / 10} h`;

export default async function Workload({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const q = await searchParams;
  const r = await api<Data>("projects/workload");
  if (r.error || !r.data) return <Message text={r.error ?? "The team's load is unavailable."} />;
  const d = r.data; const second = q.week === "2";
  const shown = d.days.slice(second ? 6 : 0, second ? 12 : 6);
  const s = d.suggestion;
  return <Page>
    <PageHeader title="Team workload" back={{ href: "/tasks?view=projects", label: "Projects" }} context={[`${d.people.length} ${d.people.length === 1 ? "person" : "people"}`, d.scope === "all" ? "Everyone" : d.scope === "pod" ? "Your pods" : "You"]} />
    {s ? <section className={css.suggest} aria-label="Suggestion">
      <p><b>{s.from.name}</b> has {hrs(s.from.hours)} on {WEEKDAY.format(new Date(`${s.step.day}T00:00:00Z`))}. Move <b>{s.step.title}</b> to <b>{s.to.name}</b>, who has room.</p>
      <ReassignButton taskId={s.step.id} toId={s.to.id} toName={s.to.name} fromName={s.from.name} />
    </section> : null}
    <nav className={css.weeks} aria-label="Week">
      <Link href="/projects/workload" aria-current={!second ? "page" : undefined}>This week</Link>
      <Link href="/projects/workload?week=2" aria-current={second ? "page" : undefined}>Next week</Link>
    </nav>
    {d.people.length ? <div className={css.grid} role="table" aria-label="Hours of open work per person and day" style={{ ["--n" as string]: shown.length }}>
      <div className={css.row} role="row" data-head="">
        <span role="columnheader" className={css.who}>Person</span>
        {shown.map((x) => <span key={x} role="columnheader" className={css.dayHead} data-today={x === d.today ? "" : undefined}>{WEEKDAY.format(new Date(`${x}T00:00:00Z`))}<small className={css.dayDate}>{day(x)}</small></span>)}
        <span role="columnheader" className={css.total}>Total</span>
      </div>
      {d.people.map((p) => { const week = p.cells.filter((c) => shown.includes(c.day)); const sum = week.reduce((n, c) => n + c.hours, 0);
        return <div key={p.id} className={css.row} role="row" data-state={p.state}>
          <span role="rowheader" className={css.who}><Avatar name={p.name} id={p.id} size={28} /><span><b><span className={css.full}>{p.name}</span><span className={css.first}>{p.name.split(" ")[0]}</span></b><small>{p.role ?? p.pod ?? ""}</small></span></span>
          {week.map((c) => <span key={c.day} role="cell" className={css.cell} data-tone={tone(c.hours)} title={`${p.name}, ${day(c.day)}: ${hrs(c.hours)}`}>{c.hours ? (Number.isInteger(Math.round(c.hours * 2) / 2) ? Math.round(c.hours) : (Math.round(c.hours * 2) / 2).toFixed(1)) : ""}</span>)}
          <span role="cell" className={css.total}><b>{Math.round(sum)} h</b><small> / {8 * shown.length} h</small>{sum > 8 * shown.length ? <em>Over by {Math.round(sum - 8 * shown.length)} h</em> : null}</span>
        </div>; })}
    </div> : <p className={css.empty}>No open work with dates in the next two weeks.</p>}
    <p className={css.legend}><span data-tone="ok">On track</span><span data-tone="high">High load (over 8 h)</span><span data-tone="over">Overloaded (over 9 h)</span>
      <span className={css.note}>Hours: a task&apos;s estimate, else its plan step&apos;s hours; one hour when neither is set.</span></p>
  </Page>;
}
