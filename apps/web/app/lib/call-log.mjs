// FEATURES-1024 (J1, J8: "a missed call is a needs you"; CHAT-VOICE: "a Calls tab listing calls across chats"): what a
// person's recent calls (GET /api/v0/calls → recent, pulse.chat_call_recent) mean for them. Pure, so it is unit tested.

/** One call as this person saw it: who (the other person in a direct call, else the group), which way, how it ended. */
export function callEntry(call, me) {
  const mine = call.parties?.find((p) => p.id === me) ?? null;
  const others = (call.parties ?? []).filter((p) => p.id !== me);
  const outgoing = call.startedBy === me;
  const answered = !!call.answeredAt;
  const missed = !outgoing && !!mine && (mine.state === "missed" || (call.state === "ended" && !mine.joinedAt && mine.state !== "declined" && mine.state !== "busy"));
  const peer = call.channelKind === "direct" ? others[0] ?? null : null;
  const seconds = answered && call.endedAt ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000)) : null;
  const caller = (call.parties ?? []).find((p) => p.id === call.startedBy) ?? null;
  return {
    id: call.id, channelId: call.channelId, video: !!call.video, at: call.createdAt, live: call.state !== "ended",
    title: peer?.name ?? call.channelName ?? (others.map((p) => p.name).join(", ") || "Call"), peer, caller,
    direction: outgoing ? "outgoing" : "incoming", missed, declined: mine?.state === "declined", answered, seconds,
  };
}

/** Missed calls that still need the person: missed in the last `days`, with no later call in that conversation that was
 *  answered or that they started themselves (calling back clears it). Newest first. */
export function missedCalls(recent, me, now = Date.now(), { days = 3, max = 4 } = {}) {
  const list = (recent ?? []).map((c) => callEntry(c, me)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const out = [];
  for (const e of list) {
    if (!e.missed || now - Date.parse(e.at) > days * 86400000) continue;
    const later = list.some((x) => x.channelId === e.channelId && Date.parse(x.at) > Date.parse(e.at) && (x.answered || x.direction === "outgoing"));
    if (later || out.some((x) => x.channelId === e.channelId)) continue; // one line per conversation: the newest
    out.push({ ...e, count: list.filter((x) => x.channelId === e.channelId && x.missed && Date.parse(x.at) > Date.parse(e.at) - days * 86400000).length });
    if (out.length >= max) break;
  }
  return out;
}

/** Calls grouped by day for the calls list: "Today", "Yesterday", else the date (India time). */
export function byDay(entries, now = Date.now(), timeZone = "Asia/Kolkata") {
  const day = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone });
  const today = day(now), yesterday = day(now - 86400000);
  const groups = [];
  for (const e of entries) {
    const d = day(Date.parse(e.at));
    const label = d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    const g = groups.at(-1);
    if (g && g.label === label) g.entries.push(e); else groups.push({ label, entries: [e] });
  }
  return groups;
}

/** "4:05", "1:02:09"; null for a call nobody answered. */
export const duration = (s) => s === null || s === undefined ? null : `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(s >= 3600 ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
