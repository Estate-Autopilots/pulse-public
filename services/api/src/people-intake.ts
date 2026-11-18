// SELLER-ONBOARD (owner, 17 Nov 2026): "When he sends the details to the Pulse chat, detect it on your own and add them
// into the application ... they get the link; make a group in Pulse with the links pinned." The confirm side of a people
// intake (migration 2226). The server's worker (tools/people-intake.py) reads what the watched people send in the
// conversation and posts a preview card; here:
//   GET  /api/v0/people-intake                       the company's intakes (admins and HR)
//   POST /api/v0/people-intake                       open one on a conversation (admins and HR)
//   POST /api/v0/people-intake/:id/close
//   GET  /api/v0/people-intake/batches/:id           the card: the rows, each matched to People now, and the problems
//   POST /api/v0/people-intake/batches/:id/confirm   an approver adds them: People's own add and edit (records.ts), as
//                                                    that person, then the group with its first steps pinned, the
//                                                    hand-off list, then the invitations (HR's own, invitations.ts rules)
//   POST /api/v0/people-intake/batches/:id/dismiss
// Nothing is added, changed or sent before an approver confirms. An "Owner-admin" row gets the job title only: access
// roles are given on the person's profile, never from a list.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, sessionHash, type Tx, type Viewer } from './routes.js';
import { addPerson, editPerson } from './records.js';
import { sendMail } from './mail-send.js';
import { companyOrigin, hostCompany } from './tenant-context.js';
import { googleInvitable, googleInviteBody } from './account-security.js';
import { readGooglePolicy } from './google-sign-in.js';
import { platformMail } from './platform-config.js';
import { googleGuide, startGuide } from './invitations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (raw: unknown, what: string) => (typeof raw === 'string' && UUID.test(raw) ? raw : fail(404, `${what} not found`));
type Obj = Record<string, unknown>;
export type Problem = { level: 'block' | 'warn' | 'info'; code: string; text: string };
export type RoleKey = 'sales_executive' | 'team_lead' | 'manager' | 'owner_admin';
/** One row as the worker read it (tools/people_intake_parse.py). */
export type IntakeRow = { n: number; name: string | null; phone: string | null; email: string | null; role: string | null; roleKey: RoleKey | null;
  active: boolean | null; joinedOn: string | null; reportsTo: string | null; area: string | null; languages: string[]; android: boolean | null;
  model: string | null; problems: Problem[] };
export type Staff = { id: string; name: string; status: string; role: string | null; department: string | null; email: string | null; phone: string | null;
  canSignIn: boolean; invited: string | null };
type Match = { id: string; name: string; how: 'email' | 'phone' | 'name'; status: string; role: string | null };
/** What will happen to a row: added, updated (which person), or skipped (why); its manager as found in People or in the list. */
export type Planned = IntakeRow & { action: 'add' | 'update' | 'skip'; match: Match | null; manager: { id: string | null; row: number | null; name: string } | null; problems: Problem[] };

/** The job titles the four roles become (a title typed otherwise is kept as typed). */
export const TITLES: Record<RoleKey, string> = { sales_executive: 'Sales Executive', team_lead: 'Sales Team Lead', manager: 'Sales Manager', owner_admin: 'Owner' };
const SALES_TITLE = /^(sales\b|team lead|.*\bsales (executive|team lead|manager)$)/i;
// WL-RESCUE-2 (Sakobe, Willow Lane, 18 Nov 2026: "Role: Customer Support Executive" became "Sales Executive"): a role
// written in is kept as written; only the template's own words (Sales executive / Team lead / Manager / Owner-admin) take
// the standard title of their kind. CI-GREEN-6: so do their bare short forms the list reader knows (SE, Exec, TL, Mgr:
// tools/people_intake_parse.py), as before; "SE" was kept as "SE" (test_people_intake).
const TEMPLATE_ROLE = /^\s*(sales\s*exec(utive)?|se|exec|team\s*lead|tl|manager|mgr|owner(\s*[-\/]?\s*admin)?)\s*$/i;
export const titleOf = (p: { role: string | null; roleKey: RoleKey | null }): string | null => {
  const typed = (p.role ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return typed && !TEMPLATE_ROLE.test(typed) ? typed : p.roleKey ? TITLES[p.roleKey] : typed || null;
};
const key = (s: string | null | undefined) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ten = (p: string | null | undefined) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const first = (s: string) => key(s).split(' ')[0] ?? '';

/** Each row against People now: the same person found by Gmail, then number, then exact name; its manager by name (in
 *  People or earlier in the list); and what will be done. Pure, so the card and the confirm decide the same way. */
export function planRows(rows: IntakeRow[], staff: Staff[]): Planned[] {
  const taken = new Map<string, number>();
  const named = (q: string, self: number): { id: string | null; row: number | null; name: string } | null => {
    const k = key(q); if (!k) return null;
    const people = staff.filter((s) => s.status === 'active');
    const exact = people.filter((s) => key(s.name) === k), inList = rows.filter((r) => r.n !== self && key(r.name) === k);
    if (exact.length === 1 && !inList.length) return { id: exact[0].id, row: null, name: exact[0].name };
    if (!exact.length && inList.length === 1) return { id: null, row: inList[0].n, name: inList[0].name! };
    if (exact.length + inList.length > 1) return null;
    // One word ("Priya"): the one person whose first name it is.
    const byFirst = people.filter((s) => first(s.name) === k), listFirst = rows.filter((r) => r.n !== self && first(r.name ?? '') === k);
    if (!k.includes(' ') && byFirst.length + listFirst.length === 1) return byFirst.length ? { id: byFirst[0].id, row: null, name: byFirst[0].name } : { id: null, row: listFirst[0].n, name: listFirst[0].name! };
    return null;
  };
  return rows.map((r) => {
    const problems = [...(r.problems ?? [])];
    const byEmail = r.email ? staff.find((s) => s.email && s.email.toLowerCase() === r.email!.toLowerCase()) : undefined;
    const byPhone = ten(r.phone) ? staff.find((s) => ten(s.phone) === ten(r.phone)) : undefined;
    const byName = staff.filter((s) => key(s.name) === key(r.name));
    let match: Match | null = null;
    const m = byEmail ?? byPhone ?? (byName.length === 1 ? byName[0] : undefined);
    if (m) match = { id: m.id, name: m.name, how: byEmail ? 'email' : byPhone ? 'phone' : 'name', status: m.status, role: m.role };
    if (byEmail && byPhone && byEmail.id !== byPhone.id) problems.push({ level: 'block', code: 'two_people', text: `The Gmail is ${byEmail.name}'s but the number is ${byPhone.name}'s: fix one of them` });
    else if (!m && byName.length > 1) problems.push({ level: 'block', code: 'same_name', text: `${byName.length} people in Pulse are called ${r.name}: add their Gmail or number` });
    if (match && match.how !== 'name' && key(match.name) !== key(r.name)) problems.push({ level: 'info', code: 'other_name', text: `Same ${match.how === 'email' ? 'Gmail' : 'number'} as ${match.name}: their record is updated, their name stays` });
    if (match) {
      const before = taken.get(match.id);
      if (before !== undefined) problems.push({ level: 'block', code: 'same_person', text: `Row ${before} is the same person (${match.name})` });
      else taken.set(match.id, r.n);
    }
    if (match && match.status === 'active' && r.active === false) problems.push({ level: 'warn', code: 'still_active', text: `${match.name} is active in Pulse: if they left, change it on their profile (a list does not end anyone's access)` });
    let manager: Planned['manager'] = null;
    if (r.reportsTo) {
      manager = named(r.reportsTo, r.n);
      if (!manager) problems.push({ level: 'warn', code: 'manager_unknown', text: `"${r.reportsTo}" is not one person in Pulse or this list: the manager is left empty` });
      else if ((manager.id && match && manager.id === match.id) || manager.row === r.n) { manager = null; }
    }
    if (r.roleKey === 'owner_admin') problems.push({ level: 'info', code: 'no_access_roles', text: 'Owner-admin: added with the job title only. Give admin access on their profile if they need it' });
    const action: Planned['action'] = problems.some((p) => p.level === 'block') ? 'skip' : match ? 'update' : 'add';
    return { ...r, problems, match, manager, action };
  });
}

/** The fields a row sets. On someone already in People: their name stays; a job title only replaces an empty or sales
 *  one (never "Director"); the department only fills an empty one; an active person is never made inactive by a list. */
export function fieldsFor(p: Planned, current: Staff | null, department: string | null): Obj {
  const out: Obj = {};
  const title = titleOf(p);
  if (!current) { out.name = p.name; out.role = title || TITLES.sales_executive; if (department) out.department = department; if (p.active === false) out.status = 'inactive'; }
  else {
    if (title && (!current.role || SALES_TITLE.test(current.role))) out.role = title;
    if (department && !current.department) out.department = department;
    if (p.active === true && current.status !== 'active') out.status = 'active';
  }
  if (p.phone) out.phone = p.phone;
  if (p.email) out.email = p.email;
  if (p.joinedOn) out.joinedOn = p.joinedOn;
  if (p.area) out.workLocation = p.area.slice(0, 60);
  return out;
}

/** People's staff as the intake matches them (pulse.people_intake_staff: admins and HR; sign-in and invitation state). */
const loadStaff = async (c: PoolClient, ids?: string[]): Promise<(Staff & { current: boolean })[]> =>
  (await c.query('select pulse.people_intake_staff($1::uuid[]) v', [ids ?? null])).rows[0].v;
const value = async <T = unknown>(c: PoolClient, sql: string, args: unknown[] = []) => {
  try { return (await c.query(sql, args)).rows[0]?.v as T; }
  catch (e) { const err = e as { code?: string; message?: string }; if (err.code === '55000') fail(409, String(err.message)); if (err.code === '42501') fail(403, String(err.message)); if (err.code === 'P0002') fail(404, String(err.message)); if (err.code === '22023' || err.code === '23505') fail(400, String(err.message)); throw e; }
};
/** One step that may be refused on its own (a manager loop, a group change) without losing the rest. */
async function trying<T>(c: PoolClient, name: string, f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await c.query(`savepoint ${name}`);
  try { const value = await f(); await c.query(`release savepoint ${name}`); return { ok: true, value }; }
  catch (e) { await c.query(`rollback to savepoint ${name}`); return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) }; }
}

type Invitee = { id: string; name: string; phone: string | null; email: string };
type Applied = { result: Obj; invitees: Invitee[]; org: string; by: string; group: string | null };

async function apply(c: PoolClient, v: Viewer, batch: string, skip: Set<number>): Promise<Applied> {
  if (!v.person || !hr(v)) fail(403, 'Only HR or an admin adds people');
  const claim = await value<{ rows: IntakeRow[]; intake: Obj }>(c, 'select pulse.people_intake_claim($1) v', [batch]);
  const intake = claim.intake, department = (intake.department as string | null) ?? null;
  const staff = await loadStaff(c), byId = new Map(staff.map((s) => [s.id, s]));
  const plan = planRows(claim.rows, staff);
  const person = new Map<number, string>(), rows: Obj[] = [];
  let added = 0, updated = 0, skipped = 0;
  for (const p of plan) {
    if (p.action === 'skip' || skip.has(p.n)) { skipped++; rows.push({ n: p.n, name: p.name, action: 'skipped', why: skip.has(p.n) ? 'Left out when confirming' : p.problems.find((x) => x.level === 'block')?.text }); continue; }
    const current = p.match ? byId.get(p.match.id) ?? null : null;
    const fields = fieldsFor(p, current, department);
    const done = await trying(c, 'intake_row', async () => {
      const id = current ? (await editPerson(c, v, current.id, fields), current.id) : (await addPerson(c, v, fields)).id;
      if (p.languages.length) await c.query('select pulse.profile_info_save($1,$2)', [id, JSON.stringify({ languages: p.languages })]);
      if (p.android !== null || p.model) {
        const note = `Phone: ${p.android === false ? 'not Android' : 'Android'}${p.model ? `, ${p.model}` : ''} (${String(intake.title).toLowerCase()} list, ${new Date().toISOString().slice(0, 10)})`;
        const old = (await c.query('select notes from pulse.people_profile where person_id=$1', [id])).rows[0]?.notes as string | null;
        const kept = (old ?? '').split('\n').filter((l) => l && !/^Phone: (not )?Android/.test(l));
        await editPerson(c, v, id, { notes: [...kept, note].join('\n').slice(0, 2000) });
      }
      return id;
    });
    if (!done.ok) { skipped++; rows.push({ n: p.n, name: p.name, action: 'skipped', why: done.error }); continue; }
    person.set(p.n, done.value);
    if (current) updated++; else added++;
    rows.push({ n: p.n, name: current ? current.name : p.name, personId: done.value, action: current ? 'updated' : 'added', active: current ? (fields.status ?? current.status) === 'active' : p.active !== false });
  }
  // Managers once everyone is in (a row may report to a row below it); a loop or a missing person is said, not fatal.
  for (const p of plan) {
    const id = person.get(p.n); if (!id || !p.manager) continue;
    const mid = p.manager.id ?? (p.manager.row !== null ? person.get(p.manager.row) : undefined);
    const row = rows.find((r) => r.n === p.n)!;
    if (!mid) { row.manager = `not set: ${p.manager.name} was not added`; continue; }
    const set = await trying(c, 'intake_manager', () => editPerson(c, v, id, { managerId: mid }));
    row.manager = set.ok ? p.manager.name : `not set: ${set.error}`;
  }
  // Who is current now: the group, the testers and the invitations are for them only.
  const current = (await loadStaff(c, [...person.values()])).filter((s) => s.current);
  const live = new Map(current.map((s) => [s.id, s]));
  // The group: everyone current from this list, their managers and the approvers; made once, then added to.
  let group = (intake.groupId as string | null) ?? null, welcome: string | null = null, groupNote: string | null = null;
  if (intake.groupName) {
    const managers = plan.map((p) => p.manager?.id ?? (p.manager?.row != null ? person.get(p.manager.row) : undefined)).filter((x): x is string => !!x);
    const members = [...new Set([...live.keys(), ...managers, ...((intake.approverIds as string[]) ?? [])])].filter((x) => x !== v.person);
    if (!group) {
      const made = await trying(c, 'intake_group', async () => {
        const g = await value<string>(c, 'select pulse.chat_group_create($1,$2) v', [intake.groupName, members]);
        const text = await value<string>(c, 'select pulse.people_intake_welcome($1) v', [intake.id]);
        const m = await value<string>(c, 'select pulse.chat_send($1,$2,null,$3::jsonb,gen_random_uuid(),null) v', [g, text, '[]']);
        await c.query('select pulse.chat_pin_message($1,true)', [m]);
        return { g, m };
      });
      if (made.ok) { group = made.value.g; welcome = made.value.m; } else groupNote = `The group was not made: ${made.error}`;
    } else if (members.length) {
      const grown = await trying(c, 'intake_group', () => c.query('select pulse.chat_group_members($1,$2,$3)', [group, members, []]));
      if (!grown.ok) groupNote = `People were not added to "${intake.groupName}": ${grown.error}`;
    }
  }
  // The hand-off list (an app's testers): current people with a Gmail whose phone is (or may be) Android.
  const testers = intake.handoff ? plan.filter((p) => { const id = person.get(p.n); return id && live.has(id) && p.email && p.android !== false; })
    .map((p) => ({ name: live.get(person.get(p.n)!)!.name, gmail: p.email, phone: p.phone, role: titleOf(p) ?? TITLES.sales_executive })) : [];
  const invitees: Invitee[] = current.filter((s) => s.email && !s.canSignIn && !s.invited).map((s) => ({ id: s.id, name: s.name, phone: s.phone, email: s.email! }));
  const result: Obj = { added, updated, skipped, rows, group: group ? { id: group, name: intake.groupName } : null, groupNote,
    testers: intake.handoff ? { label: intake.testerLabel ?? null, count: testers.length, sent: testers.length > 0 } : null,
    alreadyIn: current.filter((s) => s.canSignIn).length, invitedBefore: current.filter((s) => !s.canSignIn && s.invited).length,
    noEmail: current.filter((s) => !s.email).map((s) => s.name) };
  await c.query('select pulse.people_intake_finish($1,$2,$3,$4,$5)', [batch, JSON.stringify(result), JSON.stringify(testers), group, welcome]);
  const org = String((await c.query('select name from pulse.org where id=pulse.current_org()')).rows[0]?.name ?? 'Pulse');
  return { result, invitees, org, by: v.name, group: (intake.groupName as string | null) ?? null };
}

/** The confirmer's phone sends a link it is given once (as Add people by WhatsApp does): a ready message per person. */
export const whatsappText = (x: { name: string; org: string; by: string; link: string; group: string | null }) =>
  `Hello ${x.name.split(' ')[0]}, ${x.by} has added you to ${x.org} on Pulse. Set your password with this private link (it works once, for 7 days): ${x.link}` +
  (x.group ? `\nThen open the chat "${x.group}" in Pulse: your first steps and the app links are pinned there.` : '');
export const waLink = (phone: string | null, text: string) => { const d = String(phone ?? '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/${d.length === 10 ? '91' + d : d}?text=${encodeURIComponent(text)}` : null; };

/** HR's own invitation for each new person who cannot sign in yet (invitations.ts: prepare, then mail where this server
 *  may, else a private link): each link also comes back once, for the confirmer to send on WhatsApp. */
async function invite(req: FastifyRequest, tx: Tx, a: Applied) {
  const out: { personId: string; name: string; mailed: boolean; link: string | null; whatsapp: string | null; error?: string }[] = [];
  if (!a.invitees.length) return out;
  const ids = new Set(a.invitees.map((x) => x.id));
  const prepare = () => tx(req, async (c) => {
    const batch = await value<string>(c, 'select pulse.invitation_prepare() v');
    const rows = (await c.query('select pulse.invitation_preview() rows')).rows[0].rows as { personId: string; status: string; batchId: string; reason: string | null }[];
    return { batch, rows: rows.filter((r) => ids.has(r.personId)) };
  });
  let prep = await prepare();
  const mailOn = process.env.PULSE_GMAIL_SEND_ENABLED === '1' && !hostCompany();
  const policy = mailOn ? await tx(req, readGooglePolicy) : null;
  const linkOf = (token: string) => { const url = new URL('/login/set-password', companyOrigin()); url.hash = token; return url.href; };
  const failed: Invitee[] = [];
  for (const p of a.invitees) {
    const row = prep.rows.find((r) => r.personId === p.id);
    if (!row || row.status !== 'prepared' || row.batchId !== prep.batch) { out.push({ personId: p.id, name: p.name, mailed: false, link: null, whatsapp: null, error: row?.reason ?? 'Not invited: check their e-mail on their profile' }); continue; }
    const token = randomBytes(32).toString('base64url'), link = linkOf(token);
    if (!mailOn) { await tx(req, (c) => c.query('select pulse.invitation_link($1,$2,$3)', [p.id, prep.batch, sessionHash(token)])); out.push({ personId: p.id, name: p.name, mailed: false, link, whatsapp: waLink(p.phone, whatsappText({ ...a, name: p.name, link })) }); continue; }
    const recipient = await tx(req, async (c) => (await c.query('select pulse.invitation_start($1,$2,$3) recipient', [p.id, prep.batch, sessionHash(token)])).rows[0].recipient as string);
    let ok = false;
    try {
      const how = new URL('/login/how', companyOrigin()).href;
      ok = await sendMail({ kind: 'org', to: recipient, title: `Your ${a.org} Pulse account`, installSender: { from: platformMail().mailFrom ?? '', fromName: a.org },
        body: googleInvitable(policy!, recipient) ? `${googleInviteBody(String(recipient), link, p.name)}\n\n${googleGuide}\n\n${a.org} HR`
          : `Hello ${p.name},\n\nSet your Pulse password: ${link}\n\nThis private link can be used once and expires in 7 days. No password is included in this email.\n\n${startGuide}\n\nHow you get into Pulse: ${how}\n\n${a.org} HR` });
    } catch { ok = false; }
    await tx(req, (c) => c.query('select pulse.invitation_finish($1,$2)', [p.id, ok]));
    if (ok) out.push({ personId: p.id, name: p.name, mailed: true, link, whatsapp: waLink(p.phone, whatsappText({ ...a, name: p.name, link })) });
    else failed.push(p);
  }
  // Not mailed: the invitation is prepared again and its private link given for WhatsApp instead.
  if (failed.length) {
    prep = await prepare();
    for (const p of failed) {
      const token = randomBytes(32).toString('base64url'), link = linkOf(token);
      const made = await tx(req, async (c) => { await c.query('select pulse.invitation_link($1,$2,$3)', [p.id, prep.batch, sessionHash(token)]); return true; }).catch(() => false);
      out.push({ personId: p.id, name: p.name, mailed: false, link: made ? link : null, whatsapp: made ? waLink(p.phone, whatsappText({ ...a, name: p.name, link })) : null, ...(made ? {} : { error: 'The invitation could not be prepared' }) });
    }
  }
  return out;
}

export function registerPeopleIntakeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const staffOnly = (v: Viewer) => { if (!v.person) fail(403, 'Use your own Pulse account'); };
  app.get('/api/v0/people-intake', (req) => tx(req, async (c, v) => { staffOnly(v); return { intakes: await value(c, 'select pulse.people_intake_list() v') }; }));
  app.post<{ Body: Obj }>('/api/v0/people-intake', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    staffOnly(v); return { id: await value<string>(c, 'select pulse.people_intake_open($1) v', [JSON.stringify(req.body ?? {})]) };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/people-intake/:id/close', (req) => tx(req, async (c, v) => {
    staffOnly(v); await value(c, 'select pulse.people_intake_close($1) v', [idOf(req.params.id, 'Intake')]); return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/people-intake/batches/:id', (req) => tx(req, async (c, v) => {
    staffOnly(v);
    const card = await value<Obj | null>(c, 'select pulse.people_intake_card($1) v', [idOf(req.params.id, 'List')]);
    if (!card) fail(404, 'List not found');
    // Matched against People now, for whoever may confirm (they read every staff record); others see the rows as sent.
    const rows = card!.rows as IntakeRow[];
    return { ...card, rows: card!.canDecide ? planRows(rows, await loadStaff(c)) : rows };
  }));
  app.post<{ Params: { id: string }; Body: Obj }>('/api/v0/people-intake/batches/:id/confirm', { schema: { body: { type: 'object' } } }, async (req) => {
    const batch = idOf(req.params.id, 'List');
    const skip = new Set((Array.isArray(req.body?.skip) ? req.body.skip : []).map(Number).filter(Number.isInteger));
    const applied = await tx(req, (c, v) => { staffOnly(v); return apply(c, v, batch, skip); });
    // The people are in already: an invitation that cannot be made is said on the card (Resend invitation on their
    // profile does it later), never an error that hides what was added.
    const invites = await invite(req, tx, applied).catch((e: unknown) => applied.invitees.map((p) => ({ personId: p.id, name: p.name, mailed: false, link: null, whatsapp: null,
      error: `the invitation could not be made (${String((e as Error)?.message ?? e).slice(0, 120)}): use Resend invitation on their profile` })));
    const summary = { mailed: invites.filter((x) => x.mailed).length, links: invites.filter((x) => !x.mailed && x.link).length, failed: invites.filter((x) => !x.link).map((x) => ({ name: x.name, why: x.error ?? null })), at: new Date().toISOString() };
    await tx(req, (c) => c.query('select pulse.people_intake_invited($1,$2)', [batch, JSON.stringify(summary)]));
    // The links are in this answer only (each works once): the card shows them now, never again.
    return { ...applied.result, invites: { ...summary, people: invites } };
  });
  app.post<{ Params: { id: string } }>('/api/v0/people-intake/batches/:id/dismiss', (req) => tx(req, async (c, v) => {
    staffOnly(v); await value(c, 'select pulse.people_intake_dismiss($1) v', [idOf(req.params.id, 'List')]); return { ok: true };
  }));
}
