// Attendance as a person lives it: check-in, breaks, check-out, back again the same day, a session left open across
// midnight, offline actions sent later, a weekly off, leave and corrections with their approvers.
import { addDays, asWorker, istClock, istDate, randomUUID, tick } from './lib/harness.mjs';

export async function attendance({ rec, P, stack }) {
  rec.section('attendance');
  const me = P.ishaan, head = P.vikram, hr = P.neha;
  const day0 = await me.get('/api/v0/companion', { expect: 200 });
  rec.check(day0.data.attendanceEnabled === true && day0.data.state === 'out', 'a person who has not started is "out"', { state: day0.data.state, shift: day0.data.shift });
  rec.note('how', 'the day answer (GET /companion) carries shift, state, streak, week, presence offices and links', { keys: Object.keys(day0.data), shift: day0.data.shift, today: day0.data.today, clock: day0.data.clock });

  const t0 = performance.now();
  const inn = await me.post('/api/v0/attendance/check-in', { mode: 'office', via: 'web' }, { expect: 200 });
  rec.timing('check-in round trip', performance.now() - t0);
  const lateExpected = day0.data.clock > day0.data.shift.onTimeBy;
  rec.check((inn.data.late > 0) === lateExpected, `late is marked only after ${day0.data.shift.onTimeBy} (now ${day0.data.clock})`, inn.data);
  await me.post('/api/v0/attendance/check-in', { mode: 'office' }, { expect: 409 });
  const s1 = await me.get('/api/v0/companion');
  rec.check(s1.data.state === 'in' && s1.data.entry?.in, 'after check-in the state is "in" with the time', s1.data.entry);

  await me.post('/api/v0/attendance/break', {}, { expect: 200 });
  await me.post('/api/v0/attendance/break', {}, { expect: 409 });
  rec.check((await me.get('/api/v0/companion')).data.state === 'break', 'on a break the state is "break"');
  await me.post('/api/v0/attendance/break', { action: 'end' }, { expect: 200 });
  await me.post('/api/v0/attendance/break', { action: 'end' }, { expect: 409 });
  await me.post('/api/v0/attendance/check-out', {}, { expect: 200 });
  const done = await me.get('/api/v0/companion');
  rec.check(done.data.state === 'done', 'after check-out the day is "done"', done.data.state);
  // Checking in again on the same day reopens the day: the time away becomes a break.
  const again = await me.post('/api/v0/attendance/check-in', { mode: 'office' }, { expect: 200 });
  rec.check(again.data.resumed === true, 'a second check-in the same day resumes the day (the gap is a break)', again.data);
  rec.note('how', 'checking in again after checking out reopens the same entry; the time away is recorded as a break, not a second session', again.data);
  await me.post('/api/v0/attendance/check-out', {}, { expect: 200 });
  const wallet = await me.get('/api/v0/companion/wallet', { expect: 200 });
  rec.note('how', 'time wallet after a day with a break', { day: wallet.data.day, month: wallet.data.wallet?.month });

  // ------------------------------------------------------------------ offline: actions saved on a phone, sent later
  const q = randomUUID();
  const offline = P.dev;   // Dev has an open entry from the seed (wfh, 3 h ago)
  const tooOld = await offline.post('/api/v0/attendance/check-out', { at: new Date(Date.now() - 4 * 3600e3).toISOString(), queueId: randomUUID() });
  rec.check(tooOld.status === 409, 'an offline action older than 3 hours is refused with "ask for a correction"', tooOld.data);
  const queued = await offline.post('/api/v0/attendance/check-out', { at: new Date(Date.now() - 20 * 60e3).toISOString(), queueId: q, via: 'mobile' }, { expect: 200 });
  const replay = await offline.post('/api/v0/attendance/check-out', { at: new Date(Date.now() - 20 * 60e3).toISOString(), queueId: q, via: 'mobile' }, { expect: 200 });
  rec.check(replay.data.replayed === true && replay.data.id === queued.data.id, 'the same queued action sent twice is applied once', replay.data);
  const future = await offline.post('/api/v0/attendance/check-in', { at: new Date(Date.now() + 10 * 60e3).toISOString(), queueId: randomUUID() });
  rec.check(future.status === 400, 'a time in the future (wrong phone clock) is refused', future.data);

  // ------------------------------------------------------- a session left open across midnight (forgotten check-out)
  // Sana checked in "3 hours ago" (seed). Move that session to yesterday 18:10 IST, as if she forgot to check out.
  const sana = P.sana; const today = istDate(); const yesterday = addDays(today, -1);
  await asWorker(stack, (c) => c.query(`update pulse.attendance_entry set work_date=$2::date,checked_in_at=(($2::date+time '18:10') at time zone 'Asia/Kolkata') where person_id=$1 and checked_out_at is null`, [sana.id, yesterday]));
  const open = await sana.get('/api/v0/companion', { expect: 200 });
  rec.note('how', 'a session left open from yesterday: the day answer', { state: open.data.state, entry: open.data.entry && { date: open.data.entry.date, in: open.data.entry.in, missedOut: open.data.entry.missedOut, correctionPending: open.data.entry.correctionPending } });
  rec.check(open.data.entry?.date === yesterday && open.data.state === 'in', "yesterday's open session is still the current one (state in, dated yesterday)", open.data.entry);
  // She arrives today and checks in: the forgotten session gets a proposed close; today's starts fresh.
  const fresh = await sana.post('/api/v0/attendance/check-in', { mode: 'office' }, { expect: 200 });
  const after = await asWorker(stack, (c) => c.query(`select e.work_date::text d,e.checked_in_at,e.checked_out_at,p.proposed_end,p.reason from pulse.attendance_entry e left join pulse.attendance_provisional_close p on p.entry_id=e.id where e.person_id=$1 order by e.checked_in_at`, [sana.id]));
  rec.note('how', 'checking in the next day with a forgotten session open: the old one gets a provisional close at shift end (needs review), a new entry starts', { response: fresh.data, rows: after.rows.map((r) => ({ d: r.d, out: r.checked_out_at, provisional: r.proposed_end ?? null })) });
  rec.check(after.rows.length >= 2 && after.rows.at(-1).d === today, 'a new entry is started for today', after.rows.map((r) => r.d));
  const sanaDay = await sana.get('/api/v0/companion');
  rec.check(sanaDay.data.state === 'in' && sanaDay.data.entry?.date === today, 'after that the day answer shows today, not the forgotten session', sanaDay.data.entry);
  // HR's attendance view for yesterday: what does the forgotten day look like?
  const hrDay = await hr.get(`/api/v0/hr/attendance?from=${yesterday}&to=${today}`, { expect: 200 });
  const sanaRows = JSON.stringify(hrDay.data).includes(sana.id);
  rec.note('how', "HR's attendance view lists the forgotten day", { listed: sanaRows, keys: Object.keys(hrDay.data ?? {}) });

  // ------------------------------- a forgotten check-out (ATT, 0861: closed at the shift's end, the person corrects it)
  const openNow = new Set((await asWorker(stack, (c) => c.query('select person_id::text id from pulse.attendance_entry where checked_out_at is null and voided_at is null and not reconciled_open'))).rows.map((r) => r.id));
  // Zoya has nothing recorded (the seed checks most people in today); she works from a laptop in the presence scenario.
  const forgot = ['zoya', 'kabir', 'ahoro', 'meera', 'rila'].map((k) => P[k]).find((p) => p && !openNow.has(p.id));
  if (forgot) {
    const ist = (day, clock) => new Date(Date.parse(`${day}T${clock}:00+05:30`)).toISOString();
    const entry = (await asWorker(stack, (c) => c.query(`insert into pulse.attendance_entry(org_id,person_id,work_date,mode,checked_in_at,late_minutes)
      values(pulse.current_org(),$1,$2::date,'office',$3,0) returning id`, [forgot.id, yesterday, ist(yesterday, '10:02')]))).rows[0].id;
    // ATT (0861): the engine decides at fixed instants here, so the case reads the same at any hour. A session with no
    // office signal at all is checked out at the shift's end once the grace time has passed (19:00 + 60 min), with low
    // confidence: the person is told the time and can correct it, and HR sees an exception. The old "Still checked in?"
    // in the evening and the next-morning provisional close no longer happen for it.
    await asWorker(stack, (c) => c.query('select pulse.attendance_forgotten_tick($1)', [ist(yesterday, '19:30')]));
    const early = await asWorker(stack, (c) => c.query('select checked_out_at from pulse.attendance_entry where id=$1', [entry]));
    rec.check(early.rows[0]?.checked_out_at === null, 'inside the grace time after the shift the session stays open', early.rows);
    await asWorker(stack, (c) => c.query('select pulse.attendance_forgotten_tick($1)', [ist(yesterday, '21:15')]));
    const closed = await asWorker(stack, (c) => c.query("select checked_out_at,out_client->>'reason' reason,(out_client->>'confidence')::int confidence from pulse.attendance_entry where id=$1", [entry]));
    rec.check(closed.rows[0]?.checked_out_at?.toISOString() === ist(yesterday, '19:00') && closed.rows[0].reason === 'shift_end' && closed.rows[0].confidence < 60,
      'after the grace time Pulse checks the session out at the end of the shift, with low confidence', closed.rows);
    const told = await asWorker(stack, (c) => c.query("select title,href from pulse.notification where person_id=$1 and event_type='attendance.auto' and event_key=$2", [forgot.id, 'out:' + entry]));
    rec.check(told.rows.length === 1 && /^Checked out at 19:00, at the end of your shift\. Left at another time\? Tell us\./.test(told.rows[0].title) && told.rows[0].href === `/me?checkout=${entry}`,
      'the person is told the time Pulse noted (shift end) and where to correct it', told.rows);
    const exc = await asWorker(stack, (c) => c.query("select kind from pulse.attendance_exception where entry_id=$1 and resolved_at is null", [entry]));
    rec.check(exc.rows.some((r) => r.kind === 'missing_checkout'), 'HR sees the low-confidence check-out as an exception', exc.rows);
    await asWorker(stack, (c) => c.query('select pulse.attendance_forgotten_tick($1)', [ist(today, '07:05')]));
    const fday = await forgot.get('/api/v0/companion', { expect: 200 });
    rec.check(fday.data.state !== 'in' && !fday.data.unresolved, 'the next morning nothing is left open: today starts fresh', { state: fday.data.state, unresolved: fday.data.unresolved });
    await forgot.post('/api/v0/hr/regularisations', { kind: 'missed_punch', date: yesterday, entryId: entry, outTime: '18:40', reason: 'Forgot to check out; I left at 18:40 (synthetic).' }, { expect: 200 });
    const pending = await asWorker(stack, (c) => c.query("select status from pulse.attendance_regularisation where person_id=$1 and work_date=$2::date and kind='missed_punch'", [forgot.id, yesterday]));
    const kept = await asWorker(stack, (c) => c.query('select checked_out_at from pulse.attendance_entry where id=$1', [entry]));
    rec.check(pending.rows.some((r) => r.status === 'pending') && kept.rows[0]?.checked_out_at?.toISOString() === ist(yesterday, '19:00'),
      'the time the person sends waits for the pod head or HR; nothing changes without them', { requests: pending.rows, out: kept.rows[0]?.checked_out_at });
  } else rec.note('how', 'no persona without an open session for the forgotten check-out case', null);

  // -------------------------------------------------------------------------------------------- the weekly off
  await asWorker(stack, (c) => c.query(`update pulse.hr_policy set work_days=array_remove('{1,2,3,4,5,6,7}'::int[],extract(isodow from now() at time zone 'Asia/Kolkata')::int)`));
  const off = await head.post('/api/v0/attendance/check-in', { mode: 'office' });
  rec.check(off.status === 403, 'on a weekly off a check-in is refused with "request work on this day"', off.data);
  const offDay = await head.get('/api/v0/companion');
  rec.check(offDay.data.state === 'off', 'and the day answer says "off"', offDay.data.state);
  await asWorker(stack, (c) => c.query(`update pulse.hr_policy set work_days='{1,2,3,4,5,6,7}'`));

  // ------------------------------------------------------------------------------------------- on approved leave
  const tara = P.tara;   // approved casual leave today (seed)
  const leaveDay = await tara.get('/api/v0/companion');
  rec.check(leaveDay.data.state === 'leave', 'on approved leave the day answer says "leave"', leaveDay.data.state);
  const leaveIn = await tara.post('/api/v0/attendance/check-in', { mode: 'office' });
  rec.note(leaveIn.status === 200 ? 'P2' : 'how', `checking in on a day of approved full-day leave is ${leaveIn.status === 200 ? 'accepted silently (no warning, leave stays approved)' : 'refused'}`, { status: leaveIn.status, data: leaveIn.data });
  if (leaveIn.status === 200) {
    const after = await tara.get('/api/v0/companion');
    rec.note('how', 'after checking in on a leave day', { state: after.data.state });
    await tara.post('/api/v0/attendance/check-out', {});
  }

  // ------------------------------------------------------------------------------------------------------- leave
  rec.section('leave');
  const types = await me.get('/api/v0/hr/self', { expect: 200 });
  let kinds = (types.data.leave?.types ?? []).map((t) => t.key);
  if (!kinds.length) {
    // A new company starts with no leave types: nobody can apply until HR adds one (Settings → Leave types).
    rec.note('how', 'a company with no leave types: the leave form has nothing to choose; HR adds a type first', null);
    await hr.post('/api/v0/hr/leave-types', { name: 'Casual leave', annualDays: 12, accrual: 'yearly' }, { expect: 200 });
    kinds = ((await me.get('/api/v0/hr/self')).data.leave?.types ?? []).map((t) => t.key);
  }
  const kind = kinds.includes('casual') ? 'casual' : kinds[0];
  rec.note('how', 'leave types offered to a person', kinds.slice(0, 10));
  const from = addDays(today, 8), to = addDays(today, 9);
  const notice = await me.get(`/api/v0/leave/notice?from=${from}&to=${to}&kind=${kind}`);
  rec.note('how', 'notice rule check before applying', { status: notice.status, data: notice.data });
  const applied = await me.post('/api/v0/leave', { fromDate: from, toDate: to, kind, reason: 'Family function (synthetic)' }, { expect: 200 });
  rec.check(applied.data?.status === 'pending' && applied.data.days === 2, `two working days of ${kind} leave wait for a decision`, applied.data);
  await me.post('/api/v0/leave', { fromDate: from, toDate: from, kind, reason: 'overlap' }, { expect: 409 });
  // Who sees it: the pod head (Vikram, Pod 2) and HR.
  await tick(stack, rec);
  const headDay = await head.get('/api/v0/companion');
  rec.note('how', "the pod head's day answer after the request (waiting count)", headDay.data.waiting);
  const headNotices = await head.get('/api/v0/notices', { expect: 200 });
  const headCard = (headNotices.data.rows ?? []).find((x) => /leave/i.test(x.title ?? ''));
  rec.check(!!headCard, 'the pod head sees the leave request in the notification panel', summarizeNotices(headNotices.data));
  rec.note('how', "the pod head's leave card", headCard && { title: headCard.title, body: headCard.body, group: headCard.group, actions: headCard.actions?.map((a) => a.label) });
  // POLISH-2 (QA-E2E P1-9): a card without buttons says who decides and why.
  if (headCard && !headCard.actions?.length) rec.check(/decides this one/.test(headCard.body ?? ''), "the pod head's card says HR (or a co-founder) decides, and why", headCard.body);
  await me.post(`/api/v0/leave/${applied.data.id}/decision`, { decision: 'approved' }, { expect: [403, 409] });
  const byHead = await head.post(`/api/v0/leave/${applied.data.id}/decision`, { decision: 'approved' });
  rec.note('how', `the pod head approving directly: ${byHead.status}`, byHead.data);
  // HR decides from its own panel card, with the card's own action (as the bell panel does).
  const hrNotices = await hr.get('/api/v0/notices', { expect: 200 });
  const hrCard = (hrNotices.data.rows ?? []).find((x) => /leave/i.test(x.title ?? '') && x.actions?.length);
  rec.check(!!hrCard, "HR's panel has the leave request with actions", summarizeNotices(hrNotices.data));
  const approve = hrCard?.actions.find((a) => /approve/i.test(a.label));
  if (approve) {
    const r = await hr.call(approve.method ?? 'POST', approve.path, approve.body ?? {});
    rec.check(r.status === 200, `HR presses "${approve.label}" on the card`, r.data);
  } else if (byHead.status !== 200) {
    await hr.post(`/api/v0/hr/flows/${applied.data.flowId}/decision`, { action: 'approved' }, { expect: 200 });
  }
  await tick(stack, rec);
  const mine = await me.get('/api/v0/leave', { expect: 200 });
  const row = mine.data.requests?.find((r) => r.id === applied.data.id);
  rec.check(row?.status === 'approved', 'the leave is approved', row && { status: row.status, decidedBy: row.decidedBy });
  const meNotices = await me.get('/api/v0/notices', { expect: 200 });
  rec.check((meNotices.data.rows ?? []).some((x) => /leave|request approved/i.test(x.title ?? '')), 'the person is told about the decision in the notification panel', summarizeNotices(meNotices.data));
  // Cancel leave that has not started.
  if (row?.status === 'approved' || row?.status === 'pending') {
    const cancel = await me.post(`/api/v0/leave/${applied.data.id}/decision`, { decision: 'cancelled' });
    rec.check(cancel.status === 200, 'leave that has not started can be cancelled by the person', cancel.data);
  }

  // ------------------------------------------------------------------------------------------------- corrections
  rec.section('corrections');
  const fix = await me.post('/api/v0/hr/regularisations', { kind: 'missed_punch', date: yesterday, inTime: '10:05', outTime: '19:10', reason: 'Phone battery died (synthetic)' }, { expect: 200 });
  rec.check(fix.data?.status === 'pending', 'a correction for yesterday waits for a decision', fix.data);
  await me.post('/api/v0/hr/regularisations', { kind: 'missed_punch', date: yesterday, inTime: '10:05', outTime: '19:10', reason: 'twice' }, { expect: 409 });
  await me.post(`/api/v0/hr/regularisations/${fix.data.id}`, { decision: 'approved' }, { expect: 403 });
  await head.post(`/api/v0/hr/regularisations/${fix.data.id}`, { decision: 'rejected' }, { expect: 400 });
  // HR deciding before the pod head is an override and needs a reason; the head's own approval does not.
  const hrFirst = await hr.post(`/api/v0/hr/regularisations/${fix.data.id}`, { decision: 'approved' });
  rec.note('how', `HR approving a correction before the pod head: ${hrFirst.status}`, hrFirst.data);
  const ok = hrFirst.status === 200 ? hrFirst : await head.post(`/api/v0/hr/regularisations/${fix.data.id}`, { decision: 'approved' });
  rec.check(ok.status === 200, 'the pod head approves the correction', ok.data);
  const entry = await asWorker(stack, (c) => c.query(`select work_date::text d,to_char(checked_in_at at time zone 'Asia/Kolkata','HH24:MI') i,to_char(checked_out_at at time zone 'Asia/Kolkata','HH24:MI') o,source from pulse.attendance_entry where person_id=$1 and work_date=$2`, [me.id, yesterday]));
  rec.check(entry.rows[0]?.i === '10:05' && entry.rows[0]?.o === '19:10', 'an approved correction writes the day with the asked times', { ok: ok.data, rows: entry.rows });
  await tick(stack, rec);
  const told = await me.get('/api/v0/notices');
  rec.note('how', 'after HR approves a correction, the person sees', summarizeNotices(told.data));
  // A future missed punch is refused; a day two months back is refused.
  await me.post('/api/v0/hr/regularisations', { kind: 'missed_punch', date: addDays(today, 1), inTime: '10:00', outTime: '19:00', reason: 'Not yet happened' }, { expect: 400 });
  await me.post('/api/v0/hr/regularisations', { kind: 'missed_punch', date: addDays(today, -70), inTime: '10:00', outTime: '19:00', reason: 'Too long ago' }, { expect: 400 });
  rec.note('how', 'clock and day used by the server for this run', { today, clock: istClock() });
}

export function summarizeNotices(d) {
  if (!d || typeof d !== 'object') return d;
  return { counts: d.counts, cards: (d.rows ?? []).map((x) => `${x.group}: ${x.title}${x.actions?.length ? ` [${x.actions.map((a) => a.label).join('|')}]` : ''}`).slice(0, 12) };
}
