"use client";
// FIX-CHAT-AI (owner walkthrough, 10 Nov 2026: "the Calls page has an empty right side; design it"): the call log on the
// left; on the right this week's calls at a glance (calls, minutes talked, missed) and the people to call back or call
// next, each one tap away (voice or video). On a phone the rail comes after the log.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Clock3, MessageCircle, Phone, PhoneCall, PhoneMissed, Video } from "lucide-react";
import { Avatar } from "../ui";
import { GameCard, StatTile, StatTiles } from "../kit/game";
import type { CallEntry } from "../lib/call-log.mjs";
import { startCall } from "./call-host";
import { CallLog } from "./log";
import css from "./calls.module.css";

type Person = { channelId: string; name: string; peerId: string | null; photoAt: string | null; missed: boolean; at: string | null };
type ChatRow = { id: string; kind: string; name: string; peerId?: string | null; peerAgent?: boolean; peerPhotoAt?: string | null; lastAt: string | null };
const WEEK = 7 * 86400000;

export function CallsBoard({ me }: { me: string }) {
  const [log, setLog] = useState<{ rows: CallEntry[]; at: number } | null>(null);
  const rows = log?.rows ?? null;
  const [chats, setChats] = useState<ChatRow[] | null>(null);
  const onRows = useCallback((r: CallEntry[]) => setLog({ rows: r, at: Date.now() }), []);
  useEffect(() => {
    let on = true;
    fetch("/api/v0/chats", { cache: "no-store", signal: AbortSignal.timeout(15000) }).then((r) => r.ok ? r.json() : null)
      .then((d: { channels?: ChatRow[] } | null) => { if (on) setChats(d?.channels ?? []); }).catch(() => { if (on) setChats([]); });
    return () => { on = false; };
  }, []);
  const week = useMemo(() => {
    const now = log?.at ?? 0, w = (log?.rows ?? []).filter((r) => now - Date.parse(r.at) < WEEK);
    return { calls: w.length, minutes: Math.round(w.reduce((n, r) => n + (r.seconds ?? 0), 0) / 60), missed: w.filter((r) => r.missed).length };
  }, [log]);
  // Who to call: missed calls first (call back), then the people last talked to on a call, then recent direct chats.
  const people = useMemo(() => {
    const out: Person[] = [], seen = new Set<string>();
    for (const r of [...(rows ?? [])].sort((a, b) => Number(b.missed) - Number(a.missed) || Date.parse(b.at) - Date.parse(a.at))) {
      if (!r.peer || seen.has(r.channelId)) continue; seen.add(r.channelId);
      out.push({ channelId: r.channelId, name: r.title, peerId: r.peer.id, photoAt: r.peer.photoAt ?? null, missed: r.missed, at: r.at });
    }
    for (const c of [...(chats ?? [])].filter((x) => x.kind === "direct" && !x.peerAgent).sort((a, b) => Date.parse(b.lastAt ?? "0") - Date.parse(a.lastAt ?? "0"))) {
      if (seen.has(c.id)) continue; seen.add(c.id);
      out.push({ channelId: c.id, name: c.name, peerId: c.peerId ?? null, photoAt: c.peerPhotoAt ?? null, missed: false, at: null });
    }
    return out.slice(0, 6);
  }, [rows, chats]);

  return <div className={css.board}>
    <div className={css.boardMain}><CallLog me={me} onRows={onRows} /></div>
    <aside className={css.rail} aria-label="Your calls this week">
      <StatTiles label="This week" min={96}>
        <StatTile label="Calls" value={rows ? week.calls : "–"} icon={PhoneCall} />
        <StatTile label="Minutes" value={rows ? week.minutes : "–"} icon={Clock3} />
        <StatTile label="Missed" value={rows ? week.missed : "–"} icon={PhoneMissed} tone={week.missed ? "bad" : undefined} />
      </StatTiles>
      <GameCard title="Call someone" icon={Phone} note={people.some((p) => p.missed) ? "Missed calls first" : undefined}>
        {chats === null && rows === null ? <p className={css.railNote}>Loading…</p>
          : !people.length ? <p className={css.railNote}>Start a chat with someone first. Then call them from here or from the chat.</p>
          : <ul className={css.railList}>{people.map((p) => <li key={p.channelId} data-missed={p.missed || undefined}>
            <Avatar name={p.name} id={p.peerId ?? undefined} photoAt={p.photoAt} size={36} />
            <span className={css.railWho}><b>{p.name}</b><small>{p.missed ? "Missed call · call back" : p.at ? "Talked on a call" : "From your chats"}</small></span>
            <span className={css.railActs}>
              <button type="button" onClick={() => startCall(p.channelId, false)} aria-label={`Call ${p.name}`} title="Call"><Phone size={16} aria-hidden="true" /></button>
              <button type="button" onClick={() => startCall(p.channelId, true)} aria-label={`Video call ${p.name}`} title="Video call"><Video size={16} aria-hidden="true" /></button>
              <Link href={`/chats?channel=${encodeURIComponent(p.channelId)}`} aria-label={`Message ${p.name}`} title="Message"><MessageCircle size={16} aria-hidden="true" /></Link>
            </span>
          </li>)}</ul>}
      </GameCard>
    </aside>
  </div>;
}
