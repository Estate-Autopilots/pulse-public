// GOALS-2: the goals page's calm states. Loading (loading.tsx) draws the rows' shapes; an error says what happened in
// plain words with one way out.
import Link from "next/link";
import { RefreshCw, Target } from "lucide-react";
import { Skeleton } from "../ui";
import css from "./goals.module.css";

export function GoalsError({ text }: { text?: string | null }) {
  return <section className={css.emptyHero} role="alert" data-tone="error">
    <span className={css.emptyMark} aria-hidden="true"><Target size={20} /></span>
    <h2>We could not load your goals</h2>
    <p>{text && text.length < 160 ? text : "Something went wrong on our side. Your goals are safe."}</p>
    <Link className={css.btn} href="/goals"><RefreshCw size={15} aria-hidden="true" />Try again</Link>
  </section>;
}

export function GoalsSkeleton() {
  return <div role="status" aria-busy="true" className={css.wrap}>
    <span className={css.srOnly}>Loading goals</span>
    <div className={css.toolbar} aria-hidden="true"><Skeleton width={260} height={36} /><Skeleton width={220} height={16} /></div>
    <div className={css.rows} aria-hidden="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className={css.row} data-skeleton="">
      <Skeleton width={48} height={48} /><span className={css.rowMain}><Skeleton width="70%" height={16} /><Skeleton width="40%" height={12} /></span>
      <span className={css.rowNumber}><Skeleton width={110} height={20} /><Skeleton height={8} /></span><Skeleton width={84} height={24} />
    </div>)}</div>
  </div>;
}
