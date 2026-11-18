import { api, getMe } from "../../lib/api";
import { Message } from "../../ui";
import { Autopilots } from "./autopilots";
import { DayLog } from "./log";
import type { Workload } from "./workload-types";

// FIX-AI-EMPLOYEES (owner walkthrough, 10 Nov 2026, D1): Autopilots is the main view of the AI team: one card per AI
// employee with its role, what it did that day, what it waits on and what it cost (autopilots.tsx). The day log of
// AI-EMP-2 (owner, 25 Oct 2026: what each did, cards and questions waiting, mistakes caught) is its second tab (log.tsx).
// Admins and leaders see every AI employee, a manager theirs: GET /api/v0/agents/workload (1056, cost 2011).

const shiftDay = (day: string, by: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + by); return d.toISOString().slice(0, 10); };

/** The request's moment: a server component renders once per request. */
const clock = () => Date.now();

export default async function AiEmployees({ searchParams }: { searchParams: Promise<{ day?: string; view?: string }> }) {
  const q = await searchParams; const asked = /^\d{4}-\d{2}-\d{2}$/.test(q.day ?? "") ? q.day! : "";
  const view = q.view === "log" ? "log" : "cards";
  const [r, me] = await Promise.all([api<Workload>(`agents/workload${asked ? `?day=${asked}` : ""}`), getMe().then((x) => x.data)]);
  if (r.error) return <Message text={r.error} />;
  const w = r.data!; const now = clock();
  // "Today" in the company's own time zone (the API's day when none was asked for).
  const todayIs = new Date(now).toLocaleDateString("en-CA", { timeZone: w.timeZone || "Asia/Kolkata" });
  const today = w.day >= todayIs;
  const after = shiftDay(w.day, 1);
  return <Autopilots w={w} me={{ name: me?.name ?? "", admin: me?.role === "admin" }} view={view} today={today}
    prev={shiftDay(w.day, -1)} next={today ? null : after >= todayIs ? "today" : after} now={now}>
    {view === "log" ? <DayLog w={w} now={now} /> : null}
  </Autopilots>;
}
