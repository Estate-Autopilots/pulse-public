/** FLOW-E (owner, 21 Oct 2026: "All apps like Sales X-Ray should be able to connect"): one connector framework for
 *  the App action (and Start) blocks. Each app names its actions: the primitive and kind it is in the builder, what it
 *  needs and what it gives back, in words. Its status is honest and read for this company and this person: connected,
 *  not connected (with where to connect), built in, partial (what Pulse does and what it does not), or off. Settings →
 *  Apps lists them (GET /v1/flow/apps); the builder's side sheet shows the status of the app a step uses.
 *  Also here: the small pieces the app actions share (a calendar event, a message link, Gmail sending where the
 *  company allows it, a signed webhook, the project's Drive folder) and the address another app posts to. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Open, type Tx, type Viewer } from '../routes.js';
import { googleBridge } from '../google.js';
import { readModules } from '../modules.js';
import { hostCompany } from '../tenant-context.js';
import { xrayStatus } from '../sales-xray.js';
import { canDesign, parseId, UUID } from './store.js';
import type { BlockKey, FlowDef } from './types.js';

type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

export type AppAction = { key: string; name: string; block: BlockKey; kind: string; needs: string; gives: string };
export type AppDef = { key: string; name: string; maker: string; icon: string; group: 'Sales' | 'Files' | 'Calendar' | 'Messages' | 'Leads' | 'Money' | 'Other apps'; summary: string; actions: AppAction[] };
export type AppState = 'connected' | 'not_connected' | 'built_in' | 'partial' | 'off';
export type AppStatus = { state: AppState; text: string; connect?: { label: string; href?: string; action?: string } | null; detail?: string | null };

const a = (key: string, name: string, block: BlockKey, kind: string, needs: string, gives: string): AppAction => ({ key, name, block, kind, needs, gives });
export const APPS: AppDef[] = [
  { key: 'sales_xray', name: 'Sales X-Ray', maker: 'Atlas Crest', icon: 'scan-search', group: 'Sales', summary: 'Sales calls analysed: the summary, items asked for, objections, promises and a score.',
    actions: [a('call', 'Analyse a sales call', 'app', 'xray', 'The lead or client of the run; the person’s own Sales X-Ray account', 'The call’s summary, items asked for, objections, promises and score, each for later steps')] },
  { key: 'google_drive', name: 'Google Drive', maker: 'Google', icon: 'hard-drive', group: 'Files', summary: 'The project’s folder and its files, read by Pulse.',
    actions: [a('folder', 'The project’s Drive folder', 'app', 'drive_folder', 'The run’s project (or a folder link)', 'The folder, for every later step'),
      a('file', 'A file from Drive', 'app', 'drive_file', 'The project’s folder', 'The file picked (or uploaded), with its link')] },
  { key: 'google_calendar', name: 'Google Calendar and Meet', maker: 'Google', icon: 'calendar-check', group: 'Calendar', summary: 'A time slot becomes an event with its people, place and Meet link.',
    actions: [a('event', 'Put it in the calendar', 'app', 'calendar', 'A time slot (from a “Fix a time” step) or a day and time', 'The event: a Google Calendar link and an .ics file')] },
  { key: 'gmail', name: 'Gmail', maker: 'Google', icon: 'mail', group: 'Messages', summary: 'An e-mail with the run’s values filled in.',
    actions: [a('email', 'Send an e-mail', 'app', 'email', 'Who it goes to; the text with {client}, {project} and fields', 'Sent, with the text and when')] },
  { key: 'whatsapp', name: 'WhatsApp', maker: 'Meta', icon: 'message-circle', group: 'Messages', summary: 'A WhatsApp message with the run’s values filled in.',
    actions: [a('whatsapp', 'Send a WhatsApp', 'app', 'whatsapp', 'The text with {client}, {project} and fields', 'Sent, with the text and when')] },
  { key: 'meta_leads', name: 'Meta lead ads', maker: 'Meta', icon: 'megaphone', group: 'Leads', summary: 'New leads from your ads start a run by themselves.',
    actions: [a('lead', 'A Meta lead ad comes in', 'start', 'meta', 'Your ad account, read by the ads sync', 'The lead, as the run’s start')] },
  { key: 'web_forms', name: 'Forms', maker: 'Pulse', icon: 'clipboard-list', group: 'Leads', summary: 'Pulse’s own forms (on the phone, with photos and the place) and any web form that posts to a process.',
    actions: [a('form', 'A form is sent', 'start', 'form', 'A Pulse form', 'Its answers, as the run’s start'),
      a('hook', 'Another app sends it in', 'start', 'webhook', 'The process’s own address, posted to by a web form, a CRM or any app', 'What it sent, as the run’s start')] },
  { key: 'billing', name: 'Billing', maker: 'Pulse', icon: 'receipt', group: 'Money', summary: 'Quotations and invoices in Pulse’s Billing, kept on the step.',
    actions: [a('quote', 'Make a quotation', 'app', 'quote', 'The client and the items asked for', 'The quotation (number, total, status)'),
      a('invoice', 'Make an invoice', 'app', 'invoice', 'The accepted quotation', 'The invoice (number, total, status)')] },
  { key: 'webhook_out', name: 'Webhooks', maker: 'Any app', icon: 'webhook', group: 'Other apps', summary: 'The run’s values posted to another app’s address, signed; its reply comes back.',
    actions: [a('send', 'Send to another app', 'app', 'webhook', 'The company’s address for webhooks (below)', 'The app’s reply, for later steps')] },
];
export const APP = new Map(APPS.map((x) => [x.key, x]));
/** The app a step's kind belongs to ("app/xray" → Sales X-Ray), for the builder's sheet. */
export const appOfKind = (block: string | null | undefined, kind: string | null | undefined) => APPS.find((x) => x.actions.some((y) => y.block === block && y.kind === kind)) ?? null;

const setting = async (c: PoolClient, key: string) => ((await c.query('select settings from pulse.app_setting where app_key=$1', [key])).rows[0]?.settings ?? {}) as Body;

/** Each app's status for this company and this person, in words. */
export async function appStatuses(c: PoolClient, v: Viewer): Promise<Record<string, AppStatus>> {
  const off = (await readModules(c, v.org)).off as string[];
  const company = (await c.query('select pulse.org_modules() m')).rows[0].m as { finance?: boolean; tasks?: boolean };
  const install = !hostCompany();
  const n = (await c.query(`select (select count(*)::int from pulse.campaign) campaigns,(select count(*)::int from pulse.lead where created_at>now()-interval '30 days') leads,
    (select count(*)::int from pulse.file where store='gdrive' and trashed_at is null) files,
    (select count(*)::int from pulse.account where provider='google' and handle=$1 and holder_person_id=$2 and not is_shared and purpose like 'Workspace%') mailbox`, [v.email, v.person])).rows[0];
  const out: Record<string, AppStatus> = {};
  const x = off.includes('sales_xray') ? null : await xrayStatus(c);
  out.sales_xray = !x ? { state: 'off', text: 'Not switched on for this Pulse.', detail: 'The server switches Sales X-Ray on (PULSE_SALES_XRAY).' }
    : !x.configured ? { state: 'off', text: 'No Sales X-Ray address is set on this server.' }
    : x.connected ? { state: 'connected', text: `Connected as you${typeof x.account?.person === 'string' ? ` (${x.account.person})` : ''}. Each person connects their own account.`, connect: { label: 'Open Sales X-Ray', href: '/apps/sales-xray' } }
    : { state: 'not_connected', text: 'You have not connected your Sales X-Ray account. Each person connects their own; until then the analysis is typed in.', connect: { label: 'Connect', href: '/apps/sales-xray' } };
  out.google_drive = install && n.files ? { state: 'connected', text: `Read by Pulse: ${Number(n.files).toLocaleString('en-IN')} files indexed. Pulse reads Drive; ${process.env.PULSE_DRIVE_UPLOAD_ENABLED === '1' ? 'uploading into a project’s folder is on' : 'it does not write to it (uploading is off here)'}.`, connect: { label: 'Connected accounts', href: '/settings?tab=connected' } }
    : { state: 'not_connected', text: install ? 'No Drive files have been read yet.' : 'This company’s Drive is not connected. Its admin connects it with a company connector.', connect: { label: 'Connect', href: '/settings?tab=connected' } };
  out.google_calendar = { state: 'partial', text: 'Pulse makes the event for you to add (a Google Calendar link with the people, or an .ics file). It does not write to calendars or invite anyone itself.' };
  const server = process.env.PULSE_GMAIL_SEND_ENABLED === '1', ours = (await setting(c, 'gmail')).send === true;
  out.gmail = n.mailbox ? server && ours ? { state: 'connected', text: 'Your Gmail is connected; Pulse sends from it when you press Send on a step.' }
      : { state: 'partial', text: `Your Gmail is connected for reading. ${!server ? 'Sending from Pulse is not switched on for this Pulse' : 'Sending from Pulse is off for your company (leadership switches it on here)'}: the step fills in the text and opens it in your mail app.` }
    : { state: 'not_connected', text: 'Your own Google Workspace mailbox is not connected (a shared login cannot send). The step fills in the text for you to send.', connect: { label: 'Mail', href: '/inbox' } };
  out.whatsapp = { state: 'partial', text: 'The step fills in the text and opens it in WhatsApp; you press send. Pulse does not send WhatsApp messages itself.' };
  out.meta_leads = n.campaigns ? { state: 'connected', text: `Your ad account is read by the ads sync (${n.campaigns} campaigns, ${n.leads} leads in 30 days). Each new lead starts the processes that start on a lead.` }
    : { state: 'not_connected', text: 'No ad account is connected here. Once the ads sync reads one, each new lead starts the processes that start on a lead.', connect: { label: 'Connected accounts', href: '/settings?tab=connected' } };
  out.web_forms = company.tasks === false ? { state: 'off', text: 'Work and tasks are switched off for this company (forms live there).' }
    : { state: 'built_in', text: 'Pulse forms start runs or finish Collect steps. Any web form can post to a process’s own address (a Start “Another app sends it in”).' };
  out.billing = company.finance === false || off.includes('money') ? { state: 'off', text: 'Finance is switched off for this company.' }
    : { state: 'built_in', text: 'Quotations and invoices are made in Billing and picked on the step.', connect: { label: 'Open Billing', href: '/erp' } };
  const hook = await setting(c, 'webhook_out');
  out.webhook_out = str(hook.url, 2000) ? { state: 'connected', text: `Posts to ${new URL(String(hook.url)).host}, signed with your company’s secret (header x-pulse-signature).`, connect: { label: 'Change', action: 'webhook' } }
    : { state: 'not_connected', text: 'No address yet. Give the address your other app listens on; Pulse signs every post.', connect: { label: 'Connect', action: 'webhook' } };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the app actions share.
const pad = (n: number) => String(n).padStart(2, '0');
/** A calendar event in the company's time zone: the Google Calendar link (people as guests) and an .ics to add. */
export function calendarEvent(e: { title: string; on: string; time: string; minutes: number; people: string[]; place: string; zone: string; details: string }) {
  const [h, m] = e.time.split(':').map(Number); const start = new Date(`${e.on}T${pad(h)}:${pad(m)}:00Z`); const end = new Date(start.getTime() + e.minutes * 60000);
  const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
  const guests = e.people.filter((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p));
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${stamp(start)}/${stamp(end)}`, ctz: e.zone, details: e.details, ...(e.place ? { location: e.place } : {}), ...(guests.length ? { add: guests.join(',') } : {}) });
  const esc = (x: string) => x.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pulse//Flow//EN', 'BEGIN:VEVENT', `UID:${randomBytes(8).toString('hex')}@pulse`, `DTSTAMP:${stamp(new Date())}Z`,
    `DTSTART;TZID=${e.zone}:${stamp(start)}`, `DTEND;TZID=${e.zone}:${stamp(end)}`, `SUMMARY:${esc(e.title)}`, ...(e.place ? [`LOCATION:${esc(e.place)}`] : []), `DESCRIPTION:${esc(e.details)}`,
    ...guests.map((g) => `ATTENDEE:mailto:${g}`), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return { title: e.title, on: e.on, time: e.time, minutes: e.minutes, place: e.place || null, people: e.people, zone: e.zone, calendarUrl: `https://calendar.google.com/calendar/render?${q}`, ics };
}
/** The link that opens a message in WhatsApp or the mail app, filled in (the person sends it). */
export function messageLinks(channel: string, to: string, subject: string, text: string) {
  if (channel === 'whatsapp') { const phone = to.replace(/[^\d]/g, ''); return { href: `https://wa.me/${phone.length >= 8 ? phone : ''}?text=${encodeURIComponent(text)}`, open: 'Open in WhatsApp' }; }
  if (channel === 'email') return { href: `mailto:${/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to) ? to : ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, open: 'Open in your mail app' };
  return { href: null, open: null };
}
/** Pulse sends an e-mail itself only from the person's own Workspace mailbox, where the company switched sending on. */
export async function canSendMail(c: PoolClient, v: Viewer, channel: string) {
  if (channel !== 'email' || process.env.PULSE_GMAIL_SEND_ENABLED !== '1' || !v.person || (await setting(c, 'gmail')).send !== true) return false;
  return !!(await c.query("select 1 from pulse.account where provider='google' and handle=$1 and holder_person_id=$2 and not is_shared and purpose like 'Workspace%'", [v.email, v.person])).rowCount;
}
export async function sendMail(c: PoolClient, v: Viewer, m: { to: string; subject: string; body: string; channel: string }) {
  if (m.channel !== 'email') fail(400, 'Pulse sends e-mail only; open WhatsApp messages in WhatsApp');
  if (!(await canSendMail(c, v, 'email'))) fail(403, 'Sending from Pulse is off for this company: copy the text, or open it in your mail app');
  if (!/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(m.to)) fail(400, 'Give one e-mail address to send to');
  const r = await googleBridge('send', { subject: v.email, to: m.to, title: m.subject.replace(/[\r\n]+/g, ' '), body: m.body }) as { id?: string };
  await c.query("select pulse.audit_write('send','gmail.message')");
  return { to: m.to, id: r?.id ?? null };
}
/** The project's Drive folder: the one named on the project, else its bound location's. */
export async function projectFolder(c: PoolClient, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const named = (await c.query("select value from pulse.record_link where entity_type='project' and entity_id=$1 and kind='drive_folder' order by updated_at desc limit 1", [projectId])).rows[0]?.value as string | undefined;
  const bound = (await c.query('select folder_id from pulse.project_location_member where project_id=$1 limit 1', [projectId])).rows[0]?.folder_id as string | undefined;
  return named?.match(/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? bound ?? null;
}
/** An address Pulse may post to: https, a name (not a private address) unless this server allows local test receivers. */
export function hookAddress(raw: string): URL | null {
  let u: URL; try { u = new URL(raw); } catch { return null; }
  const local = process.env.PULSE_FLOW_WEBHOOK_LOCAL === '1' && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (local) return u;
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(h) || /^(localhost|.*\.local|.*\.internal)$/i.test(h)) return null;
  return u;
}
/** Post the run's values to the company's address (or the step's), signed with the company's secret. */
export async function postWebhook(c: PoolClient, stepUrl: string, payload: Body): Promise<{ ok: boolean; status: number; body: unknown; to: string | null }> {
  const raw = stepUrl || str((await setting(c, 'webhook_out')).url, 2000);
  if (!raw) fail(409, 'No address to send to: connect Webhooks in Settings → Apps');
  const u = hookAddress(raw) ?? fail(400, 'The address must be https:// and a public name');
  const secret = (await c.query('select pulse.app_secret_get($1,$2) s', ['webhook_out', randomBytes(32).toString('hex')])).rows[0].s as string;
  const text = JSON.stringify(payload);
  try {
    const r = await fetch(u, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', 'user-agent': 'Pulse-Flow/1',
      'x-pulse-signature': `sha256=${createHmac('sha256', secret).update(text).digest('hex')}` }, body: text });
    const reply = (await r.text()).slice(0, 20000); let parsed: unknown = reply; try { parsed = JSON.parse(reply); } catch { /* text */ }
    return { ok: r.ok, status: r.status, body: parsed, to: u.host };
  } catch { return { ok: false, status: 0, body: null, to: u.host }; }
}
export const hookHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function registerFlowAppRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const staff = async (c: PoolClient) => { if (!(await c.query('select pulse.flow_staff() ok')).rows[0].ok) fail(403, 'Flow is for the team'); };
  app.get('/v1/flow/apps', (req) => tx(req, async (c, v) => {
    await staff(c); const st = await appStatuses(c, v); const hook = await setting(c, 'webhook_out');
    return { apps: APPS.map((x) => ({ ...x, status: st[x.key] })), webhook: canDesign(v) ? { url: str(hook.url, 2000) || null } : null, canEdit: canDesign(v),
      mail: { server: process.env.PULSE_GMAIL_SEND_ENABLED === '1', company: (await setting(c, 'gmail')).send === true } };
  }));
  // Gmail: whether people may send a step's e-mail from their own Gmail (this Pulse must allow sending too).
  app.post<{ Body: Body }>('/v1/flow/apps/gmail', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!canDesign(v)) fail(403, 'Leadership and admins connect apps');
    if (req.body.send === true && process.env.PULSE_GMAIL_SEND_ENABLED !== '1') fail(409, 'Sending e-mail is not switched on for this Pulse');
    await c.query(`insert into pulse.app_setting(org_id,app_key,settings,updated_by) values(pulse.current_org(),'gmail',$1,$2)
      on conflict(org_id,app_key) do update set settings=excluded.settings,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify({ send: req.body.send === true }), v.person]);
    return { send: req.body.send === true };
  }));
  // Webhooks: the company's address (leadership), and its signing secret (shown to leadership, to set in the other app).
  app.post<{ Body: Body }>('/v1/flow/apps/webhook', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!canDesign(v)) fail(403, 'Leadership and admins connect apps');
    const url = str(req.body.url, 2000); if (url && !hookAddress(url)) fail(400, 'The address must be https:// and a public name');
    await c.query(`insert into pulse.app_setting(org_id,app_key,settings,updated_by) values(pulse.current_org(),'webhook_out',$1,$2)
      on conflict(org_id,app_key) do update set settings=excluded.settings,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(url ? { url } : {}), v.person]);
    const secret = url ? (await c.query('select pulse.app_secret_get($1,$2) s', ['webhook_out', randomBytes(32).toString('hex')])).rows[0].s as string : null;
    return { url: url || null, secret };
  }));
  // A process's own address for a Start "Another app sends it in" (made new each time; the old one stops working).
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/processes/:id/hook', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!canDesign(v)) fail(403, 'Leadership and admins make a process’s address');
    const { source, id: pid } = parseId(req.params.id); if (source !== 'flow') fail(400, 'Save it as a process first');
    const def = ((await c.query('select definition from pulse.flow_process where id=$1', [pid])).rows[0]?.definition ?? fail(404, 'Process not found')) as FlowDef;
    const step = def.steps.find((s) => s.id === str(req.body.step, 40) && s.module === 'start' && (s.settings as Body)?.trigger === 'webhook') ?? fail(400, 'Choose the Start “Another app sends it in”');
    const token = randomBytes(24).toString('base64url');
    await c.query('select pulse.flow_hook_make($1,$2,$3)', [pid, step.id, hookHash(token)]);
    return { path: `/api/flow-hook/${token}`, token };
  }));
  app.get<{ Params: { id: string } }>('/v1/flow/processes/:id/hook', (req) => tx(req, async (c) => {
    await staff(c); const { id: pid } = parseId(req.params.id); return { hooks: (await c.query('select pulse.flow_hook_state($1) h', [pid])).rows[0].h };
  }));
  // Another app posts here (signed out): an unknown or stopped address answers 404, saying nothing more.
  app.post<{ Params: { token: string }; Body: Body }>('/v1/flow/hooks/:token', { bodyLimit: 65536 }, async (req, reply) => {
    const token = String(req.params.token ?? ''); if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return reply.code(404).send({ error: 'Not found' });
    const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Body : {};
    const name = str(payload.name ?? payload.title ?? payload.full_name, 200);
    const rid = await open(async (c) => (await c.query('select pulse.flow_hook_start($1,$2,$3) id', [hookHash(token), name, JSON.stringify(payload)])).rows[0].id as string | null);
    if (!rid || !UUID.test(rid)) return reply.code(404).send({ error: 'Not found' });
    return { ok: true, run: rid };
  });
}
