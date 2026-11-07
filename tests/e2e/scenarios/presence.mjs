// Office presence from a paired phone, the way the Android shell reports it (OfficeArrival.java): "entered/left office X"
// after Android's own dwell, the office Wi-Fi name and access point, and the public network the request came from.
// The server decides: "Check in?" after HR's dwell, an automatic check-in with two kinds of signal and the person's
// consent; ATT (0861): leaving is the engine's (an automatic check-out near the shift's end, a break in the day).
import { asOwner, asWorker, delay, istClock, tick } from './lib/harness.mjs';
import { summarizeNotices } from './attendance.mjs';

/** A shift around now (India time) for one person, through HR's own screens; every day a working day. By default it
 *  starts in 50 minutes: the person arrives early (inside the hour before the shift when arrival counts), and no
 *  scheduled "Ready to check in?" reminder has gone out yet. */
async function shiftAroundNow(rec, stack, hr, person, name, startIn = 50) {
  const now = new Date(Date.now() + 330 * 60e3), hh = (d) => d.toISOString().slice(11, 16);
  const start = hh(new Date(now.getTime() + startIn * 60e3)), end = hh(new Date(now.getTime() + (startIn + 540) * 60e3));
  // POLISH-2 (QA-E2E P2-15): HR gives a shift its working days (every day here, so the test runs on a Sunday too).
  await hr.post('/api/v0/shifts', { name, start, end, grace: 15, days: [1, 2, 3, 4, 5, 6, 7] }, { expect: 200 });
  const list = await hr.get('/api/v0/shifts', { expect: 200 });
  const shift = list.data.shifts.find((s) => s.name === name);
  rec.check(shift?.days?.length === 7, 'a shift saved with its working days keeps them', shift?.days);
  const from = new Date(Date.now() + 330 * 60e3 - 86400e3).toISOString().slice(0, 10);
  await hr.post('/api/v0/shifts', { personId: person.id, shiftId: shift.id, mode: 'office', from }, { expect: 200 });
  return { start, end };
}

export async function presence({ rec, P, stack, seed }) {
  rec.section('presence');
  // The test shifts start 50 minutes ahead and 20 minutes back; near India midnight they would cross the date line
  // and arrival would not count for "today". CI runs then skip this scenario (it runs at any other hour).
  const clock = istClock();
  if (clock >= '23:05' || clock < '00:25') { rec.note('how', `presence scenario skipped near India midnight (${clock})`, null); return; }
  const hr = P.neha, me = P.vikram;
  const office = seed.office, hq = seed.hq;
  const shift = await shiftAroundNow(rec, stack, hr, me, 'QA around now');
  rec.note('how', 'test shift around the current India time', { ...shift, now: istClock() });

  // Vikram set do-not-disturb from his chat status (seed): that snoozes every ping, push included. Clear it first.
  const dnd = (await me.get('/api/v0/companion/notification-settings')).data.settings;
  rec.note('how', 'a chat status with do-not-disturb snoozes every notification ping (push and the phone check) until it ends', { snoozedUntil: dnd.snoozedUntil });
  await me.post('/api/v0/presence', { text: null, emoji: null, until: null, dndUntil: null }, { expect: 200 });
  const phone = await me.pair('android', 'Pixel 7 (QA)');
  if (!phone) return;
  await me.dpost(`/api/v0/devices/${phone.deviceId}/push`, { token: 'qa-fcm-vikram-' + 'x'.repeat(40) }, { expect: 200 });
  const cfg0 = await me.dget('/api/v0/companion/presence', { expect: 200 });
  rec.check(cfg0.data.enabled === false && cfg0.data.offices.length === 1, 'before any agreement the phone is told presence is off (offices are listed)', cfg0.data);
  // The phone never sends anything without consent: a report without the choice is refused.
  await me.dpost('/api/v0/companion/presence', { officeId: office, region: 'enter' }, { expect: 400 });
  // The person agrees in onboarding (arrival questions, not automatic).
  await me.post('/api/v0/onboarding/consent', { given: true, auto: false }, { expect: 200 });
  const cfg1 = await me.dget('/api/v0/companion/presence', { expect: 200 });
  rec.check(cfg1.data.enabled === true && cfg1.data.auto === false && cfg1.data.dwellMinutes === 1, "after onboarding agreement the phone follows it (enabled, not automatic, HR's dwell)", cfg1.data);

  // Approach and dwell: Android reports "enter" only after its own loitering delay (the same dwell minutes). POLISH-2
  // (QA-E2E P1-1): that wait counts; the server does not start the dwell again, so "Check in?" goes out at once.
  const sent = Date.now();
  const enter = await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region: 'enter', dwelled: true }, { expect: 200 });
  // ATT (0861): the geofence weighs 50; the question comes from the engine's tick right after the report (checked below).
  rec.check(enter.data.score === 50, 'an Android arrival (sent after Android\'s own dwell) scores the geofence (50)', enter.data);
  rec.note('how', 'answer to a geofence "enter"', enter.data);
  const asked = await asWorker(stack, (c) => c.query("select id,created_at,title,href,expires_at from pulse.notification where person_id=$1 and event_type='attendance.arrival'", [me.id]));
  const askedAt = asked.rows[0] ? Date.parse(asked.rows[0].created_at) : null;
  rec.check(!!askedAt, '"Check in?" is asked once the person has stayed for the dwell', asked.rows[0]);
  if (askedAt) {
    rec.timing('phone "enter" (after Android\'s dwell) → "Check in?"', askedAt - sent);
    await tick(stack, rec, 'drain');
    const push = await asWorker(stack, (c) => c.query('select channel,status from pulse.notification_delivery where notification_id=$1', [asked.rows[0].id]));
    rec.check(push.rows.some((d) => d.channel === 'native' && d.status === 'accepted'), '"Check in?" is pushed to the phone', push.rows);
    if (!push.rows.some((d) => d.status === 'accepted')) {
      const why = await asOwner(stack, (c) => c.query(`select d.channel,d.status,d.attempts,d.retry_at>now() later,
        (select count(*)::int from pulse.native_push_delivery x where x.notification_id=d.notification_id) local_rows,
        pulse.notification_ping_allowed(n.person_id,n.kind,d.channel) ping,n.kind,n.expires_at>now() live
        from pulse.notification_delivery d join pulse.notification n on n.id=d.notification_id where d.notification_id=$1`, [asked.rows[0].id]));
      rec.note('how', '"Check in?" delivery that was not accepted', why.rows);
    }
  }
  const day = await me.get('/api/v0/companion', { expect: 200 });
  rec.check(day.data.arrival?.office === 'Synthetic HQ', 'every surface offers the same "Check in?" (day answer has arrival)', day.data.arrival);
  // The phone's background check (InboxWorker) sees the question with a one-tap answer.
  const upd = await me.dget(`/api/v0/companion/updates?since=${new Date(sent - 60e3).toISOString()}`, { expect: 200 });
  const row = upd.data.rows?.find((r) => r.eventType === 'attendance.arrival');
  rec.check(row && row.pingAllowed, 'the phone background check receives "Check in?" with a ping allowed', row);
  if (row && !row.pingAllowed) {
    const local = await asOwner(stack, (c) => c.query('select device_id,sent_at,app_received_at from pulse.native_push_delivery where notification_id=$1', [row.id]));
    rec.note('how', '"Check in?" local delivery rows for the phone (pingAllowed needs one pending for this device)', local.rows);
  }
  const open = row && await me.dget(`/api/v0/native/notifications/${row.id}/open`);
  if (open) rec.note(open.status === 200 ? 'how' : 'P2', `opening the arrival notification through the native contract (GET native/notifications/:id/open) answers ${open.status}`, open.data);
  // An iPhone reports a region on entry (no dwell of its own): there the server's dwell still runs. Someone with nothing
  // recorded today (the seed checks some people in) and not on leave.
  const busy = new Set((await asWorker(stack, (c) => c.query(`select person_id::text id from pulse.attendance_entry where work_date=(now() at time zone 'Asia/Kolkata')::date
    union select person_id::text from pulse.leave_request where status='approved' and (now() at time zone 'Asia/Kolkata')::date between from_date and to_date`))).rows.map((r) => r.id));
  // Zoya (her laptop checks her in automatically later; an arrival question does not stand in its way).
  const ios = ['zoya', 'rila', 'meera', 'ahoro', 'kabir'].map((k) => P[k]).find((p) => p && !busy.has(p.id));
  if (!ios) rec.note('how', 'no persona free today for the iPhone arrival check', null);
  else {
    await shiftAroundNow(rec, stack, hr, ios, 'QA around now (iPhone)');
    await ios.post('/api/v0/onboarding/consent', { given: true, auto: false }, { expect: 200 });
    await ios.pair('ios', `${ios.name} iPhone (QA)`);
    const at = await ios.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region: 'enter' }, { expect: 200 });
    rec.check(at.data.asked === false, 'an iPhone arrival waits for the server\'s dwell (iOS reports on entry)', at.data);
    // ATT (0861): the engine remembers since when someone has been at the office (attendance_presence_state).
    await tick(stack, rec);
    await asOwner(stack, (c) => c.query("update pulse.attendance_presence_state set holding_since=now()-interval '61 seconds' where person_id=$1", [ios.id]));
    await tick(stack, rec);
    const iosAsked = await asWorker(stack, (c) => c.query("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.arrival'", [ios.id]));
    rec.check(iosAsked.rows[0].n === 1, 'after the dwell the iPhone is asked "Check in?"', iosAsked.rows[0]);
  }
  // A second arrival the same day does not ask again.
  await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region: 'exit' }, { expect: 200 });
  await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region: 'enter' }, { expect: 200 });
  await tick(stack, rec);
  await asOwner(stack, (c) => c.query("update pulse.attendance_presence_state set holding_since=now()-interval '5 minutes' where person_id=$1", [me.id]));
  await tick(stack, rec);
  const twice = await asWorker(stack, (c) => c.query("select count(*)::int n from pulse.notification where person_id=$1 and event_type='attendance.arrival'", [me.id]));
  rec.check(twice.rows[0].n === 1, '"Check in?" is asked once a day', twice.rows[0]);

  // The person taps Check in on the notification (AttendanceAction → POST attendance/check-in with the device token).
  const tap = await me.dpost('/api/v0/attendance/check-in', { via: 'mobile', trigger: 'notification', expectedPersonId: me.id, queueId: `n-check-in-${row?.id ?? 'x'}`.slice(0, 64) });
  rec.check(tap.status === 200, 'tapping "Check in" on the phone notification checks in with the device credential', tap.data);
  const inside = await me.get('/api/v0/companion');
  rec.check(inside.data.state === 'in' && !inside.data.arrival, 'after checking in the question disappears from every surface', { state: inside.data.state, arrival: inside.data.arrival });

  // GPS jitter at the edge: exit/enter/exit within a minute must not flood reminders.
  rec.section('presence: departure');
  const left = Date.now();
  for (const region of ['exit', 'enter', 'exit']) { await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region }, { expect: 200 }); await tick(stack, rec); }
  // ATT (0861): leaving is decided by the engine (no office signal for the leave time); near the end of the shift it
  // checks out by itself at the last confident moment, so neither "Leaving for the day?" nor a correction goes out.
  const leaving = await asWorker(stack, (c) => c.query("select title,event_type,created_at from pulse.notification where person_id=$1 and (title like 'Leaving%' or event_type='attendance.departure')", [me.id]));
  rec.check(leaving.rows.length === 0, 'jitter at the fence edge sends no "Leaving for the day?" reminder', leaving.rows);
  void left;
  // Away in the middle of the day (the shift has hours to go): never a silent check-out, no correction, no question
  // before the break limit; coming back makes the time away a break.
  await asOwner(stack, (c) => c.query("update pulse.attendance_presence_state set last_confident_at=now()-interval '20 minutes' where person_id=$1", [me.id]));
  await tick(stack, rec);
  const proposed = await asWorker(stack, (c) => c.query("select kind,status from pulse.attendance_regularisation where person_id=$1 and kind='missed_punch'", [me.id]));
  const still = await me.get('/api/v0/companion');
  rec.check(still.data.state === 'in' && proposed.rows.length === 0, 'away in the middle of the day the session stays open and no correction is proposed', { state: still.data.state, corrections: proposed.rows });
  const meNotices = await me.get('/api/v0/notices');
  rec.note('how', "the person's notification panel after leaving the office", summarizeNotices(meNotices.data));
  await me.post('/api/v0/attendance/check-out', {}, { expect: 200 });

  // ------------------------------------------------------------------------ Wi-Fi and network signals (no geofence)
  rec.section('presence: Wi-Fi and network');
  const wifiOnly = await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, wifi: { ssid: hq.ssid } });
  rec.check(wifiOnly.data.score === 30, 'the office Wi-Fi name alone scores 30 (not enough to count as present)', wifiOnly.data);
  const bssid = await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, wifi: { ssid: hq.ssid, bssid: hq.bssid } });
  rec.check(bssid.data.score === 70, 'the Wi-Fi name with a known access point scores 70 (enough alone)', bssid.data);
  const wrong = await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, wifi: { ssid: 'Cafe-Guest' } });
  rec.check(wrong.data.score === 0, 'another network scores 0', wrong.data);
  me.ip = '203.0.113.25';
  const viaIp = await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false });
  rec.check(viaIp.data.score === 40 && viaIp.data.officeId === office, 'a request from the office public network finds the office by itself (40)', viaIp.data);
  me.ip = undefined;
  rec.note('how', 'signal scores (ATT, 0861): office access point 70, geofence 50, office public IP 40, Wi-Fi name alone 30; laptop in use 15 and phone app open 10 only add; at the office at 60 or more (HR can change it); capped at 100', null);

  // ---------------------------------------------------- automatic check-in: HR allows it, the person agrees, two signals
  rec.section('presence: automatic check-in');
  const auto = P.neha;   // HR herself, no entry today
  await shiftAroundNow(rec, stack, hr, auto, 'QA around now (HR)');
  const before = await hr.get('/api/v0/hr/presence', { expect: 200 });
  await hr.post('/api/v0/hr/presence', { offices: before.data.offices.map((o) => ({ ...o, wifi: o.wifi, publicIpRanges: o.publicIpRanges })), autoCheckIn: true, dwellMinutes: 1, leaveMinutes: 5 }, { expect: 200 });
  await auto.post('/api/v0/onboarding/consent', { given: true, auto: true }, { expect: 200 });
  await auto.pair('ios', 'iPhone (QA)');
  const gps = await auto.dpost('/api/v0/companion/presence', { consent: true, autoConsent: true, officeId: office, region: 'enter', wifi: { ssid: hq.ssid, bssid: hq.bssid } }, { expect: 200 });
  rec.check(gps.data.score === 100 && gps.data.checkedIn === false, 'geofence + office access point = 100 (capped), automatic only after the dwell', gps.data);
  const autoStart = Date.now(); let autoAt = null;
  for (let i = 0; i < 20 && !autoAt; i++) {
    await delay(5000);
    // The phone keeps reporting while there (a Wi-Fi signal lasts 10 minutes); the minute tick decides.
    if (i % 4 === 3) await auto.dpost('/api/v0/companion/presence', { consent: true, autoConsent: true, officeId: office, wifi: { ssid: hq.ssid, bssid: hq.bssid } });
    await tick(stack, rec);
    const e = await asWorker(stack, (c) => c.query('select checked_in_at,client from pulse.attendance_entry where person_id=$1 and checked_out_at is null', [auto.id]));
    if (e.rows[0]) { autoAt = Date.parse(e.rows[0].checked_in_at); rec.note('how', 'automatic check-in entry', e.rows[0].client); }
  }
  rec.check(!!autoAt, 'with HR allowing it and the person agreeing, two signals through the dwell check in automatically', null);
  if (autoAt) rec.timing('arrival (geofence+Wi-Fi) → automatic check-in (dwell 1 min)', autoAt - autoStart);
  const autoNote = await asWorker(stack, (c) => c.query("select title,event_type from pulse.notification where person_id=$1 and event_type='attendance.auto'", [auto.id]));
  rec.check(autoNote.rows.length === 1 && autoNote.rows[0].title.startsWith('Checked in at '), 'the person is told they were checked in (attendance.auto: "Checked in at HH:MM · office")', autoNote.rows);
  const autoAgain = await auto.post('/api/v0/attendance/check-in', { mode: 'office' });
  rec.check(autoAgain.status === 409, 'a manual check-in after the automatic one says already checked in', autoAgain.data);
  await auto.post('/api/v0/attendance/check-out', {}, { expect: 200 });

  // -------------------------------------------- a laptop at the office: automatic check-in from network + Wi-Fi
  rec.section('presence: laptop');
  const zoya = P.zoya;
  if (zoya) {
    await shiftAroundNow(rec, stack, hr, zoya, 'QA around now (laptop)');
    await zoya.post('/api/v0/onboarding/consent', { given: true, auto: true }, { expect: 200 });
    await zoya.pair('windows', 'Zoya laptop'); zoya.ip = '203.0.113.40';
    const lap = await zoya.dpost('/api/v0/companion/presence', { consent: true, autoConsent: true, wifi: { ssid: hq.ssid, bssid: hq.bssid } }, { expect: 200 });
    rec.check(lap.data.score === 100, 'a laptop on the office network and access point scores 100 (40 + 70, capped)', lap.data);
    let lapAt = null;
    for (let i = 0; i < 20 && !lapAt; i++) {
      await delay(5000); if (i % 4 === 3) await zoya.dpost('/api/v0/companion/presence', { consent: true, autoConsent: true, wifi: { ssid: hq.ssid, bssid: hq.bssid } });
      await tick(stack, rec);
      lapAt = (await asWorker(stack, (c) => c.query('select checked_in_at from pulse.attendance_entry where person_id=$1 and checked_out_at is null', [zoya.id]))).rows[0]?.checked_in_at ?? null;
    }
    rec.check(!!lapAt, 'a laptop at the office checks in automatically too', null);
    const lapNote = await asWorker(stack, (c) => c.query("select title,event_type from pulse.notification where person_id=$1 and event_type in ('attendance.auto','attendance.confirmed','update.self') order by created_at desc", [zoya.id]));
    rec.note(lapNote.rows[0]?.event_type === 'update.self' ? 'P2' : 'how', `the laptop's automatic check-in notice is "${lapNote.rows[0]?.title}" with event type ${lapNote.rows[0]?.event_type}${lapNote.rows[0]?.event_type === 'update.self' ? ': the outbox classifier (notification_contract) matches only the phone wording, so this notice is never pushed and does not count as an attendance notice' : ''}`, lapNote.rows);
    zoya.ip = undefined;
  }
  // A scheduled "Ready to check in?" went out minutes before arriving: the arrival question waits (shared budget).
  rec.section('presence: arrival right after a reminder');
  const late = P.rifob;
  if (late) {
    await shiftAroundNow(rec, stack, hr, late, 'QA started 20 min ago', -20);
    await late.post('/api/v0/onboarding/consent', { given: true, auto: false }, { expect: 200 });
    await late.pair('android', 'Rifob phone');
    await tick(stack, rec);   // the scheduled reminder for a shift that started 20 minutes ago
    await late.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region: 'enter' }, { expect: 200 });
    await tick(stack, rec);
    await asOwner(stack, (c) => c.query("update pulse.attendance_presence_state set holding_since=now()-interval '3 minutes' where person_id=$1", [late.id]));
    await tick(stack, rec);
    const got = await asWorker(stack, (c) => c.query("select event_type,title from pulse.notification where person_id=$1 and event_type in ('attendance.start','attendance.arrival') order by created_at", [late.id]));
    const ev = await asWorker(stack, (c) => c.query('select kind from pulse.attendance_event where person_id=$1 order by at', [late.id]));
    const arrival = got.rows.some((r) => r.event_type === 'attendance.arrival');
    // POLISH-2 (QA-E2E P1-7): arriving is when the question helps; a scheduled reminder minutes before no longer holds it.
    rec.check(arrival, 'arriving minutes after a scheduled "Ready to check in?" still asks "You’re at <office>. Check in?"', { notifications: got.rows.map((r) => r.title), events: ev.rows.map((r) => r.kind) });
  }

  // ------------------------------------------------------------------------------------ consent withdrawn on the web
  rec.section('presence: consent withdrawn');
  const off = await me.dpost('/api/v0/companion/presence', { consent: false, autoConsent: false }, { expect: 200 });
  rec.check(off.data.enabled === false, 'withdrawing consent switches presence off for this phone', off.data);
  const cfg2 = await me.dget('/api/v0/companion/presence');
  rec.check(cfg2.data.enabled === false, "the phone's next sync sees presence off (a device's own off wins over onboarding)", cfg2.data);
  // A revoked phone can no longer report anything.
  await me.post(`/api/v0/devices/${me.device.deviceId}/revoke`, {}, { expect: 200 });
  await me.dpost('/api/v0/companion/presence', { consent: true, autoConsent: false, officeId: office, region: 'enter' }, { expect: 401 });
}
