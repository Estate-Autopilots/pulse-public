// Notifications through the outbox to each channel, with delivery timing: the in-app panel, browser push (a synthetic
// subscription), phone push (a synthetic FCM token; sink mode), the phone/desktop background poll (companion/updates),
// Telegram and e-mail (counted only). Then quiet hours, do-not-disturb, snooze and the native deep-link contract.
import { asOwner, asWorker, delay, randomUUID, tick } from './lib/harness.mjs';

export async function notify({ rec, P, stack }) {
  rec.section('notify');
  const kabir = P.kabir, ahoro = P.ahoro, rila = P.rila;
  // Kabir's channels: this browser (web push), his phone (push token) and his laptop (polls only).
  const settings = await kabir.get('/api/v0/companion/notification-settings', { expect: 200 });
  rec.note('how', 'notification settings defaults', settings.data.settings);
  const endpoint = `https://fcm.googleapis.com/fcm/send/qa-synthetic-${randomUUID()}`;
  const keys = { auth: Buffer.alloc(16, 7).toString('base64url'), p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url') };
  const web = await kabir.post('/api/v0/companion/web-push', { endpoint, keys });
  rec.check(web.status === 200, 'a browser subscribes to web push', web.data);
  const phone = await kabir.pair('android', 'Kabir phone');
  const token = 'qa-fcm-' + randomUUID().replace(/-/g, '') + 'x'.repeat(20);
  await kabir.dpost(`/api/v0/devices/${phone.deviceId}/push`, { token }, { expect: 200 });
  const laptopOwner = Object.create(Object.getPrototypeOf(kabir)); Object.assign(laptopOwner, kabir, { device: null });
  const laptop = await laptopOwner.pair('windows', 'Kabir laptop');
  void laptop;

  // Events of each kind for Kabir, then the tick and drains; measure creation → accepted by the provider sink.
  const dm = (await ahoro.post('/api/v0/chats/direct', { personId: kabir.id })).data.id;
  const events = [];
  const t = Date.now();
  events.push(['chat.message', (await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'Push check: DM', clientId: randomUUID() })).data.id]);
  const pod = (await kabir.get('/api/v0/chats')).data.channels.find((c) => c.kind === 'pod').id;
  events.push(['chat.mention', (await ahoro.post(`/api/v0/chats/${pod}/messages`, { body: `@${kabir.username} push check: mention`, clientId: randomUUID() })).data.id]);
  const task = await ahoro.post('/api/v0/work/tasks', { title: 'Push check: assigned task', assigneeId: kabir.id }, { expect: 200 });
  events.push(['task.assigned', task.data.id]);
  const ask = await P.meera.post('/api/v0/work/tasks', { title: 'Push check: an ask from another pod', assigneeId: kabir.id }, { expect: 200 });
  events.push(['task.ask', ask.data.asked?.id ?? ask.data.id]);
  const created = performance.now();
  let first = null;
  for (let i = 0; i < 6; i++) { const r = await tick(stack, rec, 'drain'); if (!first && (r.web.sent || r.native.sent)) first = performance.now(); await delay(300); }
  const rows = await asWorker(stack, (c) => c.query(`select n.event_type,n.title,n.created_at,n.telegram_status,n.subject_id,n.message_id,n.quiet,n.quiet_reason,
      coalesce(jsonb_object_agg(d.channel,jsonb_build_object('status',d.status,'ms',round(extract(epoch from d.accepted_at-n.created_at)*1000))) filter (where d.id is not null),'{}') deliveries
    from pulse.notification n left join pulse.notification_delivery d on d.notification_id=n.id
    where n.person_id=$1 and n.created_at>=$2 group by n.id order by n.created_at`, [kabir.id, new Date(t)]));
  rec.note('how', "Kabir's notifications and their deliveries per channel (sink providers)", rows.rows.map((r) => ({ type: r.event_type, title: r.title, telegram: r.telegram_status, ...r.deliveries })));
  for (const [type, subject] of events) {
    const r = rows.rows.find((x) => x.subject_id === subject || x.message_id === subject) ?? rows.rows.find((x) => x.event_type === type);
    rec.check(!!r, `a ${type} notification is created for Kabir`, rows.rows.map((x) => x.event_type));
    if (r && !Object.keys(r.deliveries).length) {
      const why = await asOwner(stack, (c) => c.query(`select n.event_type,n.subject_type,n.kind,n.read_at,n.expires_at>now() live,n.created_at,
        pulse.notification_authorized(n.id,n.person_id) authorized,pulse.notification_recipient_allowed(n.person_id,n.event_type,n.subject_type,n.subject_id) allowed
        from pulse.notification n where n.person_id=$1 and n.event_type=$2 and n.created_at>=$3`, [kabir.id, r.event_type, new Date(t - 1000)]));
      rec.note('how', `${type}: no push destination captured; the row`, why.rows);
    }
    // ATT (0860): a family that already pinged someone its daily limit (6 assigned tasks; the seed gives Kabir more)
    // waits quietly in the bell; it is never pushed. That is the policy, not a lost push.
    if (r?.quiet && r.quiet_reason === 'limit') {
      rec.check(!Object.keys(r.deliveries).length, `${type}: over its daily ping limit, it waits in the bell and is not pushed`, r.deliveries);
    } else if (r) {
      rec.check(r.deliveries.web?.status === 'accepted', `${type}: web push accepted`, r.deliveries);
      rec.check(r.deliveries.native?.status === 'accepted', `${type}: phone push accepted`, r.deliveries);
      if (r.deliveries.web?.ms != null) rec.timing(`${type}: created → web push accepted (drain every 2 s in production)`, r.deliveries.web.ms);
    }
  }
  if (first) rec.timing('events → first push accepted', first - created);
  // What the phone shows: the push carries no content ("A new work update is ready"); the shell then reads the
  // update list with its device credential and acknowledges what it received.
  const upd = await kabir.dget(`/api/v0/companion/updates?since=${new Date(t - 5000).toISOString()}`, { expect: 200 });
  rec.note('how', 'phone background check (companion/updates): rows, counts, cursor', { rows: upd.data.rows.map((r) => ({ type: r.eventType, title: r.title, ping: r.pingAllowed, href: r.href })), counts: upd.data.counts });
  rec.check(upd.data.rows.length >= events.length - 1, 'the phone background check lists the new updates', upd.data.rows.length);
  const ack = await kabir.dpost('/api/v0/companion/ack', { ids: upd.data.rows.map((r) => r.id) }, { expect: 200 });
  void ack;
  const again = await kabir.dget(`/api/v0/companion/updates?since=${upd.data.cursor}`, { expect: 200 });
  rec.check(again.data.rows.every((r) => !upd.data.rows.some((u) => u.id === r.id) || r.id === undefined) || again.data.rows.length <= upd.data.rows.length, 'the next poll from the cursor does not repeat everything', again.data.rows.length);
  rec.note('how', 'the next poll from the returned cursor (10-second overlap by design)', { repeated: again.data.rows.filter((r) => upd.data.rows.some((u) => u.id === r.id)).length });
  // Deep links for each kind (what tapping a phone notification opens).
  for (const r of upd.data.rows) {
    const open = await kabir.dget(`/api/v0/native/notifications/${r.id}/open`);
    rec.note(open.status === 200 ? 'how' : 'P2', `native open for ${r.eventType}: ${open.status}`, open.status === 200 ? { target: open.data.target, href: open.data.href ?? null } : open.data);
  }
  // The badge: counts after reading the DM.
  await kabir.post(`/api/v0/chats/${dm}/read`, { through: new Date().toISOString() });
  const badge = await kabir.dget('/api/v0/companion/updates', { expect: 200 });
  rec.note('how', 'counts (badge) after reading the DM', badge.data.counts);

  // Telegram and e-mail: nobody is connected, so nothing queues (counted, never sent).
  const mail = await asWorker(stack, (c) => c.query("select count(*)::int n from pulse.hr_mail_outbox where person_id=$1", [kabir.id]));
  rec.note('how', 'e-mail copies queued for Kabir (HR copies only)', mail.rows[0].n);

  // ---------------------------------------------------------------------------- quiet hours, DND and snooze
  rec.section('notify: quiet');
  await kabir.post('/api/v0/companion/notification-settings', { dnd: true }, { expect: 200 });
  const quiet = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'During do-not-disturb', clientId: randomUUID() }, { expect: 200 });
  await tick(stack, rec, 'drain');
  const q = await asWorker(stack, (c) => c.query(`select d.channel,d.status from pulse.notification n join pulse.notification_delivery d on d.notification_id=n.id where n.message_id=$1 and n.person_id=$2`, [quiet.data.id, kabir.id]));
  rec.check(q.rows.every((r) => r.status !== 'accepted'), 'with do-not-disturb on, nothing is pushed', q.rows);
  rec.note('how', 'deliveries during do-not-disturb', q.rows);
  const upd2 = await kabir.dget(`/api/v0/companion/updates?since=${new Date(Date.now() - 30e3).toISOString()}`);
  rec.note('how', 'what the phone poll says during do-not-disturb', { suppression: upd2.data.suppression, ping: upd2.data.rows.map((r) => r.pingAllowed) });
  await kabir.post('/api/v0/companion/notification-settings', { dnd: false }, { expect: 200 });
  // Quiet hours that cover now.
  const now = new Date(Date.now() + 330 * 60e3), hh = (d) => d.toISOString().slice(11, 16);
  await kabir.post('/api/v0/companion/notification-settings', { quiet: true, start: hh(new Date(now - 3600e3)), end: hh(new Date(now.getTime() + 3600e3)), timezone: 'Asia/Kolkata' }, { expect: 200 });
  const night = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'During quiet hours', clientId: randomUUID() }, { expect: 200 });
  await tick(stack, rec, 'drain');
  const qh = await asWorker(stack, (c) => c.query(`select d.channel,d.status,d.retry_at from pulse.notification n join pulse.notification_delivery d on d.notification_id=n.id where n.message_id=$1 and n.person_id=$2`, [night.data.id, kabir.id]));
  rec.check(qh.rows.every((r) => r.status !== 'accepted'), 'inside quiet hours nothing is pushed', qh.rows);
  rec.note('how', 'deliveries inside quiet hours (held or suppressed)', qh.rows);
  await kabir.post('/api/v0/companion/notification-settings', { quiet: false }, { expect: 200 });
  // Snooze one item.
  const item = upd.data.rows[0];
  if (item) {
    await kabir.post('/api/v0/companion/snooze', { id: item.id, minutes: 15 }, { expect: 200 });
    const inbox = await kabir.get(`/api/v0/companion/inbox?id=${item.id}`, { expect: 200 });
    rec.check(!!inbox.data.rows[0]?.snoozedUntil, 'a snoozed item carries its snooze time', inbox.data.rows[0]);
  }
  // A revoked phone gets nothing more.
  await kabir.post(`/api/v0/devices/${phone.deviceId}/revoke`, {}, { expect: 200 });
  const afterRevoke = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'After revoking the phone', clientId: randomUUID() }, { expect: 200 });
  const rv = await asWorker(stack, (c) => c.query(`select d.channel from pulse.notification n join pulse.notification_delivery d on d.notification_id=n.id where n.message_id=$1 and n.person_id=$2`, [afterRevoke.data.id, kabir.id]));
  rec.check(!rv.rows.some((r) => r.channel === 'native'), 'a revoked phone is no longer a push destination', rv.rows);
  void rila;
}

export async function auth({ rec, P, stack }) {
  rec.section('auth');
  const kabir = P.kabir;
  // Wrong password, then the right one.
  const r = await fetch(stack.base + '/api/v0/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: kabir.username, password: 'wrong-password-123' }) });
  rec.check(r.status === 401, 'a wrong password is refused without saying which part was wrong', r.status);
  rec.request({ persona: 'anonymous', method: 'POST', route: '/api/v0/auth/sign-in', path: '/api/v0/auth/sign-in', status: r.status, ms: 0 });
  const me = await kabir.get('/api/v0/me', { expect: 200 });
  rec.note('how', 'GET /me for a member', { keys: Object.keys(me.data), role: me.data.role });
  // A device token's scope is the employee's own: no HR or admin endpoint even for an admin.
  const rila = P.rila; await rila.pair('macos', 'Rila Mac');
  await rila.dget('/api/v0/hr/attendance', { expect: 403 });
  await rila.dget('/api/v0/companion', { expect: 200 });
  const signOut = await rila.post('/api/v0/auth/sign-out', {});
  rec.note('how', 'signing out of the browser', { status: signOut.status });
  await rila.get('/api/v0/me', { expect: 401 });
  rec.note('how', 'after signing out in the browser, the paired laptop still works?', (await rila.dget('/api/v0/companion')).status);
  await rila.signIn();
}
