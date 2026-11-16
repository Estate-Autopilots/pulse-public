"use client";
// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.1: "an Apple setting: the settings on the left, and on the right side things
// opening up, with proper breadcrumbs that move back and forth easily, swipe backs, not triggering the page"): Settings
// is two panes. The list on the left stays put while a section opens on the right; every move is a soft navigation
// (the layout is kept, only the section renders), so Back, Forward and the browser's own swipe never reload the page.
// On a phone the panes become a push/pop stack: the list, then the section over it with "‹ Settings" and a swipe from
// the left edge to go back.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { TAB_ICON } from "./icons";
import { Avatar } from "../avatar";
import type { TabKey } from "./types";
import css from "./frame.module.css";

export type FrameArea = { key: string; label: string; hue: number; sections: { key: TabKey; label: string }[] };
export type FramePerson = { name: string; id: string | null; photoAt: string | null; line: string };

const PUSHED = "pulse:settings-pushed";
/** The section a list tap opened (so "‹ Settings" pops back to the list instead of stacking a second list). */
export function markPushed(search: string) { try { sessionStorage.setItem(PUSHED, search); } catch { /* private mode */ } }
/** Back to the parent: pop when the parent is the page below in this tab's history, else open the parent. */
export function usePop() {
  const router = useRouter();
  return useCallback((parent: string) => {
    let pushed = "";
    try { pushed = sessionStorage.getItem(PUSHED) ?? ""; } catch { /* private mode */ }
    if (pushed && pushed === window.location.search) { try { sessionStorage.removeItem(PUSHED); } catch { /* */ } router.back(); }
    else router.push(parent, { scroll: false });
  }, [router]);
}

export function SettingsFrame({ areas, person, badges, children }: { areas: FrameArea[]; person: FramePerson; badges: Partial<Record<TabKey, string>>; children: ReactNode }) {
  const params = useSearchParams();
  const path = usePathname();
  const asked = params.get("tab");
  const keys = new Set(areas.flatMap((a) => a.sections.map((s) => s.key)));
  // Roles & permissions is a part of Who can do what; an unknown section is the overview.
  const current: TabKey | null = path === "/settings" && asked ? (asked === "roles" ? "work-rules" : keys.has(asked as TabKey) ? asked as TabKey : null) : null;
  const pop = usePop();
  const detail = useRef<HTMLDivElement>(null);

  // A new section starts at its top (the list keeps its own scroll). The list's mark of the section it pushed holds only
  // while that section is the page: anywhere else, "‹ Settings" opens the list instead of going back.
  useEffect(() => {
    (detail.current?.firstElementChild as HTMLElement | null)?.scrollTo?.({ top: 0 });
    try { const pushed = sessionStorage.getItem(PUSHED); if (pushed && pushed !== window.location.search) sessionStorage.removeItem(PUSHED); } catch { /* private mode */ }
  }, [current, params]);
  const parent = current && params.get("part") ? `/settings?tab=${current}` : "/settings";

  // Swipe from the left edge to go back, on a touch screen where the section is pushed over the list (a phone).
  useEffect(() => {
    const el = detail.current;
    if (!el || !current) return;
    let x0 = -1, y0 = 0;
    const start = (e: TouchEvent) => { const t = e.touches[0]; x0 = t && t.clientX < 28 && window.matchMedia("(max-width: 759.98px)").matches ? t.clientX : -1; y0 = t?.clientY ?? 0; el.style.transition = ""; };
    const move = (e: TouchEvent) => { if (x0 < 0) return; const t = e.touches[0]; const dx = (t?.clientX ?? 0) - x0; if (dx > 0 && Math.abs((t?.clientY ?? 0) - y0) < 60) el.style.transform = `translateX(${Math.min(dx, 160)}px)`; };
    const end = (e: TouchEvent) => {
      if (x0 < 0) return;
      const t = e.changedTouches[0]; const dx = (t?.clientX ?? 0) - x0, dy = Math.abs((t?.clientY ?? 0) - y0); x0 = -1;
      el.style.transition = "transform 160ms ease"; el.style.transform = "";
      if (dx > 80 && dy < 60) pop(parent);
    };
    el.addEventListener("touchstart", start, { passive: true }); el.addEventListener("touchmove", move, { passive: true }); el.addEventListener("touchend", end);
    return () => { el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); el.removeEventListener("touchend", end); };
  }, [current, pop, parent]);

  // A page of its own under /settings (a sign-in callback) is a pushed detail too.
  return <div className={css.frame} data-open={current || path !== "/settings" ? "detail" : "list"} data-settings-frame="">
    <nav className={css.list} aria-label="Settings sections">
      <p className={css.title} aria-hidden="true">Settings</p>
      <Link href="/settings?tab=account" className={css.me} aria-current={current === "account" ? "page" : undefined} onClick={() => markPushed("?tab=account")} data-settings-row="account">
        {/* PULSE-POLISH: the person's stored photo (initials only when there is none). */}
        <Avatar name={person.name} id={person.id} photoAt={person.photoAt} size={40} />
        <span className={css.meText}><b>{person.name}</b><small>{person.line}</small></span>
        <ChevronRight size={16} className={css.chevron} aria-hidden="true" />
      </Link>
      {areas.map((a) => {
        const rows = a.sections.filter((s) => s.key !== "account");
        if (!rows.length) return null;
        return <section key={a.key} className={css.group} aria-label={a.label} data-settings-area={a.key}>
          <h2 className={css.caption}>{a.label}</h2>
          <ul className={css.inset}>{rows.map((s) => {
            const Icon = TAB_ICON[s.key];
            return <li key={s.key}><Link href={`/settings?tab=${s.key}`} className={css.item} aria-current={s.key === current ? "page" : undefined} onClick={() => markPushed(`?tab=${s.key}`)} data-settings-row={s.key}>
              <span className={css.tile} style={{ "--hue": a.hue } as CSSProperties} aria-hidden="true"><Icon size={15} strokeWidth={2.1} /></span>
              <span className={css.label}>{s.label}</span>
              {badges[s.key] ? <span className={css.badge}>{badges[s.key]}</span> : null}
              <ChevronRight size={15} className={css.chevron} aria-hidden="true" />
            </Link></li>;
          })}</ul>
        </section>;
      })}
    </nav>
    <div className={css.detail} ref={detail}>{children}</div>
  </div>;
}
