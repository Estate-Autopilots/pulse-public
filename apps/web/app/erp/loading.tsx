import { Page, Skeleton, styles } from "../ui";
import { ERP_SECTIONS } from "./nav";
import css from "./nav.module.css";

// BILLING (18 Oct 2026): what every Billing page shows while it loads: its title, the sections row as it will be, and
// one-line rows the height of the real ones, so nothing jumps when the page arrives.
export default function Loading() {
  return <Page><div role="status" aria-busy="true" className={styles.stack} style={{ gap: 14 }}>
    <span className={styles.srOnly}>Loading Billing</span>
    <div className={styles.headerText} aria-hidden="true"><Skeleton width={140} height={22} /><Skeleton width={240} height={13} /></div>
    <nav className={css.sections} aria-hidden="true">{ERP_SECTIONS.filter((s) => s.key !== "inventory").map((s) => <span key={s.key} className={css.section}>{s.label}</span>)}</nav>
    <div aria-hidden="true" style={{ display: "grid", gap: 10 }}>
      <Skeleton height={36} />
      <div className={styles.panel} style={{ padding: 0, overflow: "hidden" }}>{Array.from({ length: 8 }, (_, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "8px 14px", borderTop: i ? "1px solid var(--theme-border)" : 0 }}>
        <div style={{ flex: 1, display: "grid", gap: 6 }}><Skeleton width={`${40 + ((i * 17) % 35)}%`} height={13} /><Skeleton width="28%" height={10} /></div><Skeleton width={72} height={14} /></div>)}</div>
    </div>
  </div></Page>;
}
