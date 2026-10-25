"use client";
import type { CreditPreview } from "../tasks/accept";
// The notification panel's data (UX-NOTIFY): GET /api/v0/notices, kept in one module store so the bell, the panel and
// Pip's island read the same list. Reads come from the R27 outbox; every action posts to the route its card names.
import { useSyncExternalStore } from "react";

/** `choice` (one of `options`, shown with the shared Rating) and `flag` (a yes/no switch) came with TASKS-4B's review card. */
export type NoticeField = { key: string; label: string; type: "text" | "choice" | "flag"; default?: number | string; options?: { value: string; label: string }[] };
export type NoticeAction = { key: string; label: string; tone: "primary" | "neutral" | "danger"; method: "POST"; path: string; body?: Record<string, unknown>; fields?: NoticeField[]; done: string;
  /** UX-5A: what accepting credits, shown as the result beside the button. */ preview?: CreditPreview };
export type Person = { id: string; name: string; photoAt?: string | null };
export type Notice = {
  id: string; ids: string[]; kind?: string; eventType?: string; title: string; body?: string | null; href?: string | null; at: string; readAt: string | null;
  active?: boolean; state: string; group: "action" | "mention" | "update"; from?: Person | null; subject?: { type: string; id: string; title?: string | null } | null;
  actions: NoticeAction[]; open: { label: string; href: string }; unread?: number; channelId?: string;
  /** ATT (0860): urgent, needs_you or fyi; the family it folds and mutes with; the stack it folds into, if any. */
  priority?: Priority; family?: string; stack?: string;
};
export type Priority = "urgent" | "needs_you" | "fyi";
/** Two or more cards of one family on one day, folded in the bell ("3 tasks for you"); `cards` are their ids in `rows`. */
export type NoticeStack = { id: string; title: string; body: string; family: string; priority: Priority; ids: string[]; cards: string[]; unread: number; at: string; href: string };
export type NoticeList = { rows: Notice[]; stacks?: NoticeStack[]; counts: { unread: number; action: number; mention: number; update: number; important?: number }; dnd: boolean; today?: { due: number; overdue: number } };
/** A card's priority; an older API (or a test double) without one: a card that asks for something needs you. */
export const priorityOf = (n: Notice): Priority => n.priority ?? (n.group !== "update" || (n.state === "open" && n.actions.length) ? "needs_you" : "fyi");

let list: NoticeList | null = null;
let loading: Promise<void> | null = null;
// FLOAT: the last read failed (offline, the API down): the panel says so with Try again instead of loading forever.
let failed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

// Browser pings' own state ("awaiting server activation", "blocked in this browser"), told by BrowserPings.
let pingStatus: string | null = null;
const pingListeners = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("pulse:ping-status", (e) => { pingStatus = (e as CustomEvent<string>).detail; pingListeners.forEach((l) => l()); });
export function usePingStatus(): string | null {
  return useSyncExternalStore((l) => { pingListeners.add(l); return () => { pingListeners.delete(l); }; }, () => pingStatus, () => null);
}

/** The last list read, outside React (after awaiting refreshNotices()). */
export function currentNoticeList(): NoticeList | null { return list; }
/** The last list read (null until the first read; the panel shows a quiet skeleton meanwhile). */
export function useNoticeList(): NoticeList | null { return useSyncExternalStore(subscribe, () => list, () => null); }
/** Did the last read fail? */
export function useNoticesFailed(): boolean { return useSyncExternalStore(subscribe, () => failed, () => false); }

let readAt = 0;
// A card someone just answered stays in its section for a minute (showing "It's yours", "Approved"), instead of jumping
// from Needs your action to Updates under their pointer.
const answered = new Map<string, { group: Notice["group"]; until: number }>();
function settle(next: NoticeList): NoticeList {
  const now = Date.now();
  for (const [id, a] of answered) if (a.until < now) answered.delete(id);
  if (!answered.size) return next;
  // A request the server retires once decided (an approval) is kept too, so its confirmation stays readable.
  const gone = (list?.rows ?? []).filter((n) => answered.has(n.id) && !next.rows.some((r) => r.id === n.id));
  const rows = [...next.rows.map((n) => answered.has(n.id) ? { ...n, group: answered.get(n.id)!.group } : n), ...gone].sort((a, b) => b.at.localeCompare(a.at));
  return { ...next, rows };
}
/** Read the list again; within ten seconds of the last read only when `force` (an arrival, a change). */
// The bell's poll says the count changed (a new notification, or one read elsewhere): the list read before is out of
// date, so the next read (opening the panel) fetches it again instead of showing the old list for up to ten seconds.
if (typeof window !== "undefined") window.addEventListener("pulse:notices-changed", () => { readAt = 0; });
export function refreshNotices(force = false): Promise<void> {
  if (!force && list && Date.now() - readAt < 10000) return Promise.resolve();
  loading ??= (async () => {
    try {
      const r = await fetch("/api/v0/notices", { cache: "no-store" });
      if (r.ok) { list = settle(await r.json() as NoticeList); readAt = Date.now(); failed = false; emit(); }
      else { failed = true; emit(); }
    } catch { failed = true; emit(); /* offline: keep the last list */ } finally { loading = null; }
  })();
  return loading;
}

async function send(path: string, body: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? "That did not work. Try again.");
  return data;
}
/** Ask the bell and the island to re-read counts now rather than at the next poll. */
const nudgeCounts = () => window.dispatchEvent(new Event("pulse:poll-now"));

function patch(ids: string[], read: boolean) {
  if (!list) return;
  const at = new Date().toISOString();
  const rows = list.rows.map((n) => n.ids.some((id) => ids.includes(id)) ? { ...n, readAt: read ? n.readAt ?? at : null, unread: 0 } : n);
  list = { ...list, rows, counts: { ...list.counts, unread: rows.filter((n) => !n.readAt).length, mention: rows.filter((n) => !n.readAt && n.group === "mention").length, update: rows.filter((n) => !n.readAt && n.group === "update").length } };
  emit();
}

export async function markRead(notice: Notice) {
  if (notice.readAt && !notice.unread) return;
  patch(notice.ids, true);
  try { await send("/api/v0/notices/read", { ids: notice.ids.slice(0, 200) }); } finally { nudgeCounts(); }
}

export async function markAllRead() {
  if (list) patch(list.rows.flatMap((n) => n.ids), true);
  try { await send("/api/v0/notices/read-all", {}); } finally { nudgeCounts(); void refreshNotices(true); }
}

/** Run one of a card's actions with the values of its fields; resolves to the card's "done" words. */
export async function runAction(notice: Notice, action: NoticeAction, values: Record<string, string | number>) {
  const body: Record<string, unknown> = { ...(action.body ?? {}) };
  // A chat reply needs a fresh client id, so a retried send can never post twice.
  if (body.clientId === "new") body.clientId = crypto.randomUUID();
  for (const f of action.fields ?? []) body[f.key] = f.type === "flag" ? !!Number(values[f.key] ?? f.default ?? 0) : values[f.key] ?? f.default ?? "";
  await send(action.path, body);
  answered.set(notice.id, { group: notice.group, until: Date.now() + 60000 });
  window.dispatchEvent(new Event("pulse:data-changed"));
  await markRead(notice).catch(() => {});
  void refreshNotices(true);
  return action.done;
}

/** Open the panel from anywhere (Pip's menu, an island arrival); `focus` brings one card into view. */
export function openNotices(focus?: string) { window.dispatchEvent(new CustomEvent<{ focus?: string }>("pulse:open-notices", { detail: { focus } })); }
