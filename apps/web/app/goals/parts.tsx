// FOUNDATIONS: the goal card and progress bar, shared by the goals page, a goal's page and My day.
import Link from "next/link";
import { dueWords, levelWords, percent, progressWords, tone, type Goal } from "../lib/goals.mjs";
import css from "./goals.module.css";

export type { Goal };
export type Team = { id: string; name: string; canEdit: boolean };
export type GoalsData = { goals: Goal[]; me: string | null; today: string; canCompany: boolean; teams: Team[] };
export type GoalLink = { id: string; kind: "project" | "task"; projectId: string | null; taskId: string | null; title: string; status: string; who: string | null;
  dueOn: string | null; tasks: number; tasksDone: number };
export type GoalDetail = { goal: Goal; links: GoalLink[]; subGoals: Goal[]; today: string; canCompany: boolean; teams: Team[] };

export function ProgressBar({ goal, label }: { goal: Goal; label?: string }) {
  const pct = percent(goal.progress.progress);
  return <span className={css.bar} data-tone={tone(goal)} role="meter" aria-label={label ?? `${goal.title}: ${pct}% done`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
    <i style={{ width: `${pct}%` }} />
  </span>;
}

export function GoalCard({ goal, today, words, showLevel = true }: { goal: Goal; today: string; words?: Record<string, string> | null; showLevel?: boolean }) {
  const due = dueWords(goal.targetOn, today, goal.status);
  return <Link href={`/goals/${goal.id}`} className={css.card}>
    <span className={css.cardTop}>
      <span>
        <h3 className={css.cardTitle}>{goal.title}</h3>
        {showLevel ? <span className={css.level}>{levelWords(goal, words)}</span> : null}
      </span>
      <span className={css.pct}>{percent(goal.progress.progress)}%</span>
    </span>
    <ProgressBar goal={goal} />
    <span className={css.meta}>
      <span>{progressWords(goal)}</span>
      {due ? <span data-tone={goal.progress.late ? "late" : undefined}>{due}</span> : null}
    </span>
  </Link>;
}
