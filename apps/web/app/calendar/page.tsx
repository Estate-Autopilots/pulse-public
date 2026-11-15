import { api, holdAtGate } from "../lib/api";
import { CalendarScreen, type CalData, type GoogleState } from "./view";

export const metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

/** FIX-PR-CALENDAR (owner, 10 Nov 2026) and CALENDAR-HUB (owner, 13 Nov 2026, P2.1): the one calendar for everything.
 *  "My calendar": the person's tasks due, project milestones, meetings, their own events (and their Google Calendar's),
 *  PR posts, leave and their time at work (services/api/src/one-calendar.ts). "My companies" (?view=companies): which
 *  company takes which day and hours, for someone who works in two or more. Both on the one calendar (kit/calendar). */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await holdAtGate();
  const q = await searchParams;
  const [r, roles, google] = await Promise.all([api<CalData>("calendar/items"), api<{ roles: unknown[] }>("account/roles"), api<GoogleState>("calendar")]);
  // An answer without the calendar's own shape is shown as "did not load", never a crash.
  const ok = r.data && typeof r.data.now === "string" && Array.isArray(r.data.items) ? r.data : null;
  const many = (roles.data?.roles?.length ?? 0) >= 2;
  return <CalendarScreen initial={ok} error={ok ? null : r.error ?? "The calendar did not load."} many={many}
    tab={many && q.view === "companies" ? "companies" : "mine"} google={google.data ?? null} />;
}
