"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./shell.module.css";

/** Rendered by a page to show its own section in the sidebar, under Recents. */
export function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  const [slot, setSlot] = useState<Element | null>(null);
  useEffect(() => { setSlot(document.querySelector("[data-shell-sidebar]")); }, []);
  if (!slot) return null;
  return createPortal(
    <section className={styles.recentsSection} aria-label={title}>
      <div className={styles.recentsHeader}><span className={styles.recentsTitle} style={{ paddingLeft: 8 }}>{title}</span></div>
      <div className={styles.recentsList}>{children}</div>
    </section>, slot);
}

export function SidebarLink({ href, label, note, icon }: { href: string; label: string; note?: string; icon?: ReactNode }) {
  return <Link href={href} className={styles.recentItem} title={note ? `${label} · ${note}` : label}>{icon}<span className={styles.recentName}>{label}</span>{note ? <span className={styles.recentDate}>{note}</span> : null}</Link>;
}
