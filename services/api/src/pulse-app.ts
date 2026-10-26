// The Pulse apps round (R15d): the Pulse window's web session, feedback from the apps, the tester list and the
// admin view of devices and tracking health. Device calls arrive through the native gateway with a device credential.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fail, leadership, sessionHash, type Tx, type Viewer } from './routes.js';
import { deviceStatus, parseScreenshot, type HealthRow } from './pulse-app-model.js';
import { attendanceEnabled } from './attendance-policy.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLATFORMS = ['windows', 'macos', 'android', 'ios', 'chrome', 'web'];
const team = (v: Viewer) => { if (!leadership(v) || v.nativeDevice) fail(403, 'For the Pulse app team (admin and leadership) in the browser'); };
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export function registerPulseAppRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The Pulse window: this paired computer's credential → a 30-day web session for its window only. Rust sets the
  // cookie directly in the window, so the token never appears in a URL or page script.
  app.post<{ Body: Body }>('/api/v0/native/web-session', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!v.nativeDevice || !v.person) fail(403, 'Scoped device credential required');
    if (!(await c.query('select pulse.auth_allow($1,30) ok', [sessionHash('web-session:' + v.nativeDevice)])).rows[0].ok) fail(429, 'Too many window sign-ins. Try again in a few minutes.');
    const name = (await c.query('select name from pulse.native_device where id=$1', [v.nativeDevice])).rows[0]?.name ?? 'computer';
    const token = randomBytes(32).toString('base64url');
    const issued = (await c.query('select pulse.native_web_session($1,$2,$3) d', [v.nativeDevice, sessionHash(token), `Pulse app · ${name}`.slice(0, 120)])).rows[0].d;
    if (!issued) fail(403, 'Your Pulse sign-in is not active. Sign in on the Pulse site once, then try again.');
    return { token, maxAge: issued.maxAge === 2592000 ? 2592000 : 43200 };
  }));

  // ------------------------------------------------------------------------------------------------ feedback
  app.post<{ Body: Body }>('/api/v0/feedback', { bodyLimit: 6 * 1024 * 1024, schema: { body } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Feedback needs your own Pulse account');
    const b = req.body, message = text(b.text, 4000);
    if (!message) fail(400, 'Write a few words first');
    let shot: ReturnType<typeof parseScreenshot> = null;
    try { shot = parseScreenshot(b.screenshot); } catch (e) { fail(400, (e as Error).message); }
    const device = v.nativeDevice ? (await c.query('select platform from pulse.native_device where id=$1', [v.nativeDevice])).rows[0] : null;
    const platform = device?.platform ?? (PLATFORMS.includes(String(b.platform)) ? String(b.platform) : 'web');
    const version = /^[A-Za-z0-9.+_-]{0,40}$/.test(String(b.appVersion ?? '')) ? String(b.appVersion ?? '') : '';
    const recent = (await c.query("select count(*)::int n from pulse.app_feedback where person_id=$1 and created_at>now()-interval '1 hour'", [v.person])).rows[0].n;
    if (recent >= 20) fail(429, 'Thank you! That is a lot of feedback for one hour; please send more later.');
    const row = (await c.query('insert into pulse.app_feedback(org_id,person_id,device_id,platform,app_version,page,body,screenshot,screenshot_type) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
      [v.org, v.person, v.nativeDevice ?? null, platform, version, text(b.page, 80), message, shot?.bytes ?? null, shot?.type ?? null])).rows[0];
    return { ok: true, id: row.id };
  }));
  app.get('/api/v0/feedback', req => tx(req, async (c, v) => {
    team(v);
    const rows = (await c.query(`select f.id,f.person_id "personId",p.display_name "personName",f.platform,f.app_version "appVersion",f.page,f.body,
      f.screenshot is not null "hasScreenshot",f.status,f.created_at "createdAt",h.display_name "handledBy",f.handled_at "handledAt"
      from pulse.app_feedback f join pulse.person p on p.id=f.person_id left join pulse.person h on h.id=f.handled_by
      order by f.created_at desc limit 200`)).rows;
    return { rows };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/feedback/:id/screenshot', async (req, reply) => {
    if (!UUID.test(req.params.id)) fail(400, 'Choose a valid feedback item');
    const shot = await tx(req, async (c, v) => { team(v); return (await c.query('select screenshot,screenshot_type from pulse.app_feedback where id=$1 and screenshot is not null', [req.params.id])).rows[0]; });
    if (!shot) fail(404, 'No screenshot');
    return reply.header('content-type', shot.screenshot_type).header('cache-control', 'private, no-store').header('content-security-policy', 'sandbox').send(shot.screenshot);
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/feedback/:id/status', { schema: { body } }, req => tx(req, async (c, v) => {
    team(v);
    if (!UUID.test(req.params.id) || !['new', 'seen', 'done'].includes(String(req.body.status))) fail(400, 'Choose new, seen or done');
    const r = (await c.query('update pulse.app_feedback set status=$2,handled_by=$3,handled_at=now() where id=$1 returning id', [req.params.id, req.body.status, v.person])).rows[0];
    if (!r) fail(404, 'Feedback unavailable');
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------------ testers
  app.get('/api/v0/testers', req => tx(req, async (c, v) => {
    team(v);
    const testers = (await c.query(`select t.person_id "personId",p.display_name name,pp.username,t.platforms,t.note,t.invited_at "invitedAt",i.display_name "invitedBy",
      (select count(*)::int from pulse.app_feedback f where f.person_id=t.person_id) feedback
      from pulse.app_tester t join pulse.person p on p.id=t.person_id left join pulse.people_profile pp on pp.person_id=p.id left join pulse.person i on i.id=t.invited_by
      order by p.display_name`)).rows;
    const devices = (await c.query('select person_id "personId",platform,app_version "appVersion",last_seen "lastSeen" from pulse.device_health()')).rows;
    const people = (await c.query("select p.id,p.display_name name from pulse.person p where p.side='staff' and p.status='active' order by p.display_name")).rows;
    return { testers: testers.map(t => ({ ...t, devices: devices.filter(d => d.personId === t.personId) })), people };
  }));
  app.post<{ Body: Body }>('/api/v0/testers', { schema: { body } }, req => tx(req, async (c, v) => {
    team(v);
    const b = req.body;
    if (!UUID.test(String(b.personId))) fail(400, 'Choose a person');
    const platforms = Array.isArray(b.platforms) ? [...new Set(b.platforms.map(String))] : [];
    if (!platforms.every(p => ['windows', 'macos', 'android', 'ios', 'chrome'].includes(p))) fail(400, 'Choose Mac, Windows, Android, iPhone or Chrome');
    if (!(await c.query("select 1 from pulse.person where id=$1 and side='staff' and status='active'", [b.personId])).rows[0]) fail(404, 'Person unavailable');
    await c.query(`insert into pulse.app_tester(org_id,person_id,platforms,note,invited_by) values($1,$2,$3,$4,$5)
      on conflict(org_id,person_id) do update set platforms=excluded.platforms,note=excluded.note`, [v.org, b.personId, platforms, text(b.note, 200), v.person]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/testers/:id/remove', { schema: { body } }, req => tx(req, async (c, v) => {
    team(v);
    if (!UUID.test(req.params.id)) fail(400, 'Choose a tester');
    await c.query('delete from pulse.app_tester where person_id=$1', [req.params.id]);
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------------ devices & tracking health
  app.get('/api/v0/devices/health', req => tx(req, async (c, v) => {
    team(v);
    const enabled = await attendanceEnabled(c);
    const rows = (await c.query('select * from pulse.device_health()')).rows as (HealthRow & Record<string, unknown>)[];
    const now = Date.now();
    const devices = rows.map(r => {
      const status = deviceStatus(enabled ? r : { ...r, last_attendance: null }, now);
      return {
      personId: r.person_id, personName: r.person_name, deviceId: r.device_id, name: r.device_name, platform: r.platform, appVersion: r.app_version,
      lastSeen: r.last_seen, lastAttendance: enabled ? r.last_attendance : null, lastEvent: r.last_event, events7d: r.events_7d,
      ...status, attendance: enabled ? status.attendance : null,
    }; });
    const people = (await c.query("select count(*)::int n from pulse.person where side='staff' and status='active'")).rows[0].n;
    return { attendanceEnabled: enabled, devices, peopleWithDevices: new Set(devices.map(d => d.personId)).size, people };
  }));
}
