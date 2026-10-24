import { Page, Skeleton, styles } from "../../../ui";
import { ERP_SECTIONS } from "../../nav";
import erp from "../../nav.module.css";
import css from "../catalog.module.css";

// BILLING (18 Oct 2026): a package or item page while it loads: details and parts on the left, the customer's copy on
// the right (one column below 1100 px), the same sizes as the page itself.
export default function Loading() {
  return <Page><div role="status" aria-busy="true" className={styles.stack} style={{ gap: 14 }}>
    <span className={styles.srOnly}>Loading the item</span>
    <div className={styles.headerText} aria-hidden="true"><Skeleton width={90} height={11} /><Skeleton width={280} height={22} /><Skeleton width={200} height={12} /></div>
    <nav className={erp.sections} aria-hidden="true">{ERP_SECTIONS.filter((s) => s.key !== "inventory").map((s) => <span key={s.key} className={erp.section}>{s.label}</span>)}</nav>
    <div className={css.page} aria-hidden="true">
      <div className={css.main}>
        <div className={css.card}><Skeleton width={160} height={20} /><Skeleton width="70%" height={24} /><div className={css.priceGrid}><Skeleton height={34} /><Skeleton height={34} /><Skeleton height={34} /></div><Skeleton width="50%" height={12} /></div>
        <div className={css.card}><Skeleton width={120} height={16} />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={44} />)}</div>
      </div>
      <div className={css.side}><Skeleton height={640} /></div>
    </div>
  </div></Page>;
}
