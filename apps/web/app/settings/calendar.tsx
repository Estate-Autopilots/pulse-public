"use client";
// GAP-FOUNDER-VIEW (PM-08): your own Google Calendar. Your tasks with a due time and the meetings you book go there, and
// your AI can read your next events (API v1 my_next_events). CALENDAR-HUB (T2.1.5): two-way. Your own Pulse events go too,
// your Google events show on the Pulse calendar, and a time changed in Google comes back to the task or event. Shown only where the server switched Google Calendar on
// (services/api/src/calendar.ts): until then this draws nothing at all.
import { useEffect, useState } from "react";
import { CalendarCheck2, CalendarPlus, RefreshCw, Unplug } from "lucide-react";
import { ActionButton, Chip, GameCard, toast } from "../kit/game";
import { useConfirm } from "../kit/dialogs";
import { post } from "../records";

type Connection = { address: string; pushTasks: boolean; pushMeetings: boolean; status: "connected" | "error"; lastError: string | null; syncedAt: string | null; pushed: number } | null;
type State = { on: boolean; connection?: Connection };

export async function connectCalendar() {
  const r = await post<{ url: string }>("calendar/google/start", {});
  window.location.assign(r.url);
}

export function CalendarCard() {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  useEffect(() => { fetch("/api/v0/calendar", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => setS(d)).catch(() => setS(null)); }, []);
  if (!s?.on) return null;
  const c = s.connection ?? null;
  const act = async (work: () => Promise<State>, ok?: string) => {
    setBusy(true);
    try { setS(await work()); if (ok) toast(ok); } catch (e) { toast(e instanceof Error ? e.message : "That did not work", { tone: "bad" }); } finally { setBusy(false); }
  };
  if (!c) return <GameCard title="Google Calendar" icon={CalendarPlus}>
    <p style={{ margin: 0 }}>See your Google Calendar inside Pulse, and your Pulse tasks, meetings and events in Google. Move something in either one and the other follows. Your AI can also see what is next.</p>
    <span><ActionButton primary action={{ label: "Connect Google Calendar", icon: CalendarPlus, busy, onClick: () => { setBusy(true); void connectCalendar().catch((e) => { setBusy(false); toast(e instanceof Error ? e.message : "Could not start", { tone: "bad" }); }); } }} /></span>
  </GameCard>;
  return <GameCard title="Google Calendar" icon={CalendarCheck2} note={c.status === "connected" ? <Chip tone="good">Connected</Chip> : <Chip tone="bad">Needs you</Chip>}>
    <p style={{ margin: 0 }}><b>{c.address}</b> · {c.pushed} {c.pushed === 1 ? "event" : "events"} from Pulse{c.syncedAt ? "" : " · not synced yet"}</p>
    {c.lastError ? <p role="alert" style={{ margin: 0 }}>{c.lastError}</p> : null}
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={c.pushTasks} disabled={busy} onChange={(e) => void act(() => post<State>("calendar/settings", { pushTasks: e.target.checked }))} />Tasks with a due time</label>
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={c.pushMeetings} disabled={busy} onChange={(e) => void act(() => post<State>("calendar/settings", { pushMeetings: e.target.checked }))} />Meetings I book</label>
    <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <ActionButton primary action={{ label: "Sync now", icon: RefreshCw, busy, onClick: () => void act(() => post<State>("calendar/sync", {}), "Your calendars match now.") }} />
      <ActionButton action={{ label: "Disconnect", icon: Unplug, disabled: busy, onClick: async () => { if (await confirm({ title: "Disconnect Google Calendar?", body: "Pulse stops adding events. Events it already added stay in your calendar.", confirmLabel: "Disconnect" })) void act(() => post<State>("calendar/disconnect", {}), "Disconnected."); } }} />
    </span>
  </GameCard>;
}
