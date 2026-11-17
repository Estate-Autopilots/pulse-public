// CALENDAR-HUB (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 P2.1): the one calendar's pure parts and the Google two-way
// read. Google is a stub that answers events.list; the database is a stub client that records each SQL call and answers
// the few reads. No network, no database, synthetic values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { calWindow, kindsOf, plusMinutes, whenArgs, whenOf } from '../dist/one-calendar.js';
import { calendarGoogle, eventFor, pullGoogle, syncPlan } from '../dist/calendar.js';

test('kindsOf keeps the kinds a screen asked for, and every kind when none', () => {
  assert.deepEqual([...kindsOf('post,brand,leave')], ['post', 'leave']);
  assert.equal(kindsOf(undefined).size, 7);
  assert.equal(kindsOf('nothing-known').size, 7);
});

test('calWindow and whenOf keep to real days and sane lengths', () => {
  assert.deepEqual(calWindow({}, '2026-11-13'), { from: '2026-10-09', to: '2027-01-22' });
  assert.throws(() => calWindow({ from: '2026-11-13', to: '2026-11-01' }, '2026-11-13'), /start day before the end day/);
  assert.deepEqual(whenOf({ start: '2026-11-13T10:00' }), { start: '2026-11-13T10:00', end: '2026-11-13T11:00', allDay: false });
  assert.deepEqual(whenOf({ start: '2026-11-13', allDay: true }), { start: '2026-11-13', end: '2026-11-13', allDay: true });
  assert.throws(() => whenOf({ start: '2026-11-13T10:00', end: '2026-11-13T09:00' }), /end time is before/);
  assert.throws(() => whenOf({ start: '2026-11-01', end: '2026-12-15', allDay: true }), /31 days or fewer/);
  assert.throws(() => whenOf({ start: 'tomorrow' }), /Pick a day and a start time/);
  // An all-day event is stored up to the start of the day after its last day.
  assert.deepEqual(whenArgs({ start: '2026-11-13', end: '2026-11-14', allDay: true }), ['2026-11-13T00:00', '2026-11-15T00:00']);
  assert.equal(plusMinutes('2026-11-13T23:30', 45), '2026-11-14T00:15');
});

test('a person\'s own Pulse events go to Google, with a link back to the calendar', () => {
  const items = [{ source: 'event', id: 'e1', title: 'Plan the week', start: '2026-11-16T03:00:00Z', minutes: 60, timeZone: 'Asia/Kolkata' },
    { source: 'task', id: 't1', title: 'Quote', start: '2026-11-16T05:00:00Z', minutes: 30, timeZone: 'Asia/Kolkata' }];
  const plan = syncPlan('o', 'p', items, [], 'https://app.example.invalid', { tasks: false, meetings: false });
  assert.deepEqual(plan.put.map((p) => p.item.id), ['e1']);
  const ev = eventFor(items[0], 'https://app.example.invalid');
  assert.equal(ev.source.url, 'https://app.example.invalid/calendar');
  assert.equal(ev.extendedProperties.private.pulse, 'event:e1');
});

/** A stub database: answers the reads pullGoogle makes and records every call. */
function stubDb({ token = null, pushed = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
      if (/calendar_pull_token/.test(sql)) return { rows: [{ t: token }] };
      if (/select \(select pulse\.org_time_zone\(\)\) tz/.test(sql)) return { rows: [{ tz: 'Asia/Kolkata' }] };
      if (/from pulse\.calendar_pushed$/.test(sql.trim()) || /select source,source_id::text id,event_id,pushed_at from pulse\.calendar_pushed/.test(sql)) return { rows: pushed };
      if (/insert into pulse\.calendar_event/.test(sql)) return { rows: [{ added: true }], rowCount: 1 };
      if (/delete from pulse\.calendar_event where source='google'/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}
const ours = (ev) => ev.calls.filter((c) => !/savepoint/.test(c.sql));

test('pullGoogle: changes made in Google come back; Google events are copied in; Pulse events from another company are left out', async () => {
  const pushedAt = new Date('2026-11-10T08:00:00Z');
  const db = stubDb({ pushed: [
    { source: 'task', id: '11111111-1111-4111-8111-111111111111', event_id: 'pulsetask1', pushed_at: pushedAt },
    { source: 'event', id: '22222222-2222-4222-8222-222222222222', event_id: 'pulseevent2', pushed_at: pushedAt },
    { source: 'appointment', id: '33333333-3333-4333-8333-333333333333', event_id: 'pulseappt3', pushed_at: pushedAt },
  ] });
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization });
    return new Response(JSON.stringify({ nextSyncToken: 'sync-2', items: [
      // moved in Google after Pulse wrote it: the task's due time follows
      { id: 'pulsetask1', status: 'confirmed', updated: '2026-11-11T09:00:00Z', start: { dateTime: '2026-11-17T15:30:00+05:30' }, end: { dateTime: '2026-11-17T16:00:00+05:30' } },
      // a Pulse event deleted in Google: deleted in Pulse
      { id: 'pulseevent2', status: 'cancelled' },
      // a client meeting moved in Google: Pulse keeps its booking (no write)
      { id: 'pulseappt3', status: 'confirmed', updated: '2026-11-11T09:00:00Z', start: { dateTime: '2026-11-18T10:00:00+05:30' }, end: { dateTime: '2026-11-18T10:30:00+05:30' } },
      // the person's own Google events: copied in (timed and all day)
      { id: 'g1', status: 'confirmed', summary: 'Dentist', start: { dateTime: '2026-11-14T18:30:00+05:30' }, end: { dateTime: '2026-11-14T19:15:00+05:30' }, htmlLink: 'https://calendar.google.com/x' },
      { id: 'g2', status: 'confirmed', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } },
      // an event Pulse made from another company: shown there already
      { id: 'pulseother', status: 'confirmed', summary: 'Other company task', extendedProperties: { private: { pulse: 'task:x' } }, start: { dateTime: '2026-11-14T10:00:00Z' }, end: { dateTime: '2026-11-14T10:30:00Z' } },
      // a Google event deleted: its copy goes
      { id: 'g3', status: 'cancelled' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const out = await pullGoogle(db, 'access-token', 'primary');
    assert.deepEqual(out, { read: 7, moved: 1, added: 2, removed: 2 });
  } finally { globalThis.fetch = real; }
  // First sync: a window read (no sync token), single events, deleted ones too; Google's token is kept for next time.
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, calendarGoogle.events('primary'));
  assert.equal(u.searchParams.get('singleEvents'), 'true');
  assert.equal(u.searchParams.get('showDeleted'), 'true');
  assert.ok(u.searchParams.get('timeMin'));
  assert.equal(seen[0].auth, 'Bearer access-token');
  const sql = ours(db);
  const save = sql.find((c) => /task_save/.test(c.sql));
  assert.deepEqual(save.args, ['11111111-1111-4111-8111-111111111111', JSON.stringify({ dueAt: '2026-11-17T10:00:00.000Z' })]);
  assert.ok(sql.some((c) => /delete from pulse\.calendar_event where id=\$1 and source='pulse'/.test(c.sql) && c.args[0] === '22222222-2222-4222-8222-222222222222'));
  assert.ok(!sql.some((c) => c.args.includes('33333333-3333-4333-8333-333333333333') && /update|task_save/.test(c.sql)), 'a client meeting is not moved by Google');
  const inserts = sql.filter((c) => /insert into pulse\.calendar_event/.test(c.sql));
  assert.deepEqual(inserts.map((c) => c.args[8]), ['g1', 'g2']);
  assert.equal(inserts[1].args[2], null, 'an all-day Google event has no time');
  assert.equal(inserts[1].args[3], '2026-11-20');
  assert.ok(!inserts.some((c) => c.args[8] === 'pulseother'));
  assert.ok(sql.some((c) => /delete from pulse\.calendar_event where source='google' and google_id=\$1/.test(c.sql) && c.args[0] === 'g3'));
  // The moment a change is taken is the wall clock (clock_timestamp), never the transaction's start (now()): otherwise
  // Google's own later stamp would look like a fresh change on the next sync.
  const marks = sql.filter((c) => /update pulse\.calendar_pushed set pushed_at/.test(c.sql));
  assert.ok(marks.length >= 1 && marks.every((c) => /pushed_at=clock_timestamp\(\)/.test(c.sql)));
  assert.deepEqual(sql.at(-1).args, ['sync-2']);
});

test('pullGoogle: an old sync token (410) reads the window again; a known token asks only for changes', async () => {
  const db = stubDb({ token: 'sync-old' });
  const urls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url)));
    if (urls.length === 1) return new Response(JSON.stringify({ error: { code: 410 } }), { status: 410 });
    return new Response(JSON.stringify({ items: [], nextSyncToken: 'sync-new' }), { status: 200 });
  };
  try { await pullGoogle(db, 'access-token', 'primary'); } finally { globalThis.fetch = real; }
  assert.equal(urls[0].searchParams.get('syncToken'), 'sync-old');
  assert.equal(urls[0].searchParams.get('timeMin'), null);
  assert.equal(urls[1].searchParams.get('syncToken'), null);
  assert.ok(urls[1].searchParams.get('timeMin'));
  assert.deepEqual(ours(db).at(-1).args, ['sync-new']);
});
