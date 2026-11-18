"use client";
// CHAT-SHELL v2: what someone has typed but not sent is never lost. One store for the full chat and the chat dock,
// kept in this browser per person (localStorage), so leaving a page, reloading or opening the chat elsewhere brings
// the words back. A sent or cleared draft is removed.
const KEY = "pulse.chat.drafts.v1";
const MAX = 60;
type Saved = Record<string, { t: string; at: number }>;
const who = () => (typeof document === "undefined" ? "" : document.body?.dataset.viewer ?? "");
function load(): Saved { try { const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}"); return all?.[who()] ?? {}; } catch { return {}; } }
function save(mine: Saved) {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") ?? {};
    const kept = Object.entries(mine).sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
    all[who()] = Object.fromEntries(kept); window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage unavailable: the draft lives for this page only */ }
}
const memory = new Map<string, string>();
export const draftStore = {
  get(channelId: string): string | undefined { if (memory.has(channelId)) return memory.get(channelId); const d = typeof window === "undefined" ? undefined : load()[channelId]?.t; if (d !== undefined) memory.set(channelId, d); return d; },
  set(channelId: string, text: string) {
    memory.set(channelId, text); if (typeof window === "undefined") return;
    const mine = load(); if (text.trim()) mine[channelId] = { t: text.slice(0, 12000), at: Date.now() }; else delete mine[channelId]; save(mine);
  },
};
/** The conversation last opened in the full chat (the dock shows it). */
export const LAST_CHANNEL = "pulse.chat.last";
