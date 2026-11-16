// GAP-FOUNDER-VIEW (9 Nov 2026; MASTER-BACKLOG PM-08): your own Google Calendar.
//  * Connect: Google sign-in as yourself, authorization code + PKCE S256, scopes `openid email` + calendar.events only
//    (Pulse adds, changes and removes the events it made; it reads your next events for your AI). The state is bound to
//    the person and their session (pulse_priv.calendar_attempt, 2020), used once, within ten minutes.
//  * The refresh token is sealed with the document keyring, bound to `<org>/<person>/calendar/google`, before it reaches
//    the database; it is never returned to a browser and never logged.
//  * Sync: your open tasks with a due time and the client appointments you booked go to your calendar as events with
//    stable ids (one Pulse item = one event, changed in place, removed when done or cancelled). "Sync now" runs it.
//  * For your AI: the v1 operation myNextEvents (MCP tool `my_next_events`) lists your next timed things from Pulse, and
//    your Google events when the calendar is connected.
// SWITCHED OFF until the owner sets up the Google client (MASTER-BACKLOG ML-02): it needs PULSE_GOOGLE_CALENDAR=1 and the
// install's (or the company's) Google OAuth client. Off, the screens show nothing about it, Connect refuses with
// `calendar_off`, and myNextEvents still lists Pulse's own events.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, failCode, sessionHash, type Tx, type Viewer } from './routes.js';
import { open as openSealed, requireKeyring, seal } from './document-keys.js';
import { companyOrigin } from './tenant-context.js';
import { googleClient } from './google-client.js';
import { defineV1Operation } from './v1.js';
import { maybe, object, str } from './v1-kit.js';
import { ORG_TZ } from './org-time.js';
import type { When } from './one-calendar.js';

type Body = Record<string, unknown>;
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_CALLBACK = '/settings/calendar/google';
export const CALENDAR_OFF = 'Google Calendar is not switched on for Pulse yet.';
/** Google's endpoints (tests point them at a synthetic Google). */
export const calendarGoogle = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', revoke: 'https://oauth2.googleapis.com/revoke',
  events: (calendar: string) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`,
};

/** Whether Google Calendar is switched on here: the server's switch and a Google OAuth client. */
export function calendarSwitch(): { on: boolean; reason: 'off' | 'no_client' | null } {
  if (process.env.PULSE_GOOGLE_CALENDAR !== '1') return { on: false, reason: 'off' };
  return googleClient() ? { on: true, reason: null } : { on: false, reason: 'no_client' };
}
const mustBeOn = () => { if (!calendarSwitch().on) failCode(409, CALENDAR_OFF, 'calendar_off'); };

export type CalendarItem = { source: 'task' | 'appointment' | 'event'; id: string; title: string; start: string; minutes: number; status?: string; project?: string | null; place?: string | null; timeZone: string };
export type GoogleEvent = { summary: string; description: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string }; location?: string;
  source: { title: string; url: string }; extendedProperties: { private: { pulse: string } } };
export type Pushed = { source: string; source_id: string; event_id: string; fingerprint: string };

/** One Pulse item's Google event id: base32hex (0-9, a-v), stable for this company, person, kind and item. */
export function eventId(org: string, person: string, source: string, id: string): string {
  return 'pulse' + createHash('sha256').update(`${org}/${person}/${source}/${id}`).digest('hex').slice(0, 40);
}

/** The event Google keeps for one Pulse item (plain words; a link back to the item). */
export function eventFor(item: CalendarItem, origin: string): GoogleEvent {
  const start = new Date(item.start), end = new Date(start.getTime() + Math.max(5, Math.min(600, Number(item.minutes) || 30)) * 60_000);
  const url = item.source === 'task' ? `${origin}/tasks/${item.id}` : item.source === 'event' ? `${origin}/calendar` : `${origin}/appointments`;
  const what = item.source === 'task' ? `A task in Pulse${item.project ? ` (${item.project})` : ''}.` : item.source === 'event' ? 'An event on your Pulse calendar.' : 'A meeting booked in Pulse.';
  return { summary: item.title.slice(0, 300), description: `${what}\nOpen it: ${url}`,
    start: { dateTime: start.toISOString(), timeZone: item.timeZone }, end: { dateTime: end.toISOString(), timeZone: item.timeZone },
    ...(item.place ? { location: item.place.slice(0, 300) } : {}), source: { title: 'Pulse', url }, extendedProperties: { private: { pulse: `${item.source}:${item.id}` } } };
}

export const fingerprint = (e: GoogleEvent) => createHash('sha256').update(JSON.stringify(e)).digest('hex');

/** What one sync does: add or change the events whose item changed, remove those whose item left the calendar. */
export function syncPlan(org: string, person: string, items: readonly CalendarItem[], pushed: readonly Pushed[], origin: string, want: { tasks: boolean; meetings: boolean }) {
  // CALENDAR-HUB: the person's own Pulse events always go (they made them for their calendar).
  const keep = items.filter((i) => (i.source === 'task' ? want.tasks : i.source === 'event' ? true : want.meetings));
  const known = new Map(pushed.map((p) => [`${p.source}:${p.source_id}`, p]));
  const put: { item: CalendarItem; eventId: string; event: GoogleEvent; fingerprint: string; isNew: boolean }[] = [];
  const seen = new Set<string>();
  for (const item of keep) {
    const key = `${item.source}:${item.id}`; seen.add(key);
    const event = eventFor(item, origin), fp = fingerprint(event), had = known.get(key);
    if (had && had.fingerprint === fp) continue;
    put.push({ item, eventId: had?.event_id ?? eventId(org, person, item.source, item.id), event, fingerprint: fp, isNew: !had });
  }
  const remove = pushed.filter((p) => !seen.has(`${p.source}:${p.source_id}`));
  return { put, remove };
}

class CalendarError extends Error { constructor(message: string, readonly reconnect = false) { super(message); } }
async function google(url: string, init: RequestInit): Promise<Body> {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); }
  catch { throw new CalendarError('Google did not answer. Try again in a minute.'); }
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({})) as Body;
  if (!r.ok) {
    const code = String(data.error ?? '');
    if (code === 'invalid_grant' || r.status === 401) throw new CalendarError('Google no longer lets Pulse use your calendar. Connect it again.', true);
    if (r.status === 404 || r.status === 410) return { gone: true };
    throw new CalendarError(`Google refused (${r.status}).`);
  }
  return data;
}
const form = (x: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(x).toString() });
const context = (org: string, person: string) => `${org}/${person}/calendar/google`;
const sessionKey = (req: FastifyRequest, v: Viewer) => sessionHash('calendar:' + String(req.headers['x-pulse-session'] ?? req.headers['x-pulse-access-id'] ?? `${v.email}`));
const must = (v: Viewer) => { if (!v.person) fail(403, 'Sign in as yourself to connect your calendar'); };
type Sealed = { address: string; calendar_id: string; key_id: string; token_wrapped: Buffer; token_sealed: Buffer; push_tasks: boolean; push_meetings: boolean };

async function accessToken(org: string, person: string, s: Sealed): Promise<string> {
  const client = googleClient() ?? (() => { throw new CalendarError(CALENDAR_OFF); })();
  const plain = openSealed(await requireKeyring('mail'), { keyId: s.key_id, dataKey: s.token_wrapped, data: s.token_sealed }, context(org, person));
  let refresh: string;
  try { refresh = plain.toString('utf8'); } finally { plain.fill(0); }
  const t = await google(calendarGoogle.token, form({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }));
  if (typeof t.access_token !== 'string') throw new CalendarError('Google gave no access to your calendar. Connect it again.', true);
  return t.access_token;
}

// ------------------------------------------------------------------------------------------------ two-way (CALENDAR-HUB)
// The read half of the sync (owner, 13 Nov 2026, T2.1.5 "Google Calendar two-way sync"). Each sync first asks Google
// what changed since the last one (its sync token; a full read of five weeks back and on when there is none, or when
// Google says the token is too old: 410). Then:
//  * an event Pulse pushed (calendar_pushed) that was changed in Google after Pulse last wrote it: its new time comes
//    back to Pulse. A task's due time moves (through task_save, the person's own rights); the person's own event takes
//    the new title, time and place. A client meeting stays as booked in Pulse (the next push puts it back).
//  * a Pulse event deleted in Google is deleted in Pulse too. A deleted task's event is not: the task is work, and its
//    event comes back when the task changes.
//  * the person's other Google events are copied in as their own events with source 'google' (row security: theirs
//    only), so the one calendar shows them; changing one in Pulse changes it in Google first (googleEventChange).
//  * events Pulse made from another company (their private `pulse` mark) are left out, so nothing shows twice.
export type Pulled = { read: number; moved: number; added: number; removed: number };
type GTime = { dateTime?: string; date?: string; timeZone?: string };
const gStart = (t: GTime | undefined) => (t?.dateTime ? { at: t.dateTime, day: null } : t?.date ? { at: null, day: t.date } : null);

export async function pullGoogle(c: PoolClient, token: string, calendarId: string): Promise<Pulled> {
  const out: Pulled = { read: 0, moved: 0, added: 0, removed: 0 };
  let syncToken = ((await c.query('select pulse.calendar_pull_token() t')).rows[0]?.t ?? null) as string | null;
  const auth = { authorization: `Bearer ${token}` };
  let items: Body[] = [], next: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    items = []; next = null;
    let pageToken: string | undefined, gone = false;
    for (let page = 0; page < 10; page++) {
      const url = new URL(calendarGoogle.events(calendarId));
      const q: Record<string, string> = syncToken ? { syncToken, singleEvents: 'true', maxResults: '250' }
        : { timeMin: new Date(Date.now() - 35 * 86_400_000).toISOString(), singleEvents: 'true', showDeleted: 'true', maxResults: '250' };
      if (pageToken) q.pageToken = pageToken;
      for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
      const r = await google(url.href, { headers: auth });
      if (r.gone) { gone = true; break; }
      items.push(...((Array.isArray(r.items) ? r.items : []) as Body[]));
      pageToken = typeof r.nextPageToken === 'string' ? r.nextPageToken : undefined;
      if (typeof r.nextSyncToken === 'string') next = r.nextSyncToken;
      if (!pageToken) break;
    }
    if (gone && syncToken) { syncToken = null; continue; } // Google forgot the token (410): read the window again
    break;
  }
  out.read = items.length;
  const tz = (await c.query(`select ${ORG_TZ} tz`)).rows[0].tz as string;
  const pushed = new Map(((await c.query('select source,source_id::text id,event_id,pushed_at from pulse.calendar_pushed')).rows as { source: string; id: string; event_id: string; pushed_at: Date }[])
    .map((p) => [p.event_id, p]));
  for (const g of items) {
    const gid = typeof g.id === 'string' ? g.id.slice(0, 1024) : '';
    if (!gid) continue;
    const cancelled = g.status === 'cancelled';
    const ours = pushed.get(gid);
    await c.query('savepoint cal_pull');
    try {
      if (ours) {
        if (cancelled) {
          if (ours.source === 'event') {
            await c.query("delete from pulse.calendar_event where id=$1 and source='pulse'", [ours.id]);
            await c.query("delete from pulse.calendar_pushed where source='event' and source_id=$1", [ours.id]);
            out.removed += 1;
          }
        } else if (Date.parse(String(g.updated ?? '')) > ours.pushed_at.getTime() + 2000) {
          const st = gStart(g.start as GTime), en = gStart(g.end as GTime);
          if (ours.source === 'task' && st?.at) {
            await c.query('select pulse.task_save($1,$2)', [ours.id, JSON.stringify({ dueAt: new Date(st.at).toISOString() })]);
            out.moved += 1;
          } else if (ours.source === 'event' && st) {
            await c.query(`update pulse.calendar_event set title=coalesce(nullif(left(btrim($2),200),''),title),
                starts_at=coalesce($3::timestamptz,($4::date::timestamp at time zone $7)),ends_at=coalesce($5::timestamptz,($6::date::timestamp at time zone $7)),
                all_day=($3::text is null),place=coalesce(left($8,300),place),updated_at=now() where id=$1 and source='pulse'`,
            [ours.id, String(g.summary ?? ''), st.at, st.day, en?.at ?? null, en?.day ?? st.day, tz, typeof g.location === 'string' ? g.location : null]);
            out.moved += 1;
          }
          // clock_timestamp, not now(): now() is when the sync's transaction began, before Google's own change.
          await c.query('update pulse.calendar_pushed set pushed_at=clock_timestamp() where event_id=$1', [gid]);
        }
      } else if (((g.extendedProperties as Body | undefined)?.private as Body | undefined)?.pulse) {
        // made by Pulse from another company: that company shows it already
      } else if (cancelled) {
        const r = await c.query("delete from pulse.calendar_event where source='google' and google_id=$1", [gid]);
        out.removed += r.rowCount ?? 0;
      } else {
        const st = gStart(g.start as GTime), en = gStart(g.end as GTime);
        if (!st) { await c.query('release savepoint cal_pull'); continue; }
        const link = typeof g.htmlLink === 'string' && /^https:\/\//.test(g.htmlLink) ? g.htmlLink.slice(0, 1000) : null;
        const r = await c.query(`insert into pulse.calendar_event(org_id,person_id,title,starts_at,ends_at,all_day,place,source,google_id,google_link)
            select pulse.current_org(),pulse.current_viewer(),coalesce(nullif(left(btrim($1),200),''),'Busy'),s,least(greatest(e,s+interval '5 minutes'),s+interval '31 days'),$3::text is null,left($8,300),'google',$9,$10
            from (select coalesce($3::timestamptz,($4::date::timestamp at time zone $7)) s,coalesce($5::timestamptz,($6::date::timestamp at time zone $7)) e) w
          on conflict (org_id,person_id,google_id) where source='google' do update set title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
            all_day=excluded.all_day,place=excluded.place,google_link=excluded.google_link,updated_at=now() returning (xmax=0) added`,
        [String(g.summary ?? ''), null, st.at, st.day, en?.at ?? null, en?.day ?? st.day, tz, typeof g.location === 'string' ? g.location : null, gid, link]);
        if (r.rows[0]?.added) out.added += 1;
      }
      await c.query('release savepoint cal_pull');
    } catch { await c.query('rollback to savepoint cal_pull'); }
  }
  await c.query('select pulse.calendar_pull_saved($1)', [next]);
  return out;
}

/** Change or remove one of the person's Google events from Pulse (Google first; Pulse's copy changes after). */
export async function googleEventChange(c: PoolClient, org: string, person: string, googleId: string, change: { title?: string; when?: When; remove?: boolean }) {
  const reconnect = 'Your Google Calendar is not connected here any more. Connect it again to change its events.';
  if (!calendarSwitch().on) failCode(409, CALENDAR_OFF, 'calendar_off');
  const s = (await c.query('select * from pulse.calendar_sealed()')).rows[0] as Sealed | undefined;
  if (!s) failCode(409, reconnect, 'calendar_reconnect');
  try {
    const token = await accessToken(org, person, s!);
    const url = `${calendarGoogle.events(s!.calendar_id)}/${encodeURIComponent(googleId)}`;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    if (change.remove) { await google(url, { method: 'DELETE', headers: auth }); return; }
    const tz = (await c.query(`select ${ORG_TZ} tz`)).rows[0].tz as string;
    const w = change.when;
    const plus1 = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const body: Body = { ...(change.title ? { summary: change.title.slice(0, 300) } : {}),
      ...(w ? (w.allDay ? { start: { date: w.start }, end: { date: plus1(w.end) } } : { start: { dateTime: `${w.start}:00`, timeZone: tz }, end: { dateTime: `${w.end}:00`, timeZone: tz } }) : {}) };
    const r = await google(url, { method: 'PATCH', headers: auth, body: JSON.stringify(body) });
    if (r.gone) failCode(409, 'This event is no longer in your Google Calendar. Press Sync now.', 'calendar_failed');
  } catch (e) {
    if (e instanceof CalendarError) failCode(409, e.message, e.reconnect ? 'calendar_reconnect' : 'calendar_failed');
    throw e;
  }
}

/** Push this person's items to their calendar. Runs as them inside their organisation (`c`); Google calls in between. */
export async function syncCalendar(c: PoolClient, org: string, person: string): Promise<{ added: number; changed: number; removed: number; fromGoogle: Pulled }> {
  const s = (await c.query('select * from pulse.calendar_sealed()')).rows[0] as Sealed | undefined;
  if (!s) fail(404, 'Connect your calendar first');
  try {
    const token = await accessToken(org, person, s!);
    // CALENDAR-HUB (T2.1.5): read Google first (what changed there since the last sync), then push Pulse's side.
    const pulled = await pullGoogle(c, token, s!.calendar_id);
    const items = (await c.query('select pulse.calendar_items() i')).rows[0].i as CalendarItem[];
    const pushed = (await c.query('select source,source_id,event_id,fingerprint from pulse.calendar_pushed')).rows as Pushed[];
    const plan = syncPlan(org, person, items, pushed, companyOrigin(), { tasks: s!.push_tasks, meetings: s!.push_meetings });
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    let added = 0, changed = 0;
    for (const p of plan.put) {
      const base = calendarGoogle.events(s!.calendar_id);
      const r = p.isNew ? await google(base, { method: 'POST', headers: auth, body: JSON.stringify({ id: p.eventId, ...p.event }) })
        : await google(`${base}/${p.eventId}`, { method: 'PUT', headers: auth, body: JSON.stringify(p.event) });
      // An event someone deleted in Google comes back when its item changes.
      if (r.gone) await google(base, { method: 'POST', headers: auth, body: JSON.stringify({ id: p.eventId, ...p.event }) });
      // pushed_at is the moment after Google took the write (clock_timestamp; now() is the transaction's start), so the
      // next pull does not mistake Pulse's own write for a change made in Google.
      await c.query(`insert into pulse.calendar_pushed(org_id,person_id,source,source_id,event_id,fingerprint,pushed_at) values(pulse.current_org(),pulse.current_viewer(),$1,$2,$3,$4,clock_timestamp())
        on conflict (org_id,person_id,source,source_id) do update set event_id=excluded.event_id,fingerprint=excluded.fingerprint,pushed_at=excluded.pushed_at`, [p.item.source, p.item.id, p.eventId, p.fingerprint]);
      if (p.isNew) added += 1; else changed += 1;
    }
    for (const p of plan.remove) {
      await google(`${calendarGoogle.events(s!.calendar_id)}/${p.event_id}`, { method: 'DELETE', headers: auth });
      await c.query('delete from pulse.calendar_pushed where source=$1 and source_id=$2', [p.source, p.source_id]);
    }
    await c.query('select pulse.calendar_report(true)');
    return { added, changed, removed: plan.remove.length, fromGoogle: pulled };
  } catch (e) {
    if (e instanceof CalendarError) { await c.query('select pulse.calendar_report(false,$1)', [e.message]); failCode(409, e.message, e.reconnect ? 'calendar_reconnect' : 'calendar_failed'); }
    throw e;
  }
}

export function registerCalendarRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const state = async (c: PoolClient) => {
    const sw = calendarSwitch();
    return { on: sw.on, ...(sw.on ? { connection: (await c.query('select pulse.calendar_state() s')).rows[0].s ?? null } : {}) };
  };
  app.get('/api/v0/calendar', (req) => tx(req, async (c, v) => { must(v); return state(c); }));

  app.post<{ Body: Body }>('/api/v0/calendar/google/start', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    must(v); mustBeOn();
    const client = googleClient()!;
    const stateToken = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    await c.query('select pulse.calendar_begin($1,$2,$3)', [sessionHash(stateToken), sessionKey(req, v), verifier]);
    const url = new URL(calendarGoogle.authorize);
    for (const [k, value] of Object.entries({ client_id: client.clientId, redirect_uri: new URL(CALENDAR_CALLBACK, companyOrigin()).href, response_type: 'code',
      scope: `openid email ${CALENDAR_SCOPE}`, access_type: 'offline', prompt: 'consent select_account', state: stateToken,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, value);
    return { url: url.href };
  }));

  app.post<{ Body: Body }>('/api/v0/calendar/google/finish', { schema: { body: { type: 'object' } } }, async (req) => {
    const stateToken = typeof req.body?.state === 'string' ? req.body.state.slice(0, 200) : '', code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 2000) : '';
    // The attempt is used up (committed) before the code is exchanged: a replayed state finds nothing.
    const { verifier, org, person } = await tx(req, async (c, v) => {
      must(v); mustBeOn();
      if (!stateToken || !code) fail(400, 'Google did not send Pulse back a sign-in. Press Connect again.');
      return { verifier: (await c.query('select pulse.calendar_take($1,$2) v', [sessionHash(stateToken), sessionKey(req, v)])).rows[0].v as string | null, org: v.org, person: v.person! };
    });
    if (!verifier) fail(400, 'This Google sign-in has expired or was already used. Press Connect again.');
    const client = googleClient() ?? failCode(409, CALENDAR_OFF, 'calendar_off');
    let t: Body, who: Body;
    try {
      t = await google(calendarGoogle.token, form({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: new URL(CALENDAR_CALLBACK, companyOrigin()).href, grant_type: 'authorization_code', code_verifier: verifier! }));
      if (!String(t.scope ?? '').split(/\s+/).includes(CALENDAR_SCOPE)) fail(400, 'Google did not let Pulse add events to your calendar. Press Connect again and allow it.');
      if (typeof t.refresh_token !== 'string' || typeof t.access_token !== 'string') fail(400, 'Google did not give Pulse lasting access. Press Connect again.');
      who = await google(calendarGoogle.userinfo, { headers: { authorization: `Bearer ${t.access_token}` } });
    } catch (e) { if (e instanceof CalendarError) fail(409, e.message); throw e; }
    const address = String(who.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || who.email_verified !== true) fail(400, 'Google did not confirm this account’s e-mail address.');
    const sealed = seal(await requireKeyring('mail'), Buffer.from(String(t.refresh_token), 'utf8'), context(org, person));
    return tx(req, async (c, v) => {
      must(v);
      if (v.org !== org || v.person !== person) fail(409, 'You switched organisation while connecting. Press Connect again.');
      await c.query('select pulse.calendar_save($1,$2,$3,$4)', [address, sealed.keyId, sealed.dataKey, sealed.data]);
      return state(c);
    });
  });

  app.post<{ Body: Body }>('/api/v0/calendar/settings', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    must(v); mustBeOn();
    const b = req.body ?? {};
    await c.query('select pulse.calendar_set($1,$2)', [typeof b.pushTasks === 'boolean' ? b.pushTasks : null, typeof b.pushMeetings === 'boolean' ? b.pushMeetings : null]);
    return state(c);
  }));

  app.post<{ Body: Body }>('/api/v0/calendar/sync', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    must(v); mustBeOn();
    return { ...(await syncCalendar(c, v.org, v.person!)), ...(await state(c)) };
  }));

  app.post<{ Body: Body }>('/api/v0/calendar/disconnect', { schema: { body: { type: 'object' } } }, async (req) => {
    const { s, org, person } = await tx(req, async (c, v) => { must(v); return { s: (await c.query('select * from pulse.calendar_sealed()')).rows[0] as Sealed | undefined, org: v.org, person: v.person! }; });
    // Tell Google too (best effort: the token is gone from Pulse either way).
    if (s && calendarSwitch().on) {
      try {
        const plain = openSealed(await requireKeyring('mail'), { keyId: s.key_id, dataKey: s.token_wrapped, data: s.token_sealed }, context(org, person));
        const token = plain.toString('utf8'); plain.fill(0);
        await fetch(calendarGoogle.revoke, { ...form({ token }), signal: AbortSignal.timeout(10000) }).catch(() => {});
      } catch { /* the keyring or Google is unavailable: removing it from Pulse is what counts */ }
    }
    return tx(req, async (c, v) => { must(v); await c.query('select pulse.calendar_disconnect()'); return state(c); });
  });
}

// ------------------------------------------------------------------------------------------------ for your AI (API v1, MCP)
const NEXT = object({ start: str, end: str, title: str, source: { enum: ['task', 'appointment', 'event', 'google'] }, place: maybe, url: maybe });
defineV1Operation({ operationId: 'myNextEvents', method: 'GET', path: '/api/v1/people/me/events/next', scope: 'people.read',
  summary: 'Your next timed things: tasks with a due time and meetings in Pulse, and your Google Calendar when connected',
  query: object({ hours: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-6][0-8])$' } }, []),
  response: object({ hours: { type: 'integer' }, google: { enum: ['off', 'not_connected', 'ok', 'failed'] }, items: { type: 'array', items: NEXT } }),
  mcp: { name: 'my_next_events', title: 'My next events', description: 'Lists what is coming up for you in the next hours (default 24, at most 168), soonest first: your open tasks with a due time and the client meetings you booked in Pulse, and the events in your own Google Calendar when you connected it. google says whether the calendar was read (off: not switched on yet; not_connected; ok; failed). Read only.' },
  handler: async (ctx, { query }) => {
    const hours = Math.min(168, Math.max(1, Number(query.hours) || 24));
    const now = Date.now(), until = now + hours * 3_600_000, origin = companyOrigin();
    const pulse = ((await ctx.client.query('select pulse.calendar_items(8) i')).rows[0]?.i ?? []) as CalendarItem[];
    const items: { start: string; end: string; title: string; source: 'task' | 'appointment' | 'event' | 'google'; place: string | null; url: string | null }[] = [];
    for (const i of pulse) {
      const e = eventFor(i, origin), at = Date.parse(e.start.dateTime);
      if (at + 60_000 >= now && at <= until) items.push({ start: e.start.dateTime, end: e.end.dateTime, title: i.title, source: i.source, place: i.place ?? null, url: e.source.url });
    }
    let g: 'off' | 'not_connected' | 'ok' | 'failed' = calendarSwitch().on ? 'not_connected' : 'off';
    if (g === 'not_connected') {
      // An AI member's key has no calendar of its own (calendar_person refuses it): a savepoint keeps the call's
      // transaction usable either way.
      const who = (await ctx.client.query('select pulse.current_org()::text o, pulse.current_viewer()::text p')).rows[0] as { o: string; p: string | null };
      await ctx.client.query('savepoint calendar');
      let s: Sealed | undefined;
      try { s = (await ctx.client.query('select * from pulse.calendar_sealed()')).rows[0] as Sealed | undefined; await ctx.client.query('release savepoint calendar'); }
      catch { await ctx.client.query('rollback to savepoint calendar'); s = undefined; }
      if (s && who.p) {
        try {
          const token = await accessToken(who.o, who.p, s);
          const url = new URL(calendarGoogle.events(s.calendar_id));
          for (const [k, v] of Object.entries({ timeMin: new Date(now).toISOString(), timeMax: new Date(until).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' })) url.searchParams.set(k, v);
          const r = await google(url.href, { headers: { authorization: `Bearer ${token}` } });
          for (const e of (Array.isArray(r.items) ? r.items : []) as Body[]) {
            const priv = (e.extendedProperties as Body | undefined)?.private as Body | undefined;
            if (priv?.pulse) continue; // Pulse's own events are already listed above
            const st = e.start as Body | undefined, en = e.end as Body | undefined;
            const start = String(st?.dateTime ?? st?.date ?? ''), end = String(en?.dateTime ?? en?.date ?? start);
            if (start) items.push({ start, end, title: String(e.summary ?? 'Busy').slice(0, 300), source: 'google', place: typeof e.location === 'string' ? e.location.slice(0, 300) : null, url: typeof e.htmlLink === 'string' ? e.htmlLink : null });
          }
          g = 'ok';
        } catch { g = 'failed'; }
      }
    }
    items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { hours, google: g, items: items.slice(0, 100) };
  },
});
