import { Page, Skeleton, styles } from "../ui";

export default function Loading() {
  return <Page><div role="status" aria-busy="true" className={styles.stack}>
    <span className={styles.srOnly}>Loading designers</span>
    <div className={styles.headerText} aria-hidden="true"><Skeleton width={150} height={20} /><Skeleton width={250} height={12} /></div>
    <div className={styles.panel + " " + styles.panelBody + " " + styles.stack} aria-hidden="true">
      <Skeleton width={180} height={14} />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={30} />)}
    </div>
  </div></Page>;
}
