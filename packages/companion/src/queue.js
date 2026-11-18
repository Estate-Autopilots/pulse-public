// The offline queue for attendance actions. A tap with no network is kept with the moment it happened and sent in
// order once Pulse is reachable; the server accepts the original time for up to three hours and marks the entry as
// synced late, so HR can see it. Older items are not sent: the person is told to ask for a correction instead.
import { applyLocal } from './view.js';

export const QUEUE_LIMIT = 50;
export const QUEUE_MAX_AGE_MS = 3 * 3600000;

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'q-' + Math.random().toString(16).slice(2) + Date.now().toString(16));

/** Add a tap. Two identical taps in a row (a double click) collapse into one. */
export function enqueue(queue, action, at, body = {}, id = uuid()) {
  const items = [...(queue ?? [])];
  const last = items.at(-1);
  if (last && last.action === action && at - last.at < 5000) return items;
  if (items.length >= QUEUE_LIMIT) throw new Error('Too many offline actions. Connect to Pulse to sync them.');
  items.push({ id, action, at, body, tries: 0 });
  return items;
}

/** Split a queue into what can still be sent and what is too old for the server to accept. */
export function prune(queue, at) {
  const keep = [], expired = [];
  for (const item of queue ?? []) (at - item.at > QUEUE_MAX_AGE_MS ? expired : keep).push(item);
  return { keep, expired };
}

/** The request for a queued item: the original moment and an id that makes a retry harmless. */
export function queuedRequest(item) {
  return { action: item.action, extra: { ...item.body, at: new Date(item.at).toISOString(), queueId: item.id } };
}

/** After trying to send the head of the queue: 'ok' and 'rejected' remove it, 'retry' keeps it for later. */
export function settle(queue, id, outcome) {
  if (outcome === 'retry') return (queue ?? []).map((i) => (i.id === id ? { ...i, tries: i.tries + 1 } : i));
  return (queue ?? []).filter((i) => i.id !== id);
}

/** How a server answer counts: network/5xx retry later; 4xx means Pulse refused it for good (e.g. already checked in). */
export function outcomeOf(error) {
  if (!error) return 'ok';
  if (error.offline || error.gate || !error.status || error.status >= 500 || error.status === 429 || error.status === 401) return 'retry';
  return 'rejected';
}

/** The day as the person will see it once the queue is sent. */
export function projected(payload, queue) {
  let p = payload;
  for (const item of queue ?? []) p = applyLocal(p, item.action, item.at, item.body);
  return p;
}
