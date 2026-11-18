// CHAT-ALL (owner, 18 Nov 2026: "Chat should be multi-organisation: a quick switch between All and one company"): the
// chat lists of every company the signed-in account is in, for the chat list's "All | <company>" switch.
//
// As My day and My connections: every seat is read in its own READ ONLY transaction, inside that organisation and as the
// account's person there (pulse.chat_list_facts is that organisation's own list: its row rules decide every row); the
// API only puts the lists side by side. No query reads two organisations, nothing is written (a company's own /chats
// marks messages delivered when it is opened there).
//
// The owner's sign-in rule (ACCOUNT-META, SWITCH-SMOOTH): a company this sign-in may not open yet (account_crossing's
// `locked`: a company's own sign-in on a browser that never proved the person) is never read; it is named as locked,
// and the list says "Confirm it's you to see its chats" (one tap, the switcher's own proof).
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { inSeat, markOf, MAX_SEATS, seatsOf, type Seat } from './my-day.js';

/** Most conversations a company sends (latest first); the rest open in that company. */
export const MAX_PER_SEAT = 150;
/** Seats read at the same time (each is one short read; the pool is shared with every other request). */
const AT_ONCE = 3;

export type AcrossChannel = {
  id: string; name: string; kind: string; peerId: string | null; peerPhotoAt: string | null; peerAgent: boolean; photoAt: string | null;
  pinnedAt: string | null; mutedUntil: string | null; archivedAt: string | null; markedUnread: string | null; unread: number; mentions: number;
  lastAt: string | null; preview: string | null; previewAuthor: string | null; previewAuthorId: string | null; previewKind: string | null;
  previewRemoved: boolean; previewAttachment: unknown; withOrg: string | null; clientFacing: boolean; members: number;
};
export type AcrossSeat = {
  org: string; name: string; handle: string | null; kind: string; current: boolean; personal: boolean; purpose: Seat['purpose'];
  mark: string | null; viewer: string | null; state: 'ok' | 'locked' | 'unavailable' | 'current'; guest: boolean;
  unreadChats: number; unreadMessages: number; mentions: number; more: number; channels: AcrossChannel[];
  /** CONNECT: chats another company shares with this one (they live in that company: read through my guest seat there). */
  shared: { ref: string; hostOrg: string }[];
};

// One company's conversations of mine (members only: a moderator's other groups stay in that company), the other person
// of a direct chat, unread and mentions after my read point (thread replies and imported history not counted, as /chats),
// and a one-line preview. The same facts and counting as GET /chats, without its write (delivered marks) or its extras.
const LIST = `with facts as materialized (select * from pulse.chat_list_facts() where member)
 select ch.id, case when ch.kind='direct' then coalesce(peer.name,'Direct message') else ch.name end name, ch.kind,
  peer.id "peerId", peer.photo_at "peerPhotoAt", coalesce(peer.agent,false) "peerAgent", ch.photo_at "photoAt",
  f.pinned_at "pinnedAt", f.muted_until "mutedUntil", f.archived_at "archivedAt", f.marked_unread_at "markedUnread",
  coalesce(news.unread,0) unread, coalesce(news.mentions,0) mentions,
  coalesce(last.created_at, case when ch.key like 'wa:%' then (pulse.wa_channel(ch.id)->>'lastAt')::timestamptz end) "lastAt",
  last.body preview, last.name "previewAuthor", last.author_id "previewAuthorId", last.kind "previewKind", last.removed "previewRemoved",
  last.attachment "previewAttachment", f.with_org "withOrg", (ch.kind<>'direct' and coalesce(f.client_facing,false)) "clientFacing", coalesce(f.members,0) members
 from pulse.chat_channel ch join facts f on f.channel_id=ch.id
 left join lateral (select p.id, p.display_name name, (select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) photo_at, p.side='agent' agent
   from pulse.chat_member cm join pulse.person p on p.id=cm.person_id where ch.kind='direct' and cm.channel_id=ch.id and cm.person_id<>$1 limit 1) peer on true
 left join lateral (select left(regexp_replace(m.body,'\\s+',' ','g'),140) body,
   coalesce((select g.label||' (WhatsApp)' from pulse.chat_guest g where g.id=m.guest_id),p.display_name) name, m.author_id, m.kind,
   m.removed_at is not null removed, m.attachments->0 attachment, m.created_at
   from pulse.chat_message m join pulse.person p on p.id=m.author_id where m.channel_id=ch.id order by m.created_at desc limit 1) last on true
 left join lateral (select count(*) filter (where m.author_id<>$1 and m.kind='text' and m.parent_id is null)::int unread,
   count(*) filter (where $1=any(m.mentions) or m.broadcast='everyone' and m.author_id<>$1 and coalesce(f.muted_until<=now(),true))::int mentions
   from pulse.chat_message m where m.channel_id=ch.id and m.created_at>f.read_through and m.removed_at is null and m.import_ref is null) news on true
 order by f.pinned_at is null, coalesce(last.created_at, ch.created_at) desc nulls last
 limit ${MAX_PER_SEAT + 1}`;

const iso = (t: unknown) => t instanceof Date && Number.isFinite(t.getTime()) ? t.toISOString() : t == null ? null : String(t);
const muted = (until: string | null, now: number) => !!until && Date.parse(until) > now;

/** A company's totals for the switch: chats with unread (not muted, not archived) and their messages. Pure (tested). */
export function seatTotals(channels: Pick<AcrossChannel, 'unread' | 'mentions' | 'mutedUntil' | 'archivedAt' | 'markedUnread'>[], now = Date.now()) {
  let unreadChats = 0, unreadMessages = 0, mentions = 0;
  for (const c of channels) {
    if (c.archivedAt) continue;
    mentions += c.mentions || 0;
    if (muted(c.mutedUntil, now)) continue;
    if (c.unread || c.markedUnread) unreadChats++;
    unreadMessages += c.unread || 0;
  }
  return { unreadChats, unreadMessages, mentions };
}

/** A guest seat (CONNECT): the account's place in another company that shares chats with one of its own. Its chats show
 *  in "All" and under the company of mine they are shared with; it is not a company of its own in the switch. */
export const guestSeat = (s: Pick<Seat, 'kind'>) => s.kind === 'partner';
/** Which seats are read: the current one, then the account's companies and personal space, then guest seats; never an AI
 *  employee's seat; test and demo companies only when this sign-in is in one now (they never count in "All"). Pure (tested). */
export function seatsToRead(seats: Seat[]) {
  const rank = (s: Seat) => s.current ? 0 : guestSeat(s) ? 2 : 1;
  return seats.filter((s) => s.kind !== 'agent' && (s.purpose === 'work' || s.current))
    .map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s).slice(0, MAX_SEATS);
}

/** Runs `work` over `items`, `limit` at a time, keeping the order. */
async function pooled<T, R>(items: T[], limit: number, work: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]); } }));
  return out;
}

export async function readSeatChats(c: PoolClient, person: string) {
  const rows = (await c.query(LIST, [person])).rows as Record<string, unknown>[];
  const channels = rows.slice(0, MAX_PER_SEAT).map((r) => ({ ...r, peerPhotoAt: iso(r.peerPhotoAt), photoAt: iso(r.photoAt), pinnedAt: iso(r.pinnedAt), mutedUntil: iso(r.mutedUntil),
    archivedAt: iso(r.archivedAt), markedUnread: iso(r.markedUnread), lastAt: iso(r.lastAt) }) as AcrossChannel);
  return { channels, more: rows.length > MAX_PER_SEAT };
}

/** CONNECT (0957): the chats other companies share with the company this transaction is in (each lives in its host). */
async function sharedWith(c: PoolClient) {
  const l = (await c.query('select pulse.connect_shared_chats() l')).rows[0]?.l as { ref?: string; hostOrg?: string }[] | null;
  return (l ?? []).filter((x) => x.ref && x.hostOrg).map((x) => ({ ref: String(x.ref), hostOrg: String(x.hostOrg) }));
}

const who = (v: Viewer) => { if (!v.person) fail(403, 'Chats needs your own account'); return v; };

export function registerChatsAcrossRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  app.get<{ Querystring: { current?: string } }>('/api/v0/chats/across', async (req) => {
    const { seats, actor, locked, mark, currentShared } = await tx(req, async (c, v) => {
      who(v);
      const seats = await seatsOf(c);
      // SWITCH-SMOOTH: the companies this sign-in may not open yet. Read in the same transaction as the seats.
      const cross = (await c.query('select pulse.account_crossing() r')).rows[0]?.r as { locked?: string[] } | null;
      // The current company's logo, read here (this request is inside it).
      return { seats, actor: v.email, locked: new Set((cross?.locked ?? []).map(String)), mark: await markOf(c, v.org), currentShared: await sharedWith(c) };
    });
    // The current company's list is the page's own (/chats, live); it is read here too only when asked (`current=1`).
    const withCurrent = req.query.current === '1';
    const listed = seatsToRead(seats);
    const out = await pooled(listed, AT_ONCE, async (s): Promise<AcrossSeat> => {
      const base = { org: s.org, name: s.name, handle: s.handle, kind: s.kind, current: s.current, personal: s.personal, purpose: s.purpose,
        mark: null as string | null, viewer: s.current || !locked.has(s.org) ? s.person : null, guest: guestSeat(s), unreadChats: 0, unreadMessages: 0, mentions: 0, more: 0,
        channels: [] as AcrossChannel[], shared: [] as AcrossSeat['shared'] };
      if (!s.current && locked.has(s.org)) return { ...base, state: 'locked' };
      if (s.current && !withCurrent) return { ...base, mark, shared: currentShared, state: 'current' };
      try {
        const { mark, list, shared } = await inSeat(pool, s, actor, false, async (c) => ({ mark: await markOf(c, s.org), list: await readSeatChats(c, s.person),
          shared: guestSeat(s) ? [] : await sharedWith(c) }));
        return { ...base, mark, ...seatTotals(list.channels), more: list.more ? 1 : 0, channels: list.channels, shared, state: 'ok' };
      } catch (e) {
        req.log.warn({ err: e, org: s.org }, 'chats across: seat unavailable');
        return { ...base, state: 'unavailable' };
      }
    });
    return { generatedAt: new Date().toISOString(), seats: out, more: Math.max(0, seats.filter((s) => s.kind !== 'agent' && s.purpose === 'work').length - listed.length) };
  });
}
