import { LiveWork } from "../tasks/live";
import Link from "next/link";
import { api, teamWords } from "../lib/api";
import { healthCount, screenGoal, splitGoals, streak } from "../lib/goals.mjs";
import { Page, PageHeader } from "../ui";
import { SegmentedNav } from "../kit";
import { GoalRow, type GoalsData, type ScreenGoal } from "./parts";
import { AddGoal } from "./add-goal";
import { GoalsError } from "./states";
import { GoalSuggestions } from "./suggestions";
import { Flame } from "lucide-react";
import css from "./goals.module.css";

export const dynamic = "force-dynamic";

/** FOUNDATIONS (owner, 6 Nov 2026; Doreve asked first): long-term goals for the company, its teams and its people, each
 *  made of projects and tasks, with progress rolled up from them (services/api/src/goals.ts).
 *  GOALS-2 (owner, 8 Nov 2026: "the goals UI is pathetic … everything has to be visualised"): Company goals and My goals
 *  as two tabs, each sorted by the nearest deadline; every goal one row with its picture, the big number, health by
 *  rule, the date and the one next thing to do; a summary line on top; "Add a goal" opens the guided flow. */
export default async function GoalsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const closed = q.show === "closed";
  const [r, words] = await Promise.all([api<GoalsData>(`goals?who=all${closed ? "" : "&status=active"}`), teamWords()]);
  if (!r.data) return <Page><PageHeader title="Goals" /><GoalsError text={r.error} /></Page>;
  const d = r.data;
  const s = splitGoals(d.goals.map(screenGoal), d.me);
  const view = q.view === "mine" || q.view === "company" ? q.view : s.company.length || !(s.mine.length + s.people.length) ? "company" : "mine";
  const shown: ScreenGoal[] = view === "company" ? s.company : [...s.mine, ...s.people];
  const count = healthCount(shown, d.today);
  const best = Math.max(0, ...shown.map((g) => streak(g, d.today)));
  const add = () => <AddGoal canCompany={d.canCompany} teams={d.teams} people={d.people ?? []} sources={d.sources ?? { billing: false, checkins: false }}
    me={d.me} today={d.today} defaultLevel={view === "company" && d.canCompany ? "company" : "person"} />;
  const keep = (v: string) => `/goals?view=${v}${closed ? "&show=closed" : ""}`;
  const list = (title: string | null, goals: ScreenGoal[], showLevel: boolean) => goals.length ? <section className={css.section} aria-label={title ?? "Goals"}>
    {title ? <div className={css.sectionHead}><h2>{title}</h2><span>{goals.length} {goals.length === 1 ? "goal" : "goals"}</span></div> : null}
    {/* VISUAL-QA (round 2 judge): how health is worked out is explained once, on the first active goal, not by a "?" on every row. */}
    <div className={css.rows}>{goals.map((g) => <GoalRow key={g.id} goal={g} today={d.today} words={words} showLevel={showLevel} help={g.id === goals.find((x) => x.status === "active")?.id} />)}</div>
  </section> : null;

  return <Page>
    <LiveWork scope="goals" />
    <PageHeader title="Goals" context={["What we are aiming for, how close we are, and the next thing to do"]} actions={add()} />
    <div className={css.wrap}>
      <div className={css.toolbar}>
        <SegmentedNav label="Whose goals" items={[
          { key: "company", href: keep("company"), label: "Company goals", count: s.company.length || undefined, current: view === "company" },
          { key: "mine", href: keep("mine"), label: "My goals", count: s.mine.length + s.people.length || undefined, current: view === "mine" }]} />
        {shown.some((g) => g.status === "active") ? <p className={css.summary} aria-label="How the goals are doing">
          <span data-tone="good"><b>{count.on}</b> on track</span><span aria-hidden="true">·</span>
          <span data-tone="warn"><b>{count.risk}</b> at risk</span><span aria-hidden="true">·</span>
          <span data-tone="bad"><b>{count.behind}</b> behind</span>
          {best >= 2 ? <span className={css.chip} data-tone="streak"><Flame size={13} aria-hidden="true" />{best}-week streak</span> : null}
        </p> : null}
      </div>
      {view === "company" && !closed ? <GoalSuggestions canCompany={d.canCompany} /> : null}
      {shown.length ? <>
        {view === "company" ? list(null, shown, true) : <>{list(s.people.length ? "Mine" : null, s.mine, false)}{list("My people's goals", s.people, true)}</>}
      </> : <section className={css.emptyHero} aria-label="No goals yet">
        <h2>{view === "company" ? "No company goals yet" : "You have no goals yet"}</h2>
        <p>{view === "company" && !d.canCompany ? "Leadership sets the few things the whole company works towards. You can still set your own." : "Pick what you want to achieve. We will draw it, track it and tell you if it slips."}</p>
        <AddGoal variant="tiles" canCompany={d.canCompany} teams={d.teams} people={d.people ?? []} sources={d.sources ?? { billing: false, checkins: false }}
          me={d.me} today={d.today} defaultLevel={view === "company" && d.canCompany ? "company" : "person"} />
      </section>}
      <p className={css.hint}>{closed ? <Link href={`/goals?view=${view}`}>Show active goals only</Link> : <Link href={`/goals?view=${view}&show=closed`}>Show done and dropped goals too</Link>}</p>
    </div>
  </Page>;
}
