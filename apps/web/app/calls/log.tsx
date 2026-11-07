"use client";
// FEATURES-1024: the calls list. Reads GET /api/v0/calls (recent: pulse.chat_call_recent) and reads it again when a call
// ends or the window comes back; call back starts a call in the same conversation (the shell's CallHost).
import Link from "next/link";
import { useEffect, useState } from "react";
import { MessageCircle, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";
import { Avatar, Empty } from "../ui";
import { byDay, callEntry, duration, type CallEntry, type RecentCall } from "../lib/call-log.mjs";
import { startCall, useCalls } from "./call-host";
import css from "./calls.module.css";

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function CallLog({ me }: { me: string }) {
  const [rows, setRows] = useState<CallEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const live = useCalls();
  const ongoing = live.calls.length + (live.ended ? 1 : 0);
  useEffect(() => {
    let on = true;
    fetch("/api/v0/calls", { cache: "no-store", signal: AbortSignal.timeout(15000) }).then(async (r) => {
      const d = await r.json().catch(() => ({})) as { recent?: RecentCall[]; error?: string };
      if (!r.ok) throw new Error(d.error ?? "Calls did not load.");
      if (on) { setRows((d.recent ?? []).map((c) => callEntry(c, me))); setError(null); }
    }).catch((e: unknown) => { if (on) setError(e instanceof Error && e.name !== "TimeoutError" ? e.message : "Calls did not load. Check the connection and try again."); });
    return () => { on = false; };
  }, [me, ongoing, tick]);
  useEffect(() => { const back = () => { if (document.visibilityState === "visible") setTick((t) => t + 1); }; document.addEventListener("visibilitychange", back); return () => document.removeEventListener("visibilitychange", back); }, []);

  if (error && !rows) return <p className={css.logError} role="alert">{error} <button type="button" onClick={() => setTick((t) => t + 1)}>Try again</button></p>;
  if (!rows) return <div className={css.logSk} aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i} />)}</div>;
  if (!rows.length) return <Empty icon={Phone} title="No calls yet" text="Start one from any chat with the phone or camera button at the top of the conversation." action={{ href: "/chats", label: "Open Chats" }} />;
  const missed = rows.filter((r) => r.missed).length;
  return <div className={css.log}>
    {missed ? <p className={css.logSum}><PhoneMissed size={15} aria-hidden="true" />{missed} missed in the last 90 days</p> : null}
    {byDay(rows).map((g) => <section key={g.label} className={css.logDay} aria-label={g.label}>
      <h2>{g.label}</h2>
      <ul>{g.entries.map((e) => { const Dir = e.missed ? PhoneMissed : e.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming; const d = duration(e.seconds);
        return <li key={e.id} className={css.logRow} data-missed={e.missed || undefined}>
          <Avatar name={e.title} id={e.peer?.id} photoAt={e.peer?.photoAt ?? null} size={40} />
          <Link href={`/chats?channel=${encodeURIComponent(e.channelId)}`} className={css.logMain} title="Open the conversation">
            <b>{e.title}</b>
            <small><Dir size={13} aria-hidden="true" />{e.live ? "On now" : e.missed ? "Missed" : e.declined ? "Declined" : e.direction === "outgoing" ? (e.answered ? "Outgoing" : "Not answered") : "Incoming"}
              {e.video ? " · video" : ""}{d ? ` · ${d}` : ""}{e.peer ? "" : e.caller && e.direction === "incoming" ? ` · from ${e.caller.name}` : ""}</small>
          </Link>
          <time className={css.logTime} dateTime={e.at}>{time(e.at)}</time>
          <span className={css.logActs}>
            <button type="button" onClick={() => startCall(e.channelId, false)} aria-label={`Call ${e.title}`} title="Call"><Phone size={16} aria-hidden="true" /></button>
            <button type="button" onClick={() => startCall(e.channelId, true)} aria-label={`Video call ${e.title}`} title="Video call"><Video size={16} aria-hidden="true" /></button>
            <Link href={`/chats?channel=${encodeURIComponent(e.channelId)}`} aria-label={`Message ${e.title}`} title="Message"><MessageCircle size={16} aria-hidden="true" /></Link>
          </span>
        </li>; })}</ul>
    </section>)}
  </div>;
}
