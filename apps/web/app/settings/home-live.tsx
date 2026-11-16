"use client";
// PULSE-POLISH (owner, 14 Nov 2026): the Settings overview's two live parts. A card's value that lives on this device
// (the theme, whether this browser may notify), and the search over every setting the person can open.
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { useTheme } from "@pulse/ui-shell";
import css from "./settings.module.css";

const THEME = { system: "Same as this device", light: "Light", dark: "Dark" } as const;

/** The current value of a setting kept on this device. */
export function DeviceValue({ kind }: { kind: "theme" | "notifications" }) {
  const { preference } = useTheme();
  const [notify, setNotify] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== "notifications") return;
    const p = typeof Notification === "undefined" ? "none" : Notification.permission;
    // Read after the page is drawn, so the server's words and the first paint match.
    const t = window.setTimeout(() => setNotify(p === "granted" ? "On for this device" : p === "denied" ? "Blocked on this device" : p === "none" ? "Not on this browser" : "Not turned on yet"), 0);
    return () => window.clearTimeout(t);
  }, [kind]);
  if (kind === "theme") return <>{THEME[preference] ?? "Same as this device"}</>;
  return <>{notify ?? "On this device"}</>;
}

export type SearchItem = { key: string; label: string; area: string; text: string; words: string; href: string };

/** Search every setting this person can open: its name, its area, what it is for, and the words people type for it. */
export function SettingsSearch({ items }: { items: readonly SearchItem[] }) {
  const [q, setQ] = useState("");
  const id = useId();
  const found = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return items.map((it) => {
      const name = it.label.toLowerCase(), hay = `${name} ${it.area.toLowerCase()} ${it.text.toLowerCase()} ${it.words}`;
      if (!words.every((w) => hay.includes(w))) return null;
      return { it, rank: words.every((w) => name.includes(w)) ? 0 : 1 };
    }).filter((x): x is { it: SearchItem; rank: number } => !!x).sort((a, b) => a.rank - b.rank).slice(0, 6).map((x) => x.it);
  }, [q, items]);
  return <div className={css.ovSearch} role="search">
    <label htmlFor={id} className={css.ovSearchBox}>
      <Search size={17} aria-hidden="true" />
      <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" autoComplete="off"
        aria-controls={`${id}-found`} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} />
      {q ? <button type="button" onClick={() => setQ("")} aria-label="Clear the search"><X size={15} aria-hidden="true" /></button> : null}
    </label>
    {q.trim() ? <ul id={`${id}-found`} className={css.ovFound} aria-live="polite" aria-label="Matching settings">
      {found.length ? found.map((it) => <li key={it.key}><Link href={it.href} className={css.ovFoundRow}>
        <span><b>{it.label}</b><small>{it.area} · {it.text}</small></span><ChevronRight size={15} aria-hidden="true" /></Link></li>)
        : <li className={css.ovNone}>No setting matches “{q.trim()}”. Try another word, like “password” or “dark”.</li>}
    </ul> : null}
  </div>;
}
