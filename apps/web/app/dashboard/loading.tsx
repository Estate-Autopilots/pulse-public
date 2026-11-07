import { Page, Skeleton, styles } from "../ui";

// EST-1203: the dashboard's own loading screen: its tiles and panels (it was the fallback for every page).

export default function Loading() {
  return (
    <Page>
      <div role="status" aria-busy="true" className={styles.stack} style={{ gap: 16 }}>
        <span className={styles.srOnly}>Loading</span>
        <div className={styles.headerText} aria-hidden="true"><Skeleton width={120} height={22} /><Skeleton width={260} height={13} /></div>
        <div className={styles.tiles} aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.tile} style={{ gap: 8 }}><Skeleton width="60%" height={11} /><span /><Skeleton width={56} height={24} /><span /><Skeleton width="80%" height={10} /></div>)}</div>
        <div className={styles.grid} aria-hidden="true">
          <div className={`${styles.panel} ${styles.span2}`} style={{ padding: 14 }}><Skeleton width={160} height={13} /><div style={{ height: 14 }} /><Skeleton height={190} /></div>
          <div className={styles.panel} style={{ padding: 14, display: "grid", gap: 14 }}><Skeleton width={120} height={13} />{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={26} />)}</div>
        </div>
      </div>
    </Page>
  );
}
