import { Page, Skeleton, styles } from "../ui";

export default function Loading() {
  return <Page><div role="status" aria-busy="true" className={styles.stack}>
    <span className={styles.srOnly}>Loading your week</span>
    <div className={styles.headerText} aria-hidden="true"><Skeleton width={140} height={20} /><Skeleton width={280} height={12} /></div>
    <div className={styles.tiles} data-count="3" aria-hidden="true">{Array.from({ length: 3 }, (_, i) => <div key={i} className={styles.tile}><Skeleton width="55%" height={12} /><Skeleton width={52} height={24} /><Skeleton width="80%" height={11} /></div>)}</div>
    <div className={styles.grid2} aria-hidden="true">
      <div className={`${styles.panel} ${styles.panelBody} ${styles.stack}`}><Skeleton width={160} height={14} />{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={28} />)}</div>
      <div className={`${styles.panel} ${styles.panelBody} ${styles.stack}`}><Skeleton width={170} height={14} />{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={28} />)}</div>
    </div>
  </div></Page>;
}
