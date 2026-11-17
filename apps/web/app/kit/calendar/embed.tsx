"use client";
// CALENDAR-HUB (owner, 13 Nov 2026, P2.1 T2.1.4: "PR Studio, Projects and HR show filtered views of the same calendar"):
// the one calendar for any screen, reading its own items. A screen says which kinds it shows and, when it has one, the
// project or brand: <CalendarEmbed kinds={["milestone", "task"]} project={id} />. The same API answers /calendar
// (GET /api/v0/calendar/items?kinds=…&project=…&brand=…), dragging saves through POST /api/v0/calendar/move, and
// "Open the full calendar" goes to /calendar. Loading, empty and error states are the kit's own.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Calendar, type CalEvent, type CalInput, type CalKind, type CalView } from "./index";
import { EmptyState, SkeletonRows, toast } from "../game";
import { useIsPhone } from "../drawer";
import { dayWords } from "../../lib/calendar.mjs";
import css from "./calendar.module.css";

type Data = { now: string; tz: string; from: string; to: string; items: CalInput[] };
const plus = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** "India time (IST)" for the zones people say by name; the zone's own name otherwise. */
export const zoneWords = (tz: string) => ({ "Asia/Kolkata": "India time (IST)", "Asia/Calcutta": "India time (IST)", "Europe/London": "UK time", "Asia/Dubai": "Gulf time (GST)" } as Record<string, string>)[tz] ?? tz;

/** Save a drag: tasks, posts and the person's own events. Resolves false (the item goes back) when it was refused. */
export async function moveItem(e: CalEvent, start: string): Promise<boolean> {
  const id = e.id.split(":").slice(2).join(":");
  const r = await fetch("/api/v0/calendar/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: e.kind, id, start }) }).catch(() => null);
  if (r?.ok) { toast(`Moved to ${dayWords(start)}${start.length > 10 ? `, ${start.slice(11, 16)}` : ""}`, { tone: "good" }); return true; }
  const why = r ? ((await r.json().catch(() => ({}))) as { error?: string; message?: string }) : {};
  toast(why.error ?? why.message ?? "That did not move. Try again.", { tone: "bad" });
  return false;
}

export function CalendarEmbed({ kinds, project, brand, view, views, label = "Calendar", empty = "Nothing on these days.", title }: {
  kinds: readonly CalKind[]; project?: string; brand?: string; view?: CalView; views?: readonly CalView[]; label?: string; empty?: string;
  /** A heading over the calendar, when the screen has none of its own. */ title?: string }) {
  // On a phone an embed is its agenda list only: the host page already stacks its own tabs above it.
  const phone = useIsPhone();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What to read: the screen's filters (as one key, so an inline kinds array never reads again), the window once the
  // person moves past what was read, and a count that goes up to read again after a change.
  const [win, setWin] = useState<{ from: string; to: string } | null>(null);
  const [again, setAgain] = useState(0);
  const range = useRef<{ from: string; to: string } | null>(null);
  const key = kinds.join(",");
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ kinds: key });
    if (project) q.set("project", project);
    if (brand) q.set("brand", brand);
    if (win) { q.set("from", win.from); q.set("to", win.to); }
    fetch(`/api/v0/calendar/items?${q}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((next: Data | null) => {
      if (!live) return;
      if (next && typeof next.now === "string" && Array.isArray(next.items)) { setData(next); setError(null); range.current = { from: next.from, to: next.to }; }
      else setError("The calendar did not load. Try again in a moment.");
    });
    return () => { live = false; };
  }, [key, project, brand, win, again]);
  const more = useCallback((from: string, to: string) => {
    const r = range.current;
    if (r && from >= r.from && to <= r.to) return;
    setWin({ from: plus(from, -35), to: plus(to, 70) });
  }, []);
  const move = useCallback(async (e: CalEvent, start: string) => { const ok = await moveItem(e, start); if (ok) setAgain((n) => n + 1); return ok; }, []);

  return <section className={css.embed} aria-label={label}>
    {title ? <h2 className={css.embedTitle}>{title}</h2> : null}
    {error && !data ? <EmptyState art="nothing" title="The calendar did not load" text={error} action={{ label: "Try again", onClick: () => { setError(null); setAgain((n) => n + 1); } }} />
      : !data ? <SkeletonRows rows={4} height={56} label="Loading the calendar" />
      : <Calendar label={label} events={data.items} now={data.now} kinds={kinds} view={phone ? "list" : view} views={phone ? ["list"] : views} empty={empty} agendaDays={14}
          onRange={more} onMove={move}
          foot={<span className={css.embedFoot}>Times are {zoneWords(data.tz)}.<Link href="/calendar" className={css.embedLink}>Open the full calendar<ArrowRight size={14} aria-hidden="true" /></Link></span>} />}
  </section>;
}
