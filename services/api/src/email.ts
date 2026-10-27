import type { PoolClient } from 'pg';
import { googleBridge as bridge } from './google.js';
import { fail, type Viewer } from './routes.js';
import { describeLabels, hasMailbox, inboxQuery, parseSender, sanitizeEmailHtml } from './email-model.js';

// CHATS-2: the individual mailbox, read-only, shaped for a Gmail-class reader. A page of the list is kept per viewer
// for a minute and a thread for five, so going back and forth never waits on Google twice; labels for ten.
type Cached = { at: number; data: unknown };
const cache = new Map<string, Cached>();
const remember = async <T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key); if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const data = await load(); cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > 600000) cache.delete(k);
  return data;
};
// POLISH-1 (mail on phones was a skeleton after 3 s): a list page or the labels last read for this person answer at once
// for up to half an hour while a fresh read runs behind them; the reply says when it was synced so the reader can ask
// for the fresh one after it has drawn. One read per key at a time.
const refreshing = new Map<string, Promise<void>>();
const latest = async <T>(key: string, ttl: number, keep: number, load: () => Promise<T>): Promise<{ data: T; at: number; stale: boolean }> => {
  const hit = cache.get(key), age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < ttl) return { data: hit.data as T, at: hit.at, stale: false };
  // Asked for a fresh read (ttl 0) while one is already under way (started behind a cached answer): join it.
  const running = refreshing.get(key);
  if (running && ttl === 0) { await running; const done = cache.get(key); if (done && done !== hit) return { data: done.data as T, at: done.at, stale: false }; }
  if (hit && age < keep) {
    if (!refreshing.has(key)) refreshing.set(key, load().then((data) => { cache.set(key, { at: Date.now(), data }); }, () => {}).finally(() => { refreshing.delete(key); }));
    return { data: hit.data as T, at: hit.at, stale: true };
  }
  const data = await load(); const now = Date.now(); cache.set(key, { at: now, data });
  return { data, at: now, stale: false };
};
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const GMAIL_ID = /^[A-Za-z0-9_-]{6,200}$/;
type Raw = { id: string; threadId?: string; from: string; to?: string; cc?: string; subject: string; date: string; internalDate?: string; labelIds?: string[]; snippet?: string; body?: string; html?: string | null;
  attachments?: { id: string; name: string; mime: string; size: number; cid: string | null }[]; unread: boolean; hasAttachment?: boolean };

async function mailbox(c: PoolClient, v: Viewer) {
  if (!hasMailbox(v.email)) fail(403, 'This account has no Workspace mailbox to read.');
  const a =(await c.query("select handle,is_shared from pulse.account where provider='google' and handle=$1 and holder_person_id=$2 and purpose like 'Workspace%'", [v.email, v.person])).rows[0];
  if (!a || a.is_shared) fail(403, 'Inbox requires your individual Workspace sign-in. Shared logins cannot select a mailbox.');
}
const labelNames = async (v: Viewer) => (await latest(`labels:${v.email}`, 600000, 86400000, async () => new Map(((await bridge('inbox', { subject: v.email, labels: true })).labels as { id: string; name: string }[]).map((l) => [l.id, l.name])))).data;
const at = (r: Raw) => r.internalDate && Number.isFinite(Number(r.internalDate)) ? new Date(Number(r.internalDate)).toISOString() : (Number.isFinite(Date.parse(r.date)) ? new Date(r.date).toISOString() : null);
function row(r: Raw, names: Map<string, string>) {
  const sender = parseSender(r.from);
  return { id: r.id, threadId: r.threadId ?? r.id, from: r.from, fromName: sender.name, fromEmail: sender.email, to: r.to ?? '', subject: r.subject || '(no subject)', date: r.date, at: at(r),
    snippet: (r.snippet ?? '').replace(/\s+/g, ' ').slice(0, 220), unread: r.unread, hasAttachment: !!r.hasAttachment || !!r.attachments?.length, ...describeLabels(r.labelIds ?? [], names) };
}

/** GET /api/v0/inbox: a page of the list (tab, label, search, unread), or one thread (`thread=`), or a message. */
export async function inbox(c: PoolClient, v: Viewer, q: { cursor?: string; message?: string; thread?: string; q?: string; unread?: string; category?: string; label?: string; starred?: string; fresh?: string }) {
  await mailbox(c, v);
  await c.query("select pulse.audit_write('restricted_read','gmail.inbox')");
  const base = { sendEnabled: process.env.PULSE_GMAIL_SEND_ENABLED === '1', account: v.email };
  const labels = labelNames(v).catch(() => new Map<string, string>());
  const thread = str(q.thread, 200) || str(q.message, 200);
  if (thread) {
    const names = await labels;
    if (!GMAIL_ID.test(thread)) fail(400, 'Choose a valid conversation');
    const d = await remember(`thread:${v.email}:${thread}:${q.thread ? 't' : 'm'}`, q.fresh === '1' ? 0 : 300000, () => bridge('inbox', { subject: v.email, ...(q.thread ? { thread } : { message: thread }) }));
    const messages = ((d.thread ?? (d.message ? [d.message] : [])) as Raw[]).map((m) => {
      const file = (f: { id: string; name: string; mime: string }) => `/api/v0/inbox/attachment?${new URLSearchParams({ message: m.id, id: f.id, name: f.name, mime: f.mime })}`;
      const inline = new Map((m.attachments ?? []).filter((f) => f.cid).map((f) => [f.cid!, file(f)]));
      const clean = m.html ? sanitizeEmailHtml(m.html, (cid) => inline.get(cid) ?? null) : null;
      return { ...row(m, names), to: m.to ?? '', cc: m.cc ?? '', body: m.body ?? '', html: clean?.html ?? null, remoteImages: clean?.remoteImages ?? 0,
        attachments: (m.attachments ?? []).filter((f) => !f.cid || !clean?.html.includes(file(f).replace(/&/g, '&amp;'))).map((f) => ({ name: f.name, mime: f.mime, size: f.size, url: file(f) })) };
    });
    return { ...base, rows: [], thread: messages, labels: [...names.values()].filter((n) => !/^(CATEGORY_|CHAT|\[Imap\])/.test(n)) };
  }
  const query = inboxQuery(q);
  const cursor = str(q.cursor, 300);
  // The labels and the page are read side by side (they used to wait for each other: two Google round trips).
  const [names, page] = await Promise.all([labels, latest(`list:${v.email}:${query}:${cursor}`, q.fresh === '1' ? 0 : 60000, q.fresh === '1' ? 0 : 1800000,
    () => bridge('inbox', { subject: v.email, query, cursor, limit: 25 }))]);
  const d = page.data;
  return { ...base, rows: (d.rows as Raw[]).map((r) => row(r, names)), nextCursor: d.nextCursor ?? null, estimate: d.estimate ?? null, query,
    syncedAt: new Date(page.at).toISOString(), stale: page.stale,
    labels: [...names.entries()].filter(([id, n]) => id.startsWith('Label_') && !/^(\[Imap\]|Notes$)/.test(n)).map(([, n]) => n).sort() };
}

/** GET /api/v0/inbox/attachment: one attachment of a message in the viewer's own mailbox. */
export async function attachment(c: PoolClient, v: Viewer, q: { message?: string; id?: string; name?: string; mime?: string }) {
  await mailbox(c, v);
  const message = str(q.message, 200), part = str(q.id, 2000);
  if (!GMAIL_ID.test(message) || !/^[A-Za-z0-9_-]{6,2000}$/.test(part)) fail(400, 'Choose a valid attachment');
  await c.query("select pulse.audit_write('download','gmail.attachment')");
  const d = await remember(`att:${v.email}:${message}:${part}`, 300000, () => bridge('inbox', { subject: v.email, message, attachment: part }));
  return { bytes: Buffer.from(String(d.bytes ?? ''), 'base64'), name: str(q.name, 200).replace(/[\x00-\x1f"\\/]/g, '_') || 'attachment', mime: str(q.mime, 100) };
}
