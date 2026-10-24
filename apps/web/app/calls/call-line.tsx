"use client";
// CHAT-VOICE: a call as a line in its conversation: who called, missed or answered and for how long, Join while a
// group call is on, and Call back. The chat is the call history.
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";
import { callClock, startCall, useCalls } from "./call-host";
import css from "./calls.module.css";

export type CallAttachment = { call: string; video?: boolean; state?: string; seconds?: number | null };
export const callOf = (attachments: { call?: string }[] | undefined) => attachments?.find((a) => a.call) as CallAttachment | undefined;

export function CallLine({ a, mine, author, channelId, at }: { a: CallAttachment; mine: boolean; author: string; channelId: string; at: string }) {
  const snap = useCalls();
  const inIt = snap.session?.call.id === a.call;
  const kind = a.video ? "video call" : "voice call", Kind = a.video ? "Video call" : "Voice call";
  const state = a.state ?? "ringing";
  const missed = !mine && (state === "missed" || state === "busy");
  const live = state === "live" || state === "ringing";
  const text = state === "completed" ? Kind : state === "missed" ? (mine ? `${Kind} · no answer` : `Missed ${kind}`) : state === "declined" ? `${Kind} · declined`
    : state === "busy" ? (mine ? `${Kind} · busy` : `Missed ${kind}`) : state === "failed" ? `${Kind} · didn’t connect` : state === "live" ? `${Kind} · on now` : mine ? `Calling…` : `${author} is calling…`;
  const Icon = a.video ? Video : missed ? PhoneMissed : mine ? PhoneOutgoing : PhoneIncoming;
  const time = new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  return <span className={css.line} data-missed={missed || undefined} data-live={live || undefined} id={`call-${a.call}`}>
    <span className={css.lineIcon} aria-hidden="true"><Icon size={16} /></span>
    <span className={css.lineText}><b>{text}</b><small>{time}{state === "completed" && a.seconds ? ` · ${callClock(a.seconds)}` : ""}</small></span>
    {live && !inIt && !snap.session ? <button type="button" className={css.lineBtn} data-join="" onClick={() => startCall(channelId, !!a.video)}>{state === "live" ? "Join" : mine ? "Open" : "Answer"}</button>
      : !live ? <button type="button" className={css.lineBtn} onClick={() => startCall(channelId, !!a.video)} aria-label={`Call back (${kind})`}><Phone size={13} aria-hidden="true" />Call back</button> : null}
  </span>;
}
