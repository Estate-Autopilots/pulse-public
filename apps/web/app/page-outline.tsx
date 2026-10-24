"use client";
// EST-1203: what a page shows while its data loads: its own title, its tab row and the shape of its content in
// skeleton blocks, never the dashboard's tiles or a "Loading…" line. The title is the page's real one, so it does not
// move when the page arrives. A route's loading file also covers its child pages that have none of their own: those
// get a neutral outline (no title, one panel), not the parent page's shape.
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Page, PageHeader, Skeleton, styles } from "./ui";

type Shape = "list" | "detail" | "desk" | "panels" | "form";
const rows = (n: number, height: number) => Array.from({ length: n }, (_, i) => <Skeleton key={i} height={height} />);
const panel = (title: number, body: ReactNode, key?: number) => <div key={key} className={`${styles.panel} ${styles.panelBody} ${styles.stack}`}><Skeleton width={title} height={14} />{body}</div>;

function Body({ shape }: { shape: Shape }) {
  if (shape === "list") return <><Skeleton width="72%" height={34} />{panel(150, rows(8, 40))}</>;
  if (shape === "detail") return <><Skeleton width="64%" height={26} /><Skeleton width="44%" height={28} />
    <div className={`${styles.grid} ${styles.grid2}`}>{panel(120, <><Skeleton height={14} /><Skeleton width="92%" height={14} /><Skeleton width="70%" height={14} />{rows(3, 36)}</>)}{panel(100, rows(5, 22))}</div></>;
  if (shape === "desk") return <><Skeleton height={124} />
    <div className={`${styles.grid} ${styles.grid2}`}>{panel(130, rows(4, 30))}{panel(110, rows(4, 30))}</div></>;
  if (shape === "panels") return <><div className={styles.tiles} data-count="4">{Array.from({ length: 4 }, (_, i) => <div key={i} className={styles.tile}><Skeleton width="55%" height={12} /><Skeleton width={52} height={24} /></div>)}</div>
    <div className={`${styles.grid} ${styles.grid2}`}>{panel(150, rows(5, 30))}{panel(130, rows(5, 30))}</div></>;
  return <>{[0, 1].map((i) => panel(160, Array.from({ length: 3 }, (_, j) => <div key={j} className={styles.stack} style={{ gap: 6 }}><Skeleton width={110} height={12} /><Skeleton height={40} /></div>), i))}</>;
}

/** A page whose own outline is not known (a child page without a loading file, or the app-wide fallback): no title and one
 *  panel, so it never looks like another page. */
export function NeutralOutline() {
  return <Page fit><div role="status" aria-busy="true" className={styles.stack} data-grow="">
    <span className={styles.srOnly}>Loading</span>
    <div className={styles.stack} style={{ gap: 6 }} aria-hidden="true"><Skeleton width={170} height={22} /><Skeleton width={240} height={12} /></div>
    <div aria-hidden="true">{panel(150, rows(6, 36))}</div>
  </div></Page>;
}

/** `tabs`: how many tabs the page shows under its header for most people (0 for none). `only`: the page's own path; on
 *  any other (a child page without a loading file) the outline is neutral. */
export function PageOutline({ title, label, shape, tabs = 0, back, only }: { title: string; label: string; shape: Shape; tabs?: number; back?: { href: string; label: string }; only?: string }) {
  const path = usePathname();
  if (only && path !== only) return <NeutralOutline />;
  return <Page fit>
    <div role="status" aria-busy="true" className={styles.stack} data-grow="">
      <span className={styles.srOnly}>{label}</span>
      <PageHeader title={title} back={back} recent={false} context={[<Skeleton key="context" width={170} height={12} />]} />
      {tabs ? <div className={styles.tabs} aria-hidden="true">{Array.from({ length: tabs }, (_, i) => <span key={i} className={styles.tab}><Skeleton width={54 + (i * 19) % 34} height={12} /></span>)}</div> : null}
      <div className={styles.stack} aria-hidden="true"><Body shape={shape} /></div>
    </div>
  </Page>;
}
