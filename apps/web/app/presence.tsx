"use client";
// CHATS-2: presence everywhere a person appears. One store for the whole app (filled by one poll a minute while Pulse is
// visible, which is also what makes you "active"), a dot on the avatar, a line of words, and the dialog where you set
// a status and do-not-disturb. The data is a category only (in the office, on a shoot…): never a time or a leave type.
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Check, X } from "lucide-react";
import { lastSeen, presenceLabel, type Presence } from "./lib/chat-format.mjs";
import { weekday, zoneDay, zoneTime } from "./lib/zone.mjs";
import { useOrgZone } from "./org-code";
import css from "./presence.module.css";

export type MyStatus = { text: string | null; emoji: string | null; until: string | null; dnd: boolean; dndUntil: string | null };
type Store = { people: Record<string, Presence>; me: MyStatus | null; at: number };
const EMPTY: Store = { people: {}, me: null, at: 0 };
const KEY = "pulse.presence.v1";
let store: Store = EMPTY, loaded = false, inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => {
  if (!loaded && typeof window !== "undefined") { loaded = true; try { const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Store | null; if (raw && Date.now() - raw.at < 600000) store = raw; } catch { /* private mode */ } }
  return store;
};
/** Fetch everyone's presence now. `touch` says "I am here" (only while Pulse is visible). */
export function refreshPresence(touch = false) {
  inflight ??= fetch(`/api/v0/presence${touch ? "?touch=1" : ""}`, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) return; const d = await r.json() as { people: Record<string, Presence>; me: MyStatus };
    store = { people: d.people, me: d.me, at: Date.now() }; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* full */ }
    listeners.forEach((l) => l());
  }).catch(() => { /* offline: the dots keep their last state */ }).finally(() => { inflight = null; });
  return inflight;
}
export function usePresenceStore() { return useSyncExternalStore(subscribe, snapshot, () => EMPTY); }
export function usePresence(id?: string | null) { const s = usePresenceStore(); return id ? s.people[id] ?? null : null; }

/** Mounted once in the layout: a poll a minute while the tab is visible, and at once when it becomes visible. */
export function PresencePoller() {
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void refreshPresence(true); };
    tick(); const timer = window.setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  return null;
}

/** The dot on an avatar: colour and shape by state (do-not-disturb, away and offline differ in shape, not only colour). */
export function PresenceDot({ id, size = 32 }: { id: string; size?: number }) {
  const p = usePresence(id); if (!p) return null;
  const { label, tone, status } = presenceLabel(p);
  return <i className={css.dot} data-tone={tone} role="img" aria-label={label} title={[label, status].filter(Boolean).join(" · ")} style={{ "--dot": `${Math.max(9, Math.round(size * 0.3))}px` } as CSSProperties} />;
}

/** "In the office · 🎬 Back at 6", or when someone is away or offline, when Pulse was last open. */
export function PresenceLine({ id, className }: { id: string; className?: string }) {
  const p = usePresence(id); if (!p) return null;
  const { label, tone, status } = presenceLabel(p);
  const seen = p.state === "away" || p.state === "offline" ? lastSeen(p.activeAt) : "";
  return <span className={`${css.line}${className ? ` ${className}` : ""}`} data-tone={tone}><i aria-hidden="true" />{status ? <><b>{status}</b><span>{label}</span></> : <span>{seen && p.state === "offline" ? seen : label}</span>}</span>;
}

const PRESETS: [string, string, number | "today"][] = [["📅", "In a meeting", 60], ["🎬", "On a shoot", "today"], ["🚗", "Commuting", 30], ["🎧", "Focusing", 120], ["🤒", "Out sick", "today"], ["🌴", "On holiday", "today"]];
const CLEAR: [string, number | "today" | "week"][] = [["30 minutes", 30], ["1 hour", 60], ["4 hours", 240], ["Today", "today"], ["This week", "week"]];
const DND: [string, number | "tomorrow" | "infinity" | 0][] = [["Off", 0], ["1 hour", 60], ["Until tomorrow", "tomorrow"], ["Until I turn it off", "infinity"]];
/** End of today / this week on the company's clock (its time zone), 9 am tomorrow there, or minutes from now. */
function untilFrom(choice: number | "today" | "week" | "tomorrow", zone: string): string {
  if (typeof choice === "number") return new Date(Date.now() + choice * 60000).toISOString();
  const today = zoneDay(zone), shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const day = shift(today, choice === "week" ? (7 - weekday(today)) % 7 : choice === "tomorrow" ? 1 : 0);
  return choice === "tomorrow" ? zoneTime(day, zone, "09:00").toISOString() : new Date(zoneTime(shift(day, 1), zone).getTime() - 1000).toISOString();
}

/** Set a status line (emoji, text, when it clears) and do-not-disturb. Do-not-disturb silences pings on every device. */
export function StatusDialog({ onClose }: { onClose: () => void }) {
  const { me } = usePresenceStore(), zone = useOrgZone();
  const [emoji, setEmoji] = useState(me?.emoji ?? ""), [text, setText] = useState(me?.text ?? "");
  const [clear, setClear] = useState<number | "today" | "week">(60), [dnd, setDnd] = useState<number | "tomorrow" | "infinity" | 0>(me?.dndUntil === "infinity" ? "infinity" : me?.dnd ? 60 : 0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  async function save(reset = false) {
    setBusy(true); setError("");
    try {
      const body = reset ? { text: null, emoji: null, until: null, dndUntil: null }
        : { text: text.trim() || null, emoji: emoji || null, until: text.trim() || emoji ? untilFrom(clear, zone) : null, dndUntil: dnd === 0 ? null : dnd === "infinity" ? "infinity" : untilFrom(dnd, zone) };
      const r = await fetch("/api/v0/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not save your status");
      await refreshPresence(); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-label="Your status">
      <header><h2>Your status</h2><button type="button" className={css.icon} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
      <p className={css.hint}>Colleagues see where you are from Pulse (in the office, from home, on a break…). Add a line of your own.</p>
      <label className={css.field}><input className={css.emoji} value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 8))} aria-label="Emoji" placeholder="🙂" />
        <input value={text} onChange={(e) => setText(e.target.value.slice(0, 80))} placeholder="What’s your status?" aria-label="Status" autoFocus maxLength={80} /></label>
      <div className={css.presets} role="group" aria-label="Suggestions">{PRESETS.map(([e, t, c]) => <button key={t} type="button" aria-pressed={text === t} onClick={() => { setEmoji(e); setText(t); setClear(c); }}><span aria-hidden="true">{e}</span>{t}</button>)}</div>
      <div className={css.row}><span>Clear after</span><div className={css.chips} role="radiogroup" aria-label="Clear after">{CLEAR.map(([l, v]) => <button key={l} type="button" role="radio" aria-checked={clear === v} onClick={() => setClear(v)}>{l}</button>)}</div></div>
      <div className={css.row}><span>Do not disturb</span><div className={css.chips} role="radiogroup" aria-label="Do not disturb">{DND.map(([l, v]) => <button key={l} type="button" role="radio" aria-checked={dnd === v} onClick={() => setDnd(v)}>{l}</button>)}</div></div>
      {dnd !== 0 ? <p className={css.hint}>Chats and updates still arrive in Pulse; your phone, desktop and Telegram stay quiet.</p> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <footer>{me?.text || me?.dnd ? <button type="button" className={css.quiet} disabled={busy} onClick={() => void save(true)}>Clear status</button> : <span />}
        <button type="button" className={css.primary} disabled={busy} onClick={() => void save()}><Check size={15} aria-hidden="true" />{busy ? "Saving…" : "Save"}</button></footer>
    </div>
  </div>;
}
