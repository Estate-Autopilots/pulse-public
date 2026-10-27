"use client";
// WA-NATIVE (owner, 25 Oct 2026: "It is not WhatsApp chat now, it's Pulse's own chat"): a WhatsApp group's history is
// this chat's own messages (migration 1051). The chat carries one marker where its history begins; any chat jumps to a
// date; the group's info lists who wrote in WhatsApp (client-side people and guests who are not members here).
import Link from "next/link";
import { CalendarDays, MessageCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useOrgZone } from "../org-code";
import { get } from "./net";
import type { Channel } from "./types";
import css from "./chats.module.css";
import n from "./native.module.css";

const day = (iso: string | null | undefined, timeZone: string) => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone }) : "";
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Where the history begins: it came from the WhatsApp group (how many messages, from when to when). */
export function ImportedMarker({ wa }: { wa: NonNullable<Channel["whatsapp"]> }) {
  const zone = useOrgZone(), count = wa.nativeMessages ?? wa.messages;
  return <div className={n.marker} data-wa-native="" role="note">
    <span className={n.markerIcon} aria-hidden="true"><MessageCircle size={16} /></span>
    <span><b>Moved from WhatsApp</b><small>{count.toLocaleString("en-IN")} message{count === 1 ? "" : "s"}{wa.firstAt ? ` · ${day(wa.firstAt, zone)} to ${day(wa.lastAt, zone)}` : ""}. Everything after this is the same chat in Pulse.</small></span>
  </div>;
}

/** Jump to a date: a day, the first message, or a month of the chat's history (imported chats list theirs). */
export function JumpToDate({ channel, onPick, onClose }: { channel: Channel; onPick: (day: string) => void; onClose: () => void }) {
  const zone = useOrgZone(), first = channel.whatsapp?.firstAt ?? null, today = ymd(new Date());
  const [value, setValue] = useState(first ? ymd(new Date(first)) : today);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const months = useMemo(() => {
    if (!first) return [];
    const out: { key: string; label: string; year: number }[] = [], end = new Date(channel.lastAt ?? channel.whatsapp?.lastAt ?? first);
    for (let d = new Date(new Date(first).getFullYear(), new Date(first).getMonth(), 1); d <= end && out.length < 60; d = new Date(d.getFullYear(), d.getMonth() + 1, 1))
      out.push({ key: ymd(d), label: d.toLocaleDateString("en-IN", { month: "short", timeZone: zone }), year: d.getFullYear() });
    return out;
  }, [first, channel.lastAt, channel.whatsapp?.lastAt, zone]);
  const years = [...new Set(months.map((m) => m.year))];
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`${css.dialog} ${n.jump}`} role="dialog" aria-modal="true" aria-labelledby="jump-date-title" data-jump-date="">
      <header><h2 id="jump-date-title"><CalendarDays size={18} aria-hidden="true" />Jump to a date</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button></header>
      <form className={n.jumpForm} onSubmit={(e) => { e.preventDefault(); if (value) onPick(value); }}>
        <label><span>Day</span><input type="date" value={value} min={first ? ymd(new Date(first)) : undefined} max={today} onChange={(e) => setValue(e.target.value)} required autoFocus /></label>
        <button type="submit" className={css.primary}>Go</button>
      </form>
      {first ? <button type="button" className={n.firstBtn} onClick={() => onPick(ymd(new Date(first)))}>The first message · {day(first, zone)}</button> : null}
      {months.length > 1 ? <div className={n.months} aria-label="Months">
        {years.map((y) => <div key={y} className={n.year}><b>{y}</b><span>{months.filter((m) => m.year === y).map((m) => <button key={m.key} type="button" onClick={() => onPick(m.key)}>{m.label}</button>)}</span></div>)}
      </div> : null}
    </div>
  </div>;
}

type WaPerson = { participantId: string; personId: string | null; name: string; kind: "colleague" | "client" | "contact" | "number" | "unknown"; side: string | null; messages: number; lastAt: string | null; member: boolean; optIn: string | null };
const KIND: Record<WaPerson["kind"], string> = { colleague: "Colleague", client: "Client side", contact: "Contact", number: "Guest", unknown: "Guest" };
const OPT: Record<string, string> = { pending: "history not shared yet", invited: "invited", opted_in: "reads the history", declined: "declined", revoked: "stopped sharing" };

/** Who wrote in the WhatsApp group and is not a member here: client-side people (their contact page) and guests. */
export function WhatsAppPeople({ channel }: { channel: Channel }) {
  const [people, setPeople] = useState<WaPerson[] | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void get<{ people: WaPerson[] | null }>(`chats/whatsapp/channel/${channel.id}/people`, ac.signal).then((d) => { if (!ac.signal.aborted) setPeople(d.people ?? []); }).catch(() => { if (!ac.signal.aborted) setPeople([]); });
    return () => ac.abort();
  }, [channel.id]);
  const outside = (people ?? []).filter((p) => !p.member);
  if (!people || !outside.length) return null;
  return <section className={css.members} aria-label="From the WhatsApp group" data-wa-people="">
    <h4>From the WhatsApp group<small className={n.count}>{outside.length}</small></h4>
    <p className={n.peopleNote}>They wrote in the group before it moved here. Client-side people join once they accept to share the history.</p>
    <ul className={n.people}>{outside.slice(0, 40).map((p) => <li key={p.participantId}>
      <span className={n.dot} data-kind={p.kind} aria-hidden="true">{p.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?"}</span>
      <span className={n.who}>{p.personId && p.side === "client" ? <Link href={`/contacts/${p.personId}`}>{p.name}</Link> : p.personId && p.side === "staff" ? <Link href={`/people/${p.personId}`}>{p.name}</Link> : <b>{p.name}</b>}
        <small>{KIND[p.kind]}{p.optIn ? ` · ${OPT[p.optIn] ?? p.optIn}` : ""} · {p.messages.toLocaleString("en-IN")} message{p.messages === 1 ? "" : "s"}</small></span>
    </li>)}</ul>
    {outside.length > 40 ? <p className={n.peopleNote}>And {outside.length - 40} more.</p> : null}
  </section>;
}

const OMITTED: Record<string, string> = { image: "Photo", video: "Video", audio: "Audio", voice: "Voice message", document: "Document", sticker: "Sticker", gif: "GIF", contact: "Contact card" };
/** A file the WhatsApp export left out: what it was, said once, quietly. */
export function OmittedFile({ kind, name }: { kind: string; name?: string }) {
  return <p className={n.omitted} data-omitted={kind}>{OMITTED[kind] ?? "A file"}{name ? ` · ${name}` : ""} <span>not in the WhatsApp export</span></p>;
}
