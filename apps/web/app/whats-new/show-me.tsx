"use client";
// NEW-DOTS-2: a line of What's new that takes the person to the thing that changed ("take me there"): the page opens,
// what is on the way opens, and the spotlight shows the thing (new-trail.tsx). A change to a whole page just opens it.
// NAV-CONNECT (owner, 17 Nov 2026: "doesn't take you to the specific item arrow by arrow"): on a computer the way there
// is shown first, step by step with an arrow each (new-path.tsx): the side menu's group, the page in its list, then the
// thing (or the page as a whole). A phone, or a click with a key held (a new tab), opens the page as before.
// VITALS-SWEEP (owner, EA, 23 Nov 2026 19:49 UTC): a press that opens another page said nothing until that page came (~4 s
// on a slow line; the owner then opened it in a new tab). Now the line says "Opening…" at once (data-opening, What's new's
// CSS swaps the pill's words) until the address changes; 15 s at most.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { travelTo } from "../new-dots-host";
import { startPath } from "../new-path";
import css from "./whats-new.module.css";

const OPENING_MS = 15_000;

export function ShowMe({ route, anchor, href, text, className, children }: { route: string; anchor: string; href: string; text?: string; className?: string; children: ReactNode }) {
  const pathname = usePathname();
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    if (opening === null) return;
    const t = window.setTimeout(() => setOpening(null), OPENING_MS);
    return () => window.clearTimeout(t);
  }, [opening]);
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0;
    const started = plain && text && matchMedia("(hover: hover) and (pointer: fine)").matches ? startPath({ route, anchor, href, text }) : false;
    if (started) { e.preventDefault(); if (started.opens) setOpening(pathname); return; }
    travelTo(route, anchor);
    if (plain) setOpening(pathname);
  };
  // Opening until the address changes (the page came), or 15 s.
  const busy = opening !== null && opening === pathname;
  return <Link href={href} className={className} onClick={go} data-new-show={anchor || undefined} data-new-path-start="" data-opening={busy ? "" : undefined} aria-busy={busy || undefined}>
    {children}
    {busy ? <span role="status" className={css.srOnly}>Opening…</span> : null}
  </Link>;
}
