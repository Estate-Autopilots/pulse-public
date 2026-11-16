"use client";
// NEW-DOTS-2: a line of What's new that takes the person to the thing that changed ("take me there"): the page opens,
// what is on the way opens, and the spotlight shows the thing (new-trail.tsx). A change to a whole page just opens it.
import Link from "next/link";
import type { ReactNode } from "react";
import { travelTo } from "../new-dots-host";

export function ShowMe({ route, anchor, href, className, children }: { route: string; anchor: string; href: string; className?: string; children: ReactNode }) {
  return <Link href={href} className={className} onClick={() => travelTo(route, anchor)} data-new-show={anchor || undefined}>{children}</Link>;
}
