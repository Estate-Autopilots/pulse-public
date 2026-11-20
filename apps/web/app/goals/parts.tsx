// FOUNDATIONS: the goal card and progress bar, shared by the goals page, a goal's page and My day.
// GOALS-2 (owner, 8 Nov 2026): one row per goal on the goals page (its picture, the big number, health, the date and
// the one next thing to do), and the same card, now with its picture, on My day.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { daysBetween, dueWords, headline, levelWords, nextAction, percent, shortDate, timeGone, tone, type Goal, type ScreenGoal } from "../lib/goals.mjs";
import { HealthChip, MiniVisual, Owner, PaceBar, StreakChip } from "./visuals";
import css from "./goals.module.css";

export type { Goal, ScreenGoal };
export type Team = { id: string; name: string; canEdit: boolean };
export type PickPerson = { id: string; name: string; photoAt: string | null; canSetFor: boolean };
export type Sources = { billing: boolean; checkins: boolean };
export type GoalsData = { goals: ScreenGoal[]; me: string | null; today: string; canCompany: boolean; teams: Team[]; people?: PickPerson[]; sources?: Sources };
export type GoalLink = { id: string; kind: "project" | "task"; projectId: string | null; taskId: string | null; title: string; status: string; who: string | null;
  dueOn: string | null; tasks: number; tasksDone: number;
  /** WORK-SPINE: the project's type, its open and late tasks, and its next three open tasks (ticked done on the goal's page). */
  projectType?: string | null; open?: number; late?: number;
  next?: { id: string; title: string; status: string; dueOn: string | null; who: string | null; whoId: string | null; projectId: string | null; parentTitle: string | null }[] };
export type GoalDetail = { goal: ScreenGoal; links: GoalLink[]; subGoals: ScreenGoal[]; today: string; me: string | null; canCompany: boolean; teams: Team[];
  people?: PickPerson[]; sources?: Sources };

export function ProgressBar({ goal, label }: { goal: Goal; label?: string }) {
  const pct = percent(goal.progress.progress);
  return <span className={css.bar} data-tone={tone(goal)} role="meter" aria-label={label ?? `${goal.title}: ${pct}% done`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
    <i style={{ width: `${pct}%` }} />
  </span>;
}

/** When it is due, short: "30 Nov" and "22 days left" (or "3 days late"). */
function Due({ goal, today }: { goal: Goal; today: string }) {
  if (!goal.targetOn) return <span className={css.due}><b>No date</b></span>;
  const days = daysBetween(today, goal.targetOn);
  const left = goal.status !== "active" ? null : days < 0 ? `${-days} ${days === -1 ? "day" : "days"} late` : days === 0 ? "Due today" : `${days} ${days === 1 ? "day" : "days"} left`;
  return <span className={css.due} data-late={days < 0 && goal.status === "active" ? "" : undefined}><b>{shortDate(goal.targetOn, today)}</b>{left ? <small>{left}</small> : null}</span>;
}

/** One goal on the goals page. The title is the row's link (it covers the row); the next step is a link of its own. */
export function GoalRow({ goal, today, words, showLevel, help = true }: { goal: ScreenGoal; today: string; words?: Record<string, string> | null; showLevel?: boolean; help?: boolean }) {
  const h = headline(goal), next = nextAction(goal, today), gone = timeGone(goal, today);
  return <article className={css.row} data-status={goal.status} aria-label={goal.title}>
    <span className={css.rowVisual}><MiniVisual goal={goal} today={today} /></span>
    <span className={css.rowMain}>
      <Link href={`/goals/${goal.id}`} className={css.rowLink}><h3 className={css.rowTitle}>{goal.title}</h3></Link>
      <span className={css.rowWho}>{goal.owner ? <Owner goal={goal} size={20} /> : null}{showLevel || !goal.owner ? <span className={css.level}>{levelWords(goal, words)}</span> : null}</span>
    </span>
    <span className={css.rowNumber}>
      <span className={css.rowBig}><b>{h.now}</b> <span>{h.of}</span></span>
      <PaceBar value={goal.progress.progress} expected={goal.status === "active" ? gone : null} tone={goal.status === "done" ? "done" : undefined} label={`${percent(goal.progress.progress)}% done`} />
    </span>
    <span className={css.rowHealth}><HealthChip goal={goal} today={today} help={help} /><StreakChip goal={goal} today={today} /></span>
    <Due goal={goal} today={today} />
    <span className={css.rowNext}>{next ? <Link href={next.href} className={css.nextLink}><span>Next:</span> <span className={css.nextText} title={next.label}>{next.label}</span><ArrowRight size={14} aria-hidden="true" /></Link> : null}</span>
  </article>;
}

/** My day's card (and a goal's smaller goals): the picture, the number and the date. */
export function GoalCard({ goal, today, words, showLevel = true }: { goal: ScreenGoal; today: string; words?: Record<string, string> | null; showLevel?: boolean }) {
  const due = dueWords(goal.targetOn, today, goal.status), h = headline(goal);
  return <Link href={`/goals/${goal.id}`} className={css.card}>
    <span className={css.cardTop}>
      <MiniVisual goal={goal} today={today} />
      <span className={css.cardWords}>
        <h3 className={css.cardTitle}>{goal.title}</h3>
        {showLevel ? <span className={css.level}>{levelWords(goal, words)}</span> : null}
        <span className={css.rowBig} data-size="sm"><b>{h.now}</b> <span>{h.of}</span></span>
      </span>
    </span>
    <span className={css.meta}>
      <HealthChip goal={goal} today={today} help={false} />
      {due ? <span data-tone={goal.progress.late ? "late" : undefined}>{due}</span> : null}
    </span>
  </Link>;
}
