"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import css from "./sections.module.css";
import styles from "./ui.module.css";

/** Secondary views keep the available height for one task. The URL preserves the view when reloaded or shared.
 *  LAYOUT-SWEEP: every view's name is always shown in full; a row wider than its place scrolls sideways (faded edges)
 *  and wraps on a phone, so no view waits behind arrows. */
export function Sections({ items, param = "section", initial = 0, wrap }: { items: { label: string; content: ReactNode }[]; param?: string; initial?: number; /** All views on one row that wraps on a phone, never paged behind arrows. */ wrap?: boolean }) {
  const search = useSearchParams(); const pathname = usePathname();
  const requested = search.get(param); const index = Math.max(0, items.findIndex((x) => x.label === requested));
  const selected = requested ? index : Math.min(initial, items.length - 1);
  const bar = useRef<HTMLDivElement>(null);
  const keyboardFocus = useRef(false);
  useEffect(() => { if (keyboardFocus.current) { bar.current?.querySelector<HTMLButtonElement>('button[aria-current]')?.focus(); keyboardFocus.current = false; } }, [selected]);
  const choose = (at: number, keyboard = false) => { if (keyboard) { if (at === selected) bar.current?.querySelector<HTMLButtonElement>('button[aria-current]')?.focus(); else keyboardFocus.current = true; } const q = new URLSearchParams(search.toString()); q.set(param, items[at].label); history.replaceState(null, "", `${pathname}?${q}`); };
  if (!items.length) return null;
  return <div className={css.workspace} data-grow="" data-section-param={param}>
    {items.length > 1 ? <div ref={bar} className={css.toolbar}>
      <nav suppressHydrationWarning className={`${styles.segmented} ${css.tabs}`} data-wrap={wrap ? "" : undefined} aria-label="Views" onKeyDown={(event) => { if (["Home", "End"].includes(event.key)) { event.preventDefault(); choose(event.key === "Home" ? 0 : items.length - 1, true); } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); choose((selected + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length, true); } }}>
        {items.map((x, i) => <button type="button" key={x.label} className={styles.segment} aria-current={selected === i ? "true" : undefined} onClick={() => choose(i)}>{x.label}</button>)}
      </nav>
    </div> : null}
    {items.map((x, i) => <div key={x.label} hidden={i !== selected} data-section={x.label} className={css.pane} data-enter="">{x.content}</div>)}
  </div>;
}
