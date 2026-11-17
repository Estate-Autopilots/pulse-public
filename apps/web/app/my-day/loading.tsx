import { Skeleton } from "../ui";
import css from "./my-day.module.css";

export default function Loading() {
  return <div className={css.wrap} aria-busy="true" aria-label="Loading your day">
    <div className={css.head}><Skeleton width={160} height={28} /><Skeleton width={240} height={14} /></div>
    <div className={css.loadingList}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={56} />)}</div>
  </div>;
}
