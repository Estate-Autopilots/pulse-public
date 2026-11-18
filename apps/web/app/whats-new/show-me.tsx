"use client";
// NEW-DOTS-2: a line of What's new that takes the person to the thing that changed ("take me there"): the page opens,
// what is on the way opens, and the spotlight shows the thing (new-trail.tsx). A change to a whole page just opens it.
// NAV-CONNECT (owner, 17 Nov 2026: "doesn't take you to the specific item arrow by arrow"): on a computer the way there
// is shown first, step by step with an arrow each (new-path.tsx): the side menu's group, the page in its list, then the
// thing (or the page as a whole). A phone, or a click with a key held (a new tab), opens the page as before.
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { travelTo } from "../new-dots-host";
import { startPath } from "../new-path";

export function ShowMe({ route, anchor, href, text, className, children }: { route: string; anchor: string; href: string; text?: string; className?: string; children: ReactNode }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0;
    if (plain && text && matchMedia("(hover: hover) and (pointer: fine)").matches && startPath({ route, anchor, href, text })) { e.preventDefault(); return; }
    travelTo(route, anchor);
  };
  return <Link href={href} className={className} onClick={go} data-new-show={anchor || undefined} data-new-path-start="">{children}</Link>;
}
