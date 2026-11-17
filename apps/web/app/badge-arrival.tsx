"use client";
// HR-PEOPLE (owner, 13 Nov 2026, T1.1.3: "red dots must point at the exact thing that needs attention on the page they
// open"): a click on a counting badge (data-badge="<id>", lib/badges.mjs) is remembered for a moment in this tab; the
// page it opens scrolls to the list it counted (data-badge-target="<id>") and lights it for a moment. The list may load
// after the page (a client fetch), so it is looked for a few times. Reduced motion and Fun effects off: a still ring
// (globals.css [data-new-arrive]).
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { BADGE_TRAVEL, badgeTravel } from "./lib/badges.mjs";

export function BadgeArrival() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    const clicked = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-badge]");
      const id = el?.getAttribute("data-badge");
      if (!id) return;
      try { sessionStorage.setItem(BADGE_TRAVEL, JSON.stringify({ id, at: Date.now() })); } catch { /* private mode: no lighting */ }
    };
    document.addEventListener("click", clicked, true);
    return () => document.removeEventListener("click", clicked, true);
  }, []);
  useEffect(() => {
    let travel: { id: string; at: number } | null = null;
    try { travel = badgeTravel(JSON.parse(sessionStorage.getItem(BADGE_TRAVEL) ?? "null")); } catch { travel = null; }
    if (!travel) return;
    const id = travel.id;
    let tries = 0, timer = 0, off = 0;
    const look = () => {
      const target = document.querySelector<HTMLElement>(`[data-badge-target="${CSS.escape(id)}"]`);
      if (!target) { if (++tries < 16) timer = window.setTimeout(look, 250); return; }
      try { sessionStorage.removeItem(BADGE_TRAVEL); } catch { /* ignore */ }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.setAttribute("data-new-arrive", "");
      off = window.setTimeout(() => target.removeAttribute("data-new-arrive"), 2800);
    };
    timer = window.setTimeout(look, 200);
    return () => { window.clearTimeout(timer); window.clearTimeout(off); };
  }, [pathname, search]);
  return null;
}
