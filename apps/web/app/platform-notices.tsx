"use client";
// PULSE-ADMIN (1140): announcements from Pulse's platform admins (Admin console → Announcements), shown to every
// signed-in person of every organisation until they end. A calm card at the bottom corner, out of the page's way;
// closing one hides it on this browser.
import { Info, TriangleAlert, CircleCheck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import css from "./platform-notices.module.css";

type Notice = { id: string; title: string; body: string | null; tone: "info" | "warning" | "success"; link: string | null };
const KEY = "pulse.platform-notices.closed";
const closedIds = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };

export function PlatformNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/v0/platform-notices").then((r) => (r.ok ? r.json() : { notices: [] })).then((d: { notices?: Notice[] }) => {
      if (!live) return; const closed = closedIds(); setNotices((d.notices ?? []).filter((n) => !closed.includes(n.id)));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (!notices.length) return null;
  const close = (id: string) => {
    try { localStorage.setItem(KEY, JSON.stringify([...closedIds(), id].slice(-50))); } catch { /* private mode */ }
    setNotices((n) => n.filter((x) => x.id !== id));
  };
  return <aside className={css.stack} aria-label="Announcements from Pulse">
    {notices.map((n) => { const Icon = n.tone === "warning" ? TriangleAlert : n.tone === "success" ? CircleCheck : Info;
      return <div key={n.id} className={css.card} data-tone={n.tone} role="status">
        <Icon size={16} aria-hidden="true" className={css.icon} />
        <div className={css.text}><b>{n.title}</b>{n.body ? <p>{n.body}</p> : null}
          {n.link ? n.link.startsWith("/") ? <Link href={n.link}>Read more</Link> : <a href={n.link} target="_blank" rel="noreferrer">Read more</a> : null}</div>
        <button type="button" className={css.close} onClick={() => close(n.id)} aria-label={`Close: ${n.title}`}><X size={14} aria-hidden="true" /></button>
      </div>; })}
  </aside>;
}
