"use client";
// CHATS-2 speed: the chat list and the latest messages of recent conversations live in memory for the session and in
// localStorage across reloads, so a revisit draws at once and then syncs. The cache belongs to one person: it is
// keyed by the signed-in viewer (the layout puts their id on <body>), so a shared browser never shows another
// person's chats. Each conversation keeps its last 40 messages; at most 12 conversations are kept.
import type { ChatData, ChatMessage, Thread } from "./types";

const KEY = "pulse.chats.v2";
const KEEP_THREADS = 12, KEEP_MESSAGES = 40;
type Saved = { viewer: string; list: ChatData | null; threads: [string, Thread][] };
let list: ChatData | null = null;
const threads = new Map<string, Thread>();
let loadedFor: string | null = null;
const listeners = new Set<() => void>();
let version = 0;

const viewerNow = () => (typeof document === "undefined" ? null : document.body?.dataset.viewer ?? null);
function load() {
  const viewer = viewerNow();
  if (!viewer || loadedFor === viewer) return;
  loadedFor = viewer; list = null; threads.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    if (saved?.viewer === viewer) { list = saved.list; for (const [k, t] of saved.threads) threads.set(k, t); }
    else localStorage.removeItem(KEY);
  } catch { /* private mode or a broken entry: start empty */ }
}
let timer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null; const viewer = viewerNow(); if (!viewer) return;
    const recent = [...threads.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_THREADS)
      .map(([k, t]) => { const stored = t.messages.filter((m) => !m.pending && !m.failed && !m.queued), waiting = t.messages.filter((m) => m.pending || m.queued).map((m) => ({ ...m, queued: true }));
        // CHAT-V3 (offline): messages still waiting to go are kept too, so a reload sends them (outbox.ts).
        return [k, { ...t, messages: [...stored.slice(-KEEP_MESSAGES), ...waiting], hasMore: t.hasMore || stored.length > KEEP_MESSAGES }] as [string, Thread]; });
    try { localStorage.setItem(KEY, JSON.stringify({ viewer, list, threads: recent } satisfies Saved)); } catch { /* full: memory still works */ }
  }, 400);
}
const emit = () => { version++; listeners.forEach((l) => l()); persist(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** A number that changes with every write: the snapshot for useSyncExternalStore. */
export const storeVersion = () => { load(); return version; };
export function cachedList(): ChatData | null { load(); return list; }
export function saveList(data: ChatData) { load(); if (loadedFor && data.viewer !== loadedFor) { threads.clear(); } list = data; emit(); }
export function cachedThread(id: string | null | undefined): Thread | null { load(); return id ? threads.get(id) ?? null : null; }
export function saveThread(id: string, t: Thread) { load(); threads.set(id, t); emit(); }
/** CHAT-V3: the conversations kept here (the outbox looks through them for messages still waiting). */
export function threadIds(): string[] { load(); return [...threads.keys()]; }
/** Change one conversation's messages in place (optimistic sends, reactions, edits). */
export function updateThread(id: string, change: (messages: ChatMessage[]) => ChatMessage[]) {
  load(); const t = threads.get(id) ?? { messages: [], hasMore: false, members: [], receipts: null, at: Date.now() };
  threads.set(id, { ...t, messages: change(t.messages), at: Date.now() }); emit();
}
/** Merge a fresh page from the server into what is cached: newer server rows win; optimistic rows stay until confirmed. */
export function mergeLatest(old: ChatMessage[], fresh: ChatMessage[], hasOlder: boolean): ChatMessage[] {
  if (!fresh.length) return old.filter((m) => m.pending || m.failed);
  const start = fresh[0].createdAt; const ids = new Set(fresh.map((m) => m.id));
  const keepOlder = hasOlder ? old.filter((m) => !m.pending && !m.failed && m.createdAt < start && !ids.has(m.id)) : [];
  const confirmed = new Set(fresh.map((m) => m.clientId).filter(Boolean));
  const waiting = old.filter((m) => (m.pending || m.failed || m.queued) && !ids.has(m.id) && !confirmed.has(m.clientId));
  // CHAT-V3 (speed): a message that did not change keeps its object, so its bubble is not drawn again on every sync.
  const before = new Map(old.map((m) => [m.id, m]));
  const same = (m: ChatMessage) => { const o = before.get(m.id); return o && !o.pending && JSON.stringify(o) === JSON.stringify({ ...m, ...(o.clientId && !m.clientId ? { clientId: o.clientId } : {}) }) ? o : m; };
  return [...keepOlder, ...fresh.map(same), ...waiting];
}
