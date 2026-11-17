"use client";
// CHAT-V3 (live): who is typing where. The live stream passes on "typing" from the others in my conversations; a line
// stays for 6 s unless it is renewed (someone still typing tells again every 3 s) or ended (sent, or the box emptied).
// Nothing about typing is stored anywhere.
import { useSyncExternalStore } from "react";

export type Typer = { person: string; name: string; until: number };
const typing = new Map<string, Typer[]>();
const listeners = new Set<() => void>();
let version = 0, sweep: ReturnType<typeof setTimeout> | null = null;
const emit = () => { version++; listeners.forEach((l) => l()); };
function schedule() {
  if (sweep) clearTimeout(sweep);
  const next = Math.min(...[...typing.values()].flat().map((t) => t.until));
  if (!Number.isFinite(next)) return;
  sweep = setTimeout(() => { sweep = null; const now = Date.now(); let changed = false;
    for (const [k, list] of typing) { const kept = list.filter((t) => t.until > now); if (kept.length !== list.length) { changed = true; if (kept.length) typing.set(k, kept); else typing.delete(k); } }
    if (changed) emit(); schedule(); }, Math.max(50, next - Date.now() + 20));
}
/** From the live stream: `{ channel, person, name, on }`. */
export function typingEvent(d: { channel: string; person: string; name: string; on: boolean }) {
  const list = (typing.get(d.channel) ?? []).filter((t) => t.person !== d.person);
  if (d.on) list.push({ person: d.person, name: d.name, until: Date.now() + 6000 });
  if (list.length) typing.set(d.channel, list); else typing.delete(d.channel);
  emit(); schedule();
}
/** Someone's message arrived: they are no longer typing it. */
export function stoppedTyping(channel: string, person: string) {
  const list = typing.get(channel); if (!list?.some((t) => t.person === person)) return;
  const kept = list.filter((t) => t.person !== person); if (kept.length) typing.set(channel, kept); else typing.delete(channel); emit();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const none: Typer[] = [];
/** The people typing in a conversation now (stable between changes, so it can feed a render). */
export function useTypers(channel: string | null | undefined): Typer[] {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return (channel && typing.get(channel)) || none;
}
/** Every conversation with someone typing (the chat list's rows). */
export function useTypingChannels(): Map<string, Typer[]> { useSyncExternalStore(subscribe, () => version, () => 0); return typing; }
/** "Asha is typing…", "Asha and Neha are typing…", "3 people are typing…"; in a direct chat just "typing…". */
export function typingLine(list: Typer[], direct: boolean): string {
  if (!list.length) return "";
  if (direct) return "typing…";
  const first = (n: string) => n.split(" ")[0];
  return list.length === 1 ? `${first(list[0].name)} is typing…` : list.length === 2 ? `${first(list[0].name)} and ${first(list[1].name)} are typing…` : `${list.length} people are typing…`;
}

// Telling the others that I type: at most every 3 s while the box has words, and once when it is sent or emptied.
const told = new Map<string, number>();
export function iAmTyping(channel: string, on: boolean) {
  const last = told.get(channel) ?? 0, now = Date.now();
  if (on && now - last < 3000) return;
  if (!on && (!last || now - last > 6500)) { told.delete(channel); return; }
  if (on) told.set(channel, now); else told.delete(channel);
  void fetch(`/api/v0/chats/${channel}/typing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }), keepalive: !on }).catch(() => {});
}
