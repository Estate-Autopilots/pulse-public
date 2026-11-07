import { Page, PageHeader, Skeleton } from "../ui";
import css from "./updates.module.css";

export default function Loading() {
  return <Page><PageHeader title="Updates" /><div className={css.listPage} role="status" aria-label="Loading updates" aria-busy="true">
    {[0, 1, 2].map(i => <div key={i} className={css.row} aria-hidden="true"><Skeleton width="35%" /><Skeleton /><Skeleton width="65%" /></div>)}
  </div></Page>;
}
