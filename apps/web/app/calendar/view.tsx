"use client";
// FIX-PR-CALENDAR: the calendar screen. Concept 1 (a month with a peek on the side) on a computer, concept 3 (the list)
// on a phone. It reads five weeks back and ten ahead, and more when the person moves past that.
// CALENDAR-HUB (owner, 13 Nov 2026, P2.1): one calendar for everything. Click or drag across a slot to add an event there
// ("Add to calendar" does the same from anywhere), drag a task, post or event to move it, and "My companies" (for someone
// who works in two or more) shows which company takes which day and hours (companies.tsx).
import { useCallback, useRef, useState } from "react";
import { CalendarPlus, RefreshCw } from "lucide-react";
import { Calendar, type CalEvent, type CalInput, type CalView } from "../kit/calendar";
import { moveItem, zoneWords } from "../kit/calendar/embed";
import { EmptyState, GamePage, PageHeader, SegmentedTabLinks, toast } from "../kit/game";
import { useIsPhone } from "../kit/drawer";
import { addDays } from "../lib/pr-flow.mjs";
import { AddSheet, type Draft } from "./add-sheet";
import { Companies } from "./companies";
import css from "./hub.module.css";

export type CalData = { now: string; tz: string; from: string; to: string; items: CalInput[]; read: Record<string, boolean> };
export type GoogleState = { on: boolean; connection?: { address: string; status: string } | null };

export function CalendarScreen({ initial, error, many, tab, google }: { initial: CalData | null; error: string | null; many: boolean; tab: "mine" | "companies"; google: GoogleState | null }) {
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [syncing, setSyncing] = useState(false);
  const phone = useIsPhone();
  const loading = useRef(false);
  const today = (data?.now ?? initial?.now ?? "").slice(0, 10);
  const startDraft = useCallback((start?: string, end?: string, allDay?: boolean) => {
    const day = (start ?? today).slice(0, 10) || today;
    setDraft(allDay ? { title: "", day, last: end ?? day, allDay: true, from: "10:00", to: "11:00" }
      : { title: "", day, last: day, allDay: false, from: start && start.length > 10 ? start.slice(11, 16) : "10:00", to: end && end.length > 10 && end.slice(0, 10) === day ? end.slice(11, 16) : "11:00" });
  }, [today]);
  const add = { label: "Add to calendar", onClick: () => startDraft(), icon: CalendarPlus };
  const tabs = many ? <SegmentedTabLinks label="Whose time" size="sm" items={[
    { key: "mine", href: "/calendar", label: "My calendar", current: tab === "mine" },
    { key: "companies", href: "/calendar?view=companies", label: "My companies", current: tab === "companies" }]} /> : null;
  const subtitle = tab === "companies" ? "Which company takes which day and hours." : "Meetings, tasks, milestones, posts, leave and your events.";

  async function reread(from?: string, to?: string) {
    const q = from && to ? `?from=${from}&to=${to}` : data ? `?from=${data.from}&to=${data.to}` : "";
    const r = await fetch(`/api/v0/calendar/items${q}`, { cache: "no-store" }).catch(() => null);
    const next = r?.ok ? await r.json().catch(() => null) as CalData | null : null;
    if (next && typeof next.now === "string" && Array.isArray(next.items)) setData(next);
  }
  async function more(from: string, to: string) {
    if (loading.current || !data || (from >= data.from && to <= data.to)) return;
    loading.current = true;
    try { await reread(addDays(from, -35), addDays(to, 70)); } finally { loading.current = false; }
  }
  const move = async (e: CalEvent, start: string) => { const ok = await moveItem(e, start); if (ok) void reread(); return ok; };
  const remove = async (e: CalEvent) => {
    const id = e.id.split(":").slice(2).join(":");
    const r = await fetch(`/api/v0/calendar/events/${encodeURIComponent(id)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (r?.ok) { toast("Removed from your calendar"); void reread(); return true; }
    const why = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : {};
    toast(why.error ?? "That was not removed. Try again.", { tone: "bad" }); return false;
  };
  async function sync() {
    setSyncing(true);
    try {
      const r = await fetch("/api/v0/calendar/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({})) as { error?: string; fromGoogle?: { added: number; moved: number } };
      if (!r.ok) toast(d.error ?? "Google did not answer. Try again in a minute.", { tone: "bad" });
      else { toast(d.fromGoogle && d.fromGoogle.added + d.fromGoogle.moved > 0 ? `Up to date: ${d.fromGoogle.added + d.fromGoogle.moved} changes from Google` : "Your calendars match now."); await reread(); }
    } finally { setSyncing(false); }
  }

  const connected = !!google?.on && !!google.connection;
  // How to add from the grid, for the view shown (a phone's month is dots and its list has no free time to pick).
  const hint = (v: CalView) => (phone || v === "list" ? "" : v === "month" ? " Click a day, or drag across days, to add something." : " Click or drag across a free time to add something.");
  const foot = data ? (v: CalView) => <span className={css.foot}>
    <span>Times are {zoneWords(data.tz)}.{hint(v)}</span>
    {connected ? <button type="button" className={css.footButton} onClick={() => void sync()} disabled={syncing}><RefreshCw size={14} aria-hidden="true" />{syncing ? "Syncing…" : "Sync with Google"}</button> : null}
  </span> : null;

  return <GamePage label="Calendar">
    {/* "Add to calendar" stays the page's one primary button, peek or not (the peek is its own panel). */}
    <PageHeader title="Calendar" shellTitle subtitle={subtitle} primary={add} side={tabs} />
    {tab === "companies" ? <Companies today={today || null} onAdd={startDraft} />
      : !data ? <EmptyState art="nothing" title="The calendar did not load" text={error ?? "Try again in a moment."} action={{ label: "Try again", href: "/calendar" }} />
      : <Calendar label="Your calendar" events={data.items} now={data.now}
          empty="Nothing on these days. Click a time to add something, or press Add to calendar."
          onRange={(from, to) => { void more(from, to); }} onMove={move} onSlot={startDraft} onRemove={remove}
          connectHref={google?.on && !google.connection ? "/settings?tab=account" : undefined}
          foot={foot} />}
    {draft ? <AddSheet draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); void reread(); }} /> : null}
  </GamePage>;
}
