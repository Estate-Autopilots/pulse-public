"use client";
// AGENT-UI-CONTROL: the side view, for "open it beside me" on a page without the chat's side panel (the panel lives in
// Chats). One thing at a time on the right (a sheet from the bottom on a phone): a Pulse page framed on its own (embed=1),
// a chat file, a Google Doc or Drive file, or a web page when the site allows framing (else a card that opens it in a new
// tab). The same framing rules as the chat's panel (panel-target.mjs, /api/frame-check). Escape or × closes it.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ExternalLink, Maximize2, Sparkles, X } from "lucide-react";
import type { PanelTarget } from "../lib/panel-target.mjs";
import css from "./agent-ui.module.css";

type View = PanelTarget & { by: string };
let view: View | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export function openSideView(target: PanelTarget, by: string) { view = { ...target, by }; emit(); }
/** Whether a side view is open (the prompt tray keeps to its left). */
export const useSideViewOpen = () => useSyncExternalStore(subscribe, () => view !== null, () => false);
/** Closes it; false when nothing was open. */
export function closeSideView() { if (!view) return false; view = null; emit(); return true; }

type Check = { embeddable: boolean; site?: string; title?: string };
export function SideView() {
  const v = useSyncExternalStore(subscribe, () => view, () => null);
  const [check, setCheck] = useState<{ src: string; c: Check } | null>(null);
  useEffect(() => {
    if (!v) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") closeSideView(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [v]);
  useEffect(() => {
    if (!v || v.kind !== "url" || !v.embed) return;
    let live = true;
    void fetch(`/api/frame-check?url=${encodeURIComponent(v.src)}`).then((r) => r.ok ? r.json() as Promise<Check> : { embeddable: false }).catch(() => ({ embeddable: false }))
      .then((c) => { if (live) setCheck({ src: v.src, c }); });
    return () => { live = false; };
  }, [v]);
  if (!v) return null;
  const framed = v.embed && (v.kind !== "url" || (check?.src === v.src && check.c.embeddable));
  const waiting = v.kind === "url" && v.embed && check?.src !== v.src;
  const sandbox = v.kind === "page" || v.kind === "file" ? undefined : "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
  return <aside className={css.side} aria-label={`${v.title}, opened by ${v.by}`} data-agent-ui="" data-side-view="">
    <header className={css.sideHead}>
      <strong title={v.title}>{v.title}</strong>
      <em><Sparkles size={12} aria-hidden="true" /> {v.by}</em>
      {v.kind === "page" ? <a className={css.iconBtn} href={v.href} aria-label="Open the full page" title="Open the full page"><Maximize2 size={15} aria-hidden="true" /></a>
        : <a className={css.iconBtn} href={v.href} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab"><ExternalLink size={15} aria-hidden="true" /></a>}
      <button type="button" className={css.iconBtn} onClick={() => closeSideView()} aria-label="Close the side view" title="Close · Escape"><X size={16} aria-hidden="true" /></button>
    </header>
    {framed ? <iframe key={v.src} className={css.frame} src={v.src} title={v.title} sandbox={sandbox} referrerPolicy={v.kind === "page" ? undefined : "no-referrer"} allow="clipboard-write; fullscreen" />
      : <div className={css.sideNote}>{waiting ? <p role="status">Checking the site…</p> : <>
        <p>{check?.c.site ?? v.title} does not open inside Pulse.</p>
        <p><a className={css.primary} href={v.href} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Open in a new tab</a></p></>}</div>}
  </aside>;
}
