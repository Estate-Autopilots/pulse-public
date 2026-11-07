"use client";
// FOUNDATIONS: My day's goals card: the person's active goals (theirs, and the ones they set) with their progress, the
// late ones first, and a way to set the first one.
import Link from "next/link";
import { Target } from "lucide-react";
import { useWords } from "../org-code";
import { GoalCard, type GoalsData } from "./parts";
import css from "./goals.module.css";

export function MyGoals({ data }: { data: GoalsData | null }) {
  const words = useWords();
  if (!data) return null;
  const goals = [...data.goals].filter((g) => g.status === "active").sort((a, b) => Number(b.progress.late) - Number(a.progress.late)).slice(0, 4);
  return <section className={css.strip} aria-label="Your goals">
    <div className={css.sectionHead}>
      <h2><Target size={16} aria-hidden="true" /> Your goals</h2>
      <Link href="/goals" className={css.level}>{goals.length ? "All goals" : "Set a goal"}</Link>
    </div>
    {goals.length ? <div className={css.grid}>{goals.map((g) => <GoalCard key={g.id} goal={g} today={data.today} words={words} />)}</div>
      : <p className={css.empty}>No goals yet. A goal holds the projects and tasks that get you somewhere bigger, and shows how far they have got.</p>}
  </section>;
}
