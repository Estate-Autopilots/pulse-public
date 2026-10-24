"use client";
// CHAT-V3 (offline): the outbox. A message is on screen the moment it is sent; delivering it happens here. Without a
// connection (or while Pulse is busy: 5xx, 429) it waits with a clock and "Waiting for the connection", and goes by
// itself as soon as the browser is back online (or on the next try: 2, 4, 8, 15 s), also after a reload: the store
// keeps waiting messages. A message Pulse refuses (4xx) says why, with Try again and Delete.
import { cachedThread, threadIds, updateThread } from "./store";
import type { ChatMessage } from "./types";

const inflight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null, tries = 0;
const mark = (channel: string, clientId: string, change: Partial<ChatMessage>) =>
  updateThread(channel, (ms) => ms.map((m) => m.clientId === clientId && (m.pending || m.failed || m.queued) ? { ...m, ...change } : m));

/** Deliver one optimistic message; the stored message replaces it in place. Returns the stored id, or null for now. */
export async function deliver(channel: string, m: ChatMessage): Promise<string | null> {
  const clientId = m.clientId; if (!clientId || inflight.has(clientId)) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) { mark(channel, clientId, { pending: true, queued: true, failed: undefined }); later(); return null; }
  inflight.add(clientId);
  try {
    const r = await fetch(`/api/v0/chats/${channel}/messages`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: m.body, attachments: m.attachments, quoteId: m.quoteId ?? null, parentId: m.parentId ?? null, clientId }) }).catch(() => null);
    if (!r || r.status >= 500 || r.status === 429) { mark(channel, clientId, { pending: true, queued: true, failed: undefined }); later(); return null; }
    const d = await r.json().catch(() => ({})) as { id?: string; message?: ChatMessage; error?: string };
    if (!r.ok || !d.id || !d.message) { mark(channel, clientId, { pending: false, queued: false, failed: d.error ?? "That did not go through. Try again." }); return null; }
    const stored = d.message, id = d.id;
    updateThread(channel, (ms) => ms.some((x) => x.id === id) ? ms.filter((x) => x.clientId !== clientId || !(x.pending || x.failed || x.queued)) : ms.map((x) => x.clientId === clientId && (x.pending || x.failed || x.queued) ? { ...stored, clientId } : x));
    tries = 0;
    return id;
  } finally { inflight.delete(clientId); }
}

/** Everything still waiting, in the order it was written (on reconnect, on a timer, after a reload). */
export function flush() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  for (const channel of threadIds()) for (const m of cachedThread(channel)?.messages ?? []) if ((m.queued || (m.pending && !inflight.has(m.clientId ?? ""))) && m.clientId && m.id.startsWith("local-")) void deliver(channel, m);
}
function later() {
  if (timer) return;
  const wait = Math.min(15000, 2000 * 2 ** tries++);
  timer = setTimeout(() => { timer = null; flush(); }, wait);
}
let started = false;
/** Once per page: deliver what a previous visit left waiting, and whatever waits when the connection returns. */
export function startOutbox() {
  if (started || typeof window === "undefined") return; started = true;
  window.addEventListener("online", () => { tries = 0; flush(); });
  setTimeout(flush, 1500);
}
