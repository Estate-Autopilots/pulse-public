"use client";
// STAFF-UX (owner, 28 Oct 2026; telemetry: one person pressed a profile's "Work" tab 37 times in a few seconds): a tab
// in the URL (?tab=) is a server page, so the press used to change nothing on screen until that page arrived. The tab
// now moves at once (it is the current one while its page loads) and shows that it is loading; a second press on the
// tab that is already on its way does nothing.
import Link from "next/link";
import { useState, type ReactNode } from "react";
import styles from "./ui.module.css";

export type QueryTab = { key: string; href: string; label: ReactNode; dest?: string };

export function QueryTabsNav({ items, current, segmented, sub, pages, label }: { items: QueryTab[]; current: string; segmented: boolean; sub?: boolean; pages?: boolean; label: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [seen, setSeen] = useState(current);
  // The page arrived (or the address changed some other way): the URL's tab is the truth again.
  if (seen !== current) { setSeen(current); setChosen(null); }
  const shown = chosen ?? current;
  const on = (key: string) => (key === shown ? (sub && !pages ? "true" : "page") : undefined);
  return <nav suppressHydrationWarning className={segmented ? styles.segmented : styles.tabs} aria-label={label} aria-busy={chosen && chosen !== current ? true : undefined}>
    {items.map((t) => <Link key={t.key} href={t.href} scroll={false} className={segmented ? styles.segment : styles.tab} aria-current={on(t.key)} data-dest={t.dest}
      data-pending={chosen === t.key && chosen !== current ? "" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (t.key === shown) { if (t.key === current) return; e.preventDefault(); return; }
        setChosen(t.key);
      }}>{t.label}</Link>)}
  </nav>;
}
