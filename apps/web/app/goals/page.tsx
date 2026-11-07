import Link from "next/link";
import { api, teamWords } from "../lib/api";
import { groupGoals } from "../lib/goals.mjs";
import { say } from "../lib/words.mjs";
import { Message, Page, PageHeader } from "../ui";
import { GoalCard, type Goal, type GoalsData } from "./parts";
import { NewGoal } from "./new-goal";
import { Target } from "lucide-react";
import css from "./goals.module.css";

export const dynamic = "force-dynamic";

/** FOUNDATIONS (owner, 6 Nov 2026; Ditasu asked first): long-term goals for the company, its teams and its people, each
 *  made of projects and tasks, with progress rolled up from them (services/api/src/goals.ts). */
export default async function GoalsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const status = q.show === "closed" ? "" : "&status=active";
  const [r, words] = await Promise.all([api<GoalsData>(`goals?who=all${status}`), teamWords()]);
  if (!r.data) return <Message text={r.error ?? "Goals are unavailable."} />;
  const d = r.data;
  const g = groupGoals(d.goals, d.me);
  // UX-POLISH: an empty section is a calm card with a mark, one line on what goes there and, where the viewer may set
  // one, a quiet way to start (the header keeps the one primary "New goal").
  const section = (title: string, list: Goal[], empty: { title: string; text: string; cta?: boolean } | null, showLevel = false) => list.length || empty ? <section className={css.section} aria-label={title}>
    <div className={css.sectionHead}><h2>{title}</h2><span>{list.length ? `${list.length} ${list.length === 1 ? "goal" : "goals"}` : ""}</span></div>
    {list.length ? <div className={css.grid}>{list.map((x) => <GoalCard key={x.id} goal={x} today={d.today} words={words} showLevel={showLevel} />)}</div>
      : empty ? <div className={css.empty}>
        <span className={css.emptyMark} aria-hidden="true"><Target size={18} strokeWidth={1.75} /></span>
        <span className={css.emptyWords}><b>{empty.title}</b><span>{empty.text}</span></span>
        {empty.cta ? <NewGoal canCompany={d.canCompany} teams={d.teams} quiet label="Set a goal" /> : null}
      </div> : null}
  </section> : null;
  return <Page>
    <PageHeader title="Goals" context={["Where the company, each team and each person is heading, and how far the work has got"]}
      actions={<NewGoal canCompany={d.canCompany} teams={d.teams} />} />
    <div className={css.wrap}>
      {section("Company goals", g.company, d.canCompany ? { title: "No company goals yet", text: "Set the few things the whole company is working towards.", cta: g.mine.length > 0 } : { title: "No company goals yet", text: "Leadership sets the few things the whole company works towards." })}
      {section(say("{Team} goals", words), g.team, null, true)}
      {section("Your goals", g.mine, { title: "You have no goals yet", text: "Set one, then put the projects and tasks that get you there under it.", cta: true })}
      {section("Your people's goals", g.people, null, true)}
      <p className={css.hint}>{q.show === "closed" ? <Link href="/goals">Show active goals only</Link> : <Link href="/goals?show=closed">Show done and dropped goals too</Link>}</p>
    </div>
  </Page>;
}
