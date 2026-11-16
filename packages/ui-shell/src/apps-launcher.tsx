"use client";
// IA-NAV (owner, 10 Nov 2026): "All apps", like a phone's app drawer: every page the person can open, grouped as the
// sidebar groups them, a search box that knows the other words people use ("posts" → PR Studio), a star to pin.
// FIX-SHELL (owner walkthrough, 10 Nov 2026: "a good feature, but things are hidden and it's hard to use; redesign it as a
// clear grid with groups, icons, one-line descriptions, search and recents"; "Growth: black text on a purple panel is
// unreadable, items one per line instead of a grid"):
//   - one search box on top, then Recent (the pages and records opened last), then every group as a section with its
//     own icon and colour, each a grid of tiles of ONE height (icon, name, one short line), so nothing hides below a
//     tile's sub-links (a page's own places are still found by search: "rate cards");
//   - on a computer a list of groups on the left jumps to a section and follows the scroll; on a phone (the More sheet)
//     a row of group chips does it; a chosen chip is solid violet with white words in light and dark;
//   - nothing in the header, search or chips row shrinks when the list is long (the phone's chips were cut in half).
import { Search, Star, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useBackLayer } from "./back-layer";
import { findApps } from "./nav-catalog";
import { NewDot } from "./new-dot";
import styles from "./nav.module.css";

type IconType = React.ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
export type LauncherEntry = Readonly<{ label: string; href: string; Icon: IconType; blurb?: string; words?: readonly string[]; group: string;
  subs: readonly { label: string; href: string; isNew: boolean }[]; isNew: boolean; current: boolean; count?: number }>;
export type LauncherGroup = Readonly<{ key: string; label: string; entries: readonly LauncherEntry[]; Icon?: IconType }>;
export type LauncherRecent = Readonly<{ href: string; title: string; Icon: IconType }>;

/** Each group's own hue (the tile icons and the section mark), so a group is found by colour as well as by name. */
const HUE: Readonly<Record<string, number>> = { home: 258, work: 222, chat: 160, sales: 32, money: 142, people: 330, growth: 14, ai: 276, settings: 230 };

export function AppsLauncher({ open, onClose, groups, pins, onPin, onSearch, sheet, heading, recents = [] }: {
  open: boolean; onClose: () => void; groups: readonly LauncherGroup[]; pins: readonly string[]; onPin: (href: string) => void;
  /** Opens the full search (pages, people, tasks …) when the launcher has no page by that name. */ onSearch: () => void;
  /** The phone's sheet (full height, two columns) instead of the computer's card. */ sheet?: boolean; heading?: React.ReactNode;
  /** FIX-SHELL: the pages and records opened last (the sidebar's Recents), newest first. */ recents?: readonly LauncherRecent[] }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // A group chosen in the list stays marked while its jump scrolls (the last groups cannot reach the top of the box).
  const jumping = useRef<{ key: string; until: number } | null>(null);
  useBackLayer(open, onClose);
  useEffect(() => {
    if (!open) return;
    setQuery(""); setAt(null);
    // A phone's keyboard would cover the sheet: the box is focused only on a computer.
    if (!sheet) window.setTimeout(() => input.current?.focus(), 0);
  }, [open, sheet]);
  const all = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const found = useMemo(() => {
    if (!query.trim()) return null;
    const subs = all.flatMap((e) => e.subs.filter((s) => !all.some((x) => x.href === s.href))
      .map((s): LauncherEntry => ({ label: s.label, href: s.href, Icon: e.Icon, blurb: `In ${e.label}`, group: e.group, subs: [], isNew: s.isNew, current: false, words: [] })));
    return findApps([...all, ...subs].map((e) => ({ ...e, parent: e.blurb?.startsWith("In ") ? e.blurb : undefined })), query).slice(0, 24);
  }, [all, query]);
  // The section in view marks its group in the list (and the chips); a click on a group scrolls to its section.
  useEffect(() => {
    const box = body.current;
    if (!open || found || !box) return;
    const onScroll = () => {
      if (jumping.current && Date.now() < jumping.current.until) return;
      jumping.current = null;
      const top = box.getBoundingClientRect().top;
      const sections = [...box.querySelectorAll<HTMLElement>("[data-launcher-group]")];
      const current = sections.filter((s) => s.getBoundingClientRect().top - top < 48).at(-1) ?? sections[0];
      setAt(current?.dataset.launcherGroup ?? null);
    };
    onScroll();
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [open, found]);
  if (!open) return null;
  const pinned = pins.map((href) => all.find((e) => e.href === href)).filter((e): e is LauncherEntry => !!e);
  const groupKey = (label: string) => groups.find((g) => g.label === label)?.key ?? "home";
  const jump = (key: string) => {
    const el = body.current?.querySelector<HTMLElement>(`[data-launcher-group="${CSS.escape(key)}"]`);
    if (!el || !body.current) return;
    setAt(key); jumping.current = { key, until: Date.now() + 900 };
    body.current.scrollTo({ top: el.offsetTop - 4, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Enter" && found?.[0]) { event.preventDefault(); (document.querySelector(`[data-launcher-first]`) as HTMLAnchorElement | null)?.click(); }
  };
  const hue = (key: string) => ({ "--g-hue": HUE[key] ?? 258 }) as CSSProperties;
  const tile = (e: LauncherEntry, first = false) => (
    <div key={e.href} className={styles.tile} data-current={e.current ? "" : undefined} data-nav-id={`apps:${e.href}`} style={hue(groupKey(e.group))}>
      <Link href={e.href} className={styles.tileLink} onClick={onClose} data-launcher-first={first ? "" : undefined} aria-current={e.current ? "page" : undefined}>
        <span className={styles.tileIcon} aria-hidden="true"><e.Icon size={18} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className={styles.tileText}><span className={styles.tileName}><span className={styles.tileNameText}>{e.label}</span><NewDot on={e.isNew || e.subs.some((s) => s.isNew)} place="after" count={e.count} /></span>{e.blurb ? <small>{e.blurb}</small> : null}</span>
      </Link>
      <button type="button" className={styles.pin} aria-pressed={pins.includes(e.href)} aria-label={pins.includes(e.href) ? `Unpin ${e.label}` : `Pin ${e.label} to the menu`}
        title={pins.includes(e.href) ? "Pinned to the top of your menu" : "Pin to the top of your menu"} onClick={() => onPin(e.href)}><Star size={14} strokeWidth={1.9} aria-hidden="true" /></button>
    </div>
  );
  const section = (key: string, label: string, Icon: IconType | undefined, entries: readonly LauncherEntry[]) => (
    <section key={key} className={styles.launcherGroup} aria-label={label} data-launcher-group={key} style={hue(key)}>
      <h3>{Icon ? <span className={styles.groupMark} aria-hidden="true"><Icon size={14} strokeWidth={2} aria-hidden="true" /></span> : null}{label}</h3>
      <div className={styles.grid}>{entries.map((e) => tile(e))}</div>
    </section>
  );
  const recentList = recents.slice(0, sheet ? 4 : 6);
  const recentRow = recentList.length ? <section className={styles.recentRow} aria-label="Recent"><h3>Recent</h3><div className={styles.recentChips}>
    {recentList.map((r) => <Link key={r.href} href={r.href} className={styles.recentChip} onClick={onClose} title={r.title}><r.Icon size={14} strokeWidth={1.9} aria-hidden="true" /><span>{r.title}</span></Link>)}
  </div></section> : null;
  return (
    <div className={styles.launcherBackdrop} data-sheet={sheet ? "" : undefined} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={styles.launcher} role="dialog" aria-modal="true" aria-label="All apps" data-sheet={sheet ? "" : undefined}>
        <header className={styles.launcherHead}>
          <div className={styles.launcherTitle}>{heading}<h2>All apps</h2></div>
          {/* MOBILE-QA: a phone has no Ctrl+K, so All apps carries the way into the full search (tasks, people, chats).
              FIX-SHELL (judge: "two searches"): a computer has one search box here; tasks, people and chats are offered
              when no page matches, and Ctrl+K searches everything. */}
          <span className={styles.launcherActions}>
            {sheet ? <button type="button" className={styles.launcherSearchBtn} onClick={() => { onClose(); onSearch(); }}><Search size={15} aria-hidden="true" /><span>Search everything</span></button> : null}
            <button type="button" className={styles.launcherClose} aria-label="Close All apps" onClick={onClose}><X size={18} aria-hidden="true" /></button>
          </span>
        </header>
        <label className={styles.launcherSearch}>
          <Search size={17} aria-hidden="true" />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey} placeholder="Find any page… try “invoice” or “posts”"
            aria-label="Find any page" autoComplete="off" spellCheck={false} enterKeyHint="go" />
        </label>
        {!sheet && !found ? recentRow : null}
        {sheet && !found ? <div className={styles.chips} role="tablist" aria-label="Go to a group">
          {groups.map((g) => <button key={g.key} type="button" role="tab" aria-selected={at === g.key} className={styles.chip} onClick={() => jump(g.key)}>{g.label}</button>)}
        </div> : null}
        <div className={styles.launcherMain} data-searching={found ? "" : undefined}>
          {!sheet && !found ? <nav className={styles.groupList} aria-label="Groups">
            {groups.map((g) => <button key={g.key} type="button" className={styles.groupLink} aria-current={at === g.key ? "true" : undefined} onClick={() => jump(g.key)} style={hue(g.key)}>
              {g.Icon ? <span className={styles.groupMark} aria-hidden="true"><g.Icon size={14} strokeWidth={2} aria-hidden="true" /></span> : null}<span>{g.label}</span>
            </button>)}
          </nav> : null}
          <div className={styles.launcherBody} ref={body}>
            {found ? found.length ? <div className={styles.grid} aria-label={`Pages for “${query.trim()}”`}>{found.map((e, i) => tile(e, i === 0))}</div>
              : <div className={styles.launcherEmpty}><p>No page called “{query.trim()}”.</p><button type="button" className={styles.launcherSearchAll} onClick={() => { onClose(); onSearch(); }}>Search tasks, people and chats</button></div>
              : <>
                {sheet ? recentRow : null}
                {pinned.length ? <section className={styles.launcherGroup} aria-label="Pinned"><h3><span className={styles.groupMark} data-pinned="" aria-hidden="true"><Star size={13} strokeWidth={2} aria-hidden="true" /></span>Pinned</h3><div className={styles.grid}>{pinned.map((e) => tile(e))}</div></section> : null}
                {groups.map((g) => section(g.key, g.label, g.Icon, g.entries))}
              </>}
          </div>
        </div>
      </section>
    </div>
  );
}
