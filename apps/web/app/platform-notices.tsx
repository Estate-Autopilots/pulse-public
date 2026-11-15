"use client";
// PULSE-ADMIN (1140): announcements from Pulse's platform admins (Admin console → Announcements), shown to every
// signed-in person of every organisation until they end. A calm card at the bottom corner, out of the page's way;
// closing one hides it on this browser.
// RELEASE-COMMS (owner, 7 Nov 2026): the same corner says when the app was updated since this person last looked
// ("Vitals OS was updated", linking to /whats-new) once per release; a first visit only remembers the newest release.
import { Info, TriangleAlert, CircleCheck, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { updateNote } from "./lib/release-notes.mjs";
import { rememberRelease, seenRelease, SEEN_EVENT } from "./release-seen";
import css from "./platform-notices.module.css";

type Notice = { id: string; title: string; body: string | null; tone: "info" | "warning" | "success"; link: string | null };
const KEY = "pulse.platform-notices.closed";
const closedIds = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };

export function PlatformNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [update, setUpdate] = useState<{ id: number; headline: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/v0/platform-notices").then((r) => (r.ok ? r.json() : { notices: [] })).then((d: { notices?: Notice[] }) => {
      if (!live) return; const closed = closedIds(); setNotices((d.notices ?? []).filter((n) => !closed.includes(n.id)));
    }).catch(() => undefined);
    // RELEASE-COMMS: the newest release; /whats-new itself remembers it (whats-new/seen.tsx), so no note there.
    if (!location.pathname.startsWith("/whats-new")) {
      fetch("/api/v0/whats-new?limit=1").then((r) => (r.ok ? r.json() : null)).then((d: { notes?: { id: number; headline: string }[] } | null) => {
        const newest = d?.notes?.[0];
        if (!newest) return;
        // Remembered even when this page has moved on (a first visit must not show the note on the next page).
        const next = updateNote(seenRelease(), newest.id);
        if (next.remember) rememberRelease(next.remember);
        if (live && next.show) setUpdate({ id: newest.id, headline: newest.headline });
      }).catch(() => undefined);
    }
    const seen = () => setUpdate(null);
    window.addEventListener(SEEN_EVENT, seen);
    return () => { live = false; window.removeEventListener(SEEN_EVENT, seen); };
  }, []);
  if (!notices.length && !update) return null;
  const close = (id: string) => {
    try { localStorage.setItem(KEY, JSON.stringify([...closedIds(), id].slice(-50))); } catch { /* private mode */ }
    setNotices((n) => n.filter((x) => x.id !== id));
  };
  const closeUpdate = () => { if (update) rememberRelease(update.id); setUpdate(null); };
  return <aside className={css.stack} aria-label="Announcements from Pulse">
    {update ? <div className={css.card} data-tone="info" role="status" data-update="">
      <Sparkles size={16} aria-hidden="true" className={css.icon} />
      <div className={css.text}><b>Vitals OS was updated</b><p>{update.headline}</p>
        <Link href="/whats-new" onClick={closeUpdate}>See what&apos;s new</Link></div>
      <button type="button" className={css.close} onClick={closeUpdate} aria-label="Close: Vitals OS was updated"><X size={14} aria-hidden="true" /></button>
    </div> : null}
    {notices.map((n) => { const Icon = n.tone === "warning" ? TriangleAlert : n.tone === "success" ? CircleCheck : Info;
      return <div key={n.id} className={css.card} data-tone={n.tone} role="status">
        <Icon size={16} aria-hidden="true" className={css.icon} />
        <div className={css.text}><b>{n.title}</b>{n.body ? <p>{n.body}</p> : null}
          {n.link ? n.link.startsWith("/") ? <Link href={n.link}>Read more</Link> : <a href={n.link} target="_blank" rel="noreferrer">Read more</a> : null}</div>
        <button type="button" className={css.close} onClick={() => close(n.id)} aria-label={`Close: ${n.title}`}><X size={14} aria-hidden="true" /></button>
      </div>; })}
  </aside>;
}
