// EST-2811 (owner, 28 Oct 2026): everyday people and admin work as one call, for the CLI, MCP and API alike, so nobody
// edits the production database by hand again. Every operation runs as the signed-in person on the v1 transaction and
// reuses the screens' own database functions (login_issue, auth_admin, chat_group_*, onboarding_roster): those
// functions check HR/admin rights themselves; authorize repeats the check first so a refusal is a clean 403. Writes are
// recorded in pulse_priv.app_change (who, which app, the value before) and most can be undone for 7 days.
import { createHash, randomInt, randomBytes } from 'node:crypto';
import { authMail, authMailAvailable } from './auth-mail.js';
import { sendLink } from './account-security.js';
import { companyOrigin } from './tenant-context.js';
import { defineV1Operation, v1Fail, type Closed, type V1Context } from './v1.js';

const object = (properties: Closed['properties'], required = Object.keys(properties)): Closed =>
  ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const str = { type: 'string' }, maybe = { type: ['string', 'null'] }, bool = { type: 'boolean' }, int = { type: 'integer' };
const list = (item: Closed): Closed => object({ items: { type: 'array', items: item } });
const one = async <T = unknown>(ctx: V1Context, sql: string, args: unknown[] = []): Promise<T> => (await ctx.client.query(sql, args)).rows[0]?.v as T;
const viewerIs = (ctx: V1Context, ...roles: string[]) => one<boolean>(ctx, 'select pulse.viewer_is(variadic $1::text[]) v', [roles]);
/** A person acting through their own sign-in (OAuth app or token): never an AI member or a connected app's key. */
const person = (ctx: V1Context) => { if (ctx.principal.kind !== 'person') v1Fail(403, 'Sign in as a person to do this'); };
const roles = (...need: string[]) => async (ctx: V1Context) => { person(ctx); if (!(await viewerIs(ctx, ...need))) v1Fail(403, `Only ${need.join(', ')} may do this`); };
const visible = (...need: string[]) => async (ctx: V1Context) => ctx.principal.kind === 'person' && await viewerIs(ctx, ...need);
const staffOnly = async (ctx: V1Context) => ctx.principal.kind === 'person' && await one<boolean>(ctx, 'select pulse.native_is_staff() v');
const change = (ctx: V1Context, action: string, subject: string, detail: unknown) =>
  one<string>(ctx, 'select pulse.app_change_add($1,$2,$3) v', [action, subject, JSON.stringify(detail)]);
const masked = (e: unknown) => { const [n, d] = String(e ?? '').split('@'); return d ? `${n.slice(0, 2)}•••@${d}` : ''; };

// ------------------------------------------------------------------------------------------------ who and where
const me = object({ id: uuid, name: str, username: maybe, roles: { type: 'array', items: str }, app: maybe, company: str });
defineV1Operation({ operationId: 'whoAmI', method: 'GET', path: '/api/v1/people/me', scope: 'people.read',
  summary: 'The signed-in person, their roles and the app they are using', response: me,
  mcp: { name: 'whoami', title: 'Who am I in Pulse', description: 'Returns the signed-in person, their roles (admin, hr, leadership, manager …) and the company. Tools shown depend on these roles.' },
  handler: async ctx => (await ctx.client.query(`select p.id,p.display_name name,pp.username,
      coalesce((select array_agg(distinct r.role_key order by r.role_key) from pulse.role_assignment r where r.person_id=p.id
        and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'{}') roles,
      nullif(current_setting('pulse.app_label',true),'') app,(select name from pulse.org where id=pulse.current_org()) company
    from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=pulse.current_viewer()`)).rows[0] ?? v1Fail(404, 'No person'),
});

const PERSON = object({ id: uuid, name: str, username: maybe, status: str, role: maybe, pod: maybe, department: maybe, joinedOn: maybe,
  managerId: maybe, managerName: maybe, workEmail: maybe, phone: maybe, employmentType: maybe, workLocation: maybe });
// Phone numbers are HR's; the directory shows names, roles and work email to every colleague.
const COLUMNS = (hr: string) => `p.id,p.display_name name,pp.username,p.status,pp.role,pp.pod,pp.department,pp.joined_on::text "joinedOn",
  pp.manager_id "managerId",m.display_name "managerName",pp.email "workEmail",case when ${hr} then pp.phone end phone,
  pp.employment_type "employmentType",pp.work_location "workLocation"`;
const FROM = `pulse.person p join pulse.people_profile pp on pp.person_id=p.id left join pulse.person m on m.id=pp.manager_id`;
const digits = (s: string) => s.replace(/\D/g, '');
defineV1Operation({ operationId: 'searchPeople', method: 'GET', path: '/api/v1/people', scope: 'people.read',
  summary: 'Find staff by name, username or work email; HR and admins also by phone',
  query: object({ query: { type: 'string', minLength: 1, maxLength: 120 }, status: { enum: ['active', 'inactive', 'offboarded', 'all'] } }, []),
  response: list(PERSON),
  mcp: { name: 'search_people', title: 'Find people', description: 'Finds staff by name, username or work email (HR and admins: also personal email or phone, any format). Returns up to 25, active staff unless status says otherwise.' },
  handler: async (ctx, { query }) => {
    person(ctx);
    const hr = await viewerIs(ctx, 'admin', 'hr'), q = (query.query ?? '').trim().toLowerCase(), phone = digits(q);
    const rows = (await ctx.client.query(`select ${COLUMNS('$4')} from ${FROM}
      where p.side='staff' and ($2='all' or p.status=$2) and ($1='' or lower(p.display_name) like '%'||$1||'%' or lower(coalesce(pp.username,'')) like '%'||$1||'%'
        or lower(coalesce(pp.email,'')) like '%'||$1||'%'
        or ($4 and length($3)>=6 and right(regexp_replace(coalesce(pp.phone,''),'\\D','','g'),10) like '%'||right($3,10)||'%')
        or ($4 and exists(select 1 from pulse.account a where a.holder_person_id=p.id and lower(a.handle)=$1)))
      order by lower(p.display_name) like $1||'%' desc, p.display_name limit 25`, [q, query.status ?? 'active', phone, hr])).rows;
    return { items: rows };
  },
});
defineV1Operation({ operationId: 'getPerson', method: 'GET', path: '/api/v1/people/{personId}', scope: 'people.read',
  summary: 'Read one staff record; HR and admins also see recent corrections and sign-in state',
  params: object({ personId: uuid }),
  response: object({ person: PERSON, signIn: { type: ['object', 'null'], additionalProperties: false, required: ['canSignIn', 'lastSignInAt', 'mustChange'],
      properties: { canSignIn: bool, lastSignInAt: maybe, mustChange: bool } },
    changes: { type: 'array', items: object({ field: str, from: maybe, to: maybe, by: maybe, reason: maybe, via: maybe, at: str }) } }),
  mcp: { name: 'get_person', title: 'Read a person', description: 'Reads one staff record by id (from search_people). HR and admins also get sign-in state and the last 15 field changes with who, why and which app.' },
  handler: async (ctx, { params }) => {
    person(ctx);
    const hr = await viewerIs(ctx, 'admin', 'hr');
    const row = (await ctx.client.query(`select ${COLUMNS('$2')} from ${FROM} where p.id=$1 and p.side='staff'`, [params.personId, hr])).rows[0] ?? v1Fail(404, 'Person unavailable');
    if (!hr) return { person: row, signIn: null, changes: [] };
    const signIn = (await ctx.client.query(`select exists(select 1 from pulse.login_credential lc where lc.person_id=$1 and lc.status='active')
        or exists(select 1 from pulse.account a where a.holder_person_id=$1 and a.provider='google' and a.purpose like 'Workspace%') "canSignIn",
      (select max(last_active_at)::text from pulse.login_session where person_id=$1) "lastSignInAt",
      coalesce((select must_change from pulse.login_credential where person_id=$1),false) "mustChange"`, [params.personId])).rows[0];
    const changes = (await ctx.client.query(`select h.field,h.old_value "from",h.new_value "to",b.display_name "by",h.reason,h.via,h.changed_at::text "at"
      from pulse.record_change h left join pulse.person b on b.id=h.changed_by where h.entity_type='person' and h.entity_id=$1 order by h.changed_at desc limit 15`, [params.personId])).rows;
    return { person: row, signIn, changes };
  },
});

// ------------------------------------------------------------------------------------------------ onboarding
const ONBOARDING = object({ id: uuid, name: str, role: maybe, pod: maybe, joinedOn: maybe, invite: maybe, inviteAt: maybe, canSignIn: bool,
  signedInAt: maybe, percent: int, missing: { type: 'array', items: str }, firstCheckIn: maybe, lastCheckIn: maybe, completedAt: maybe,
  stuck: { type: 'array', items: str } });
type Roster = { id: string; name: string; role: string | null; pod: string | null; joinedOn: string | null; invite: { status?: string; at?: string } | null;
  canSignIn: boolean; signedInAt: string | null; percent: number; missing: string[] | null; firstCheckIn: string | null; lastCheckIn: string | null; completedAt: string | null };
defineV1Operation({ operationId: 'listOnboarding', method: 'GET', path: '/api/v1/people/onboarding', scope: 'people.read',
  summary: 'The onboarding roster (HR, admins and leadership): who is invited, signed in, complete or stuck',
  query: object({ stuck: { enum: ['true', 'false'] } }, []), response: list(ONBOARDING),
  available: visible('admin', 'hr', 'leadership'), authorize: async ctx => roles('admin', 'hr', 'leadership')(ctx),
  mcp: { name: 'list_onboarding', title: 'Onboarding roster', description: 'Lists everyone in onboarding with invitation, first sign-in, profile completeness and check-ins. stuck="true" keeps only people who cannot sign in, never signed in, or have missing profile items; each row says why in "stuck".' },
  handler: async (ctx, { query }) => {
    const roster = (await one<Roster[]>(ctx, 'select pulse.onboarding_roster() v')) ?? [];
    const items = roster.map(r => {
      const missing = r.missing ?? [], stuck: string[] = [];
      if (!r.canSignIn) stuck.push('cannot sign in (no password or Google account)');
      else if (!r.signedInAt) stuck.push('never signed in');
      if (!r.completedAt && missing.length) stuck.push(`profile missing: ${missing.join(', ')}`);
      return { id: r.id, name: r.name, role: r.role ?? null, pod: r.pod ?? null, joinedOn: r.joinedOn ?? null, invite: r.invite?.status ?? null,
        inviteAt: r.invite?.at ?? null, canSignIn: !!r.canSignIn, signedInAt: r.signedInAt ?? null, percent: r.percent ?? 0, missing,
        firstCheckIn: r.firstCheckIn ?? null, lastCheckIn: r.lastCheckIn ?? null, completedAt: r.completedAt ?? null, stuck };
    });
    return { items: query.stuck === 'true' ? items.filter(i => i.stuck.length) : items };
  },
});

// ------------------------------------------------------------------------------------------------ HR corrections
const FIELDS = ['joinedOn', 'department', 'managerId', 'workEmail', 'phone', 'role', 'pod', 'employmentType', 'workLocation'];
const CHANGE = object({ changed: bool, field: str, from: maybe, to: maybe, changeId: maybe, undoUntil: maybe });
defineV1Operation({ operationId: 'correctPersonField', method: 'POST', path: '/api/v1/people/{personId}/corrections', scope: 'people.write',
  summary: 'HR or admin corrects one field of a staff record, with the reason (logged, locked against sync, undoable 7 days)',
  params: object({ personId: uuid }),
  body: object({ field: { enum: FIELDS }, value: { type: ['string', 'null'], maxLength: 120 }, reason: { type: 'string', minLength: 5, maxLength: 300 } }),
  response: CHANGE, available: visible('admin', 'hr'), authorize: async ctx => roles('admin', 'hr')(ctx),
  mcp: { name: 'correct_person_field', title: 'Correct a staff record', idempotent: true,
    description: 'Sets one field of a staff record: joinedOn (YYYY-MM-DD), department, managerId (a person id), workEmail, phone, role, pod, employmentType (full_time, part_time, intern, contract, freelance) or workLocation. value null clears it. reason is required and kept in the record history with your name and this app. Undo with undo_change for 7 days.' },
  handler: async (ctx, { params, body }) => {
    const b = body as { field: string; value: string | null; reason: string };
    const r = await one<Record<string, unknown>>(ctx, 'select pulse.hr_profile_correct($1,$2,$3,$4) v', [params.personId, b.field, b.value, b.reason]);
    return { changed: !!r.changed, field: String(r.field), from: (r.from as string) ?? null, to: (r.to as string) ?? null,
      changeId: (r.changeId as string) ?? null, undoUntil: r.undoUntil ? String(r.undoUntil) : null };
  },
});

// ------------------------------------------------------------------------------------------------ sign-in help
// Readable one-time password: 3 groups of 4 from an alphabet without look-alikes (14 characters, about 62 bits).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const oneTimePassword = () => Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-');
defineV1Operation({ operationId: 'issueOneTimePassword', method: 'POST', path: '/api/v1/people/{personId}/one-time-password', scope: 'people.write',
  summary: 'HR or admin issues a one-time password and e-mails it to the person (ends their sessions; must be changed at sign-in, expires in 7 days)',
  params: object({ personId: uuid }), body: object({}, []),
  response: object({ sent: bool, to: str, username: str, expiresInDays: int, changeId: str }),
  available: visible('admin', 'hr'), authorize: async ctx => roles('admin', 'hr')(ctx),
  mcp: { name: 'issue_one_time_password', title: 'Issue a one-time password', destructive: true,
    description: 'Replaces the person\'s password with a new one-time password, signs them out everywhere and e-mails it with their username to their sign-in e-mail. They must choose their own password at sign-in; it expires in 7 days. The password is never shown here. If e-mail cannot be sent nothing changes. Prefer send_sign_in_email (a link) when the person can open e-mail.' },
  handler: async (ctx, { params }) => {
    if (!authMailAvailable()) v1Fail(503, 'E-mail delivery is not available here; use the HR screen to hand the password over privately');
    const account = await one<{ delivery?: string }>(ctx, "select pulse.auth_admin('staff',$1,'history','{}') v", [params.personId]);
    const to = account?.delivery ?? v1Fail(409, 'This person has no sign-in e-mail. Set their work email first (correct_person_field workEmail).');
    const password = oneTimePassword();
    await ctx.client.query('select pulse.login_issue($1,$2)', [params.personId, password]);
    const p = (await ctx.client.query('select p.display_name name,pp.username from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=$1', [params.personId])).rows[0];
    const sent = await authMail(to, 'Your Pulse one-time password', `Hello ${p.name},\n\nHR issued you a one-time password for Pulse.\n\nUsername: ${p.username}\nOne-time password: ${password}\n\n`
      + `Sign in at ${companyOrigin()}/login and choose your own password straight away. This password works once and expires in 7 days. If you did not expect this, tell HR.`);
    if (!sent) v1Fail(503, 'The e-mail could not be sent, so the password was not changed. Try again or use send_sign_in_email.');
    await ctx.client.query('select pulse.auth_mail_event($1,$2,$3)', ['staff', params.personId, true]);
    const changeId = await change(ctx, 'password.issue', params.personId, { to: masked(to) });
    return { sent: true, to: masked(to), username: String(p.username), expiresInDays: 7, changeId };
  },
});
defineV1Operation({ operationId: 'sendSignInEmail', method: 'POST', path: '/api/v1/people/{personId}/sign-in-email', scope: 'people.write',
  summary: 'HR or admin e-mails an invitation (set-password link, 7 days) or a password reset link (60 minutes)',
  params: object({ personId: uuid }), body: object({ kind: { enum: ['invite', 'reset'] } }),
  response: object({ sent: bool, kind: str, changeId: str }),
  available: visible('admin', 'hr'), authorize: async ctx => roles('admin', 'hr')(ctx),
  mcp: { name: 'send_sign_in_email', title: 'Send an invitation or reset link',
    description: 'E-mails the person a private link: kind "invite" (re)sends the invitation to choose a password (works once, 7 days); kind "reset" sends a password reset link (60 minutes). No password is in the e-mail.' },
  handler: async (ctx, { params, body }) => {
    const kind = (body as { kind: 'invite' | 'reset' }).kind, token = randomBytes(32).toString('base64url');
    const result = await one<Record<string, unknown>>(ctx, "select pulse.auth_admin('staff',$1,$2,$3) v",
      [params.personId, kind, JSON.stringify({ hash: createHash('sha256').update(token).digest('hex') })]);
    const sent = await sendLink('staff', kind, token, result);
    await ctx.client.query('select pulse.auth_mail_event($1,$2,$3)', ['staff', params.personId, sent]);
    if (!sent) v1Fail(503, 'The e-mail could not be sent. Check the person\'s e-mail, or use the HR screen\'s private link.');
    return { sent: true, kind, changeId: await change(ctx, 'invite.send', params.personId, { kind }) };
  },
});

// ------------------------------------------------------------------------------------------------ chat groups
defineV1Operation({ operationId: 'createChatGroup', method: 'POST', path: '/api/v1/chats/groups', scope: 'chats.write',
  summary: 'Create a chat group with chosen people, or with every active staff member',
  body: object({ name: { type: 'string', minLength: 2, maxLength: 60 }, memberIds: { type: 'array', items: uuid, maxItems: 256 }, allActiveStaff: bool }, ['name']),
  response: object({ groupId: uuid, name: str, members: int, changeId: str }),
  available: staffOnly, authorize: async ctx => { person(ctx); if (!(await one<boolean>(ctx, 'select pulse.native_is_staff() v'))) v1Fail(403, 'Staff only'); },
  mcp: { name: 'create_group', title: 'Create a chat group',
    description: 'Creates a chat group you admin. Give memberIds (from search_people) or allActiveStaff true for everyone active. You are added automatically.' },
  handler: async (ctx, { body }) => {
    const b = body as { name: string; memberIds?: string[]; allActiveStaff?: boolean };
    const ids = b.allActiveStaff ? (await ctx.client.query("select array_agg(id) v from pulse.person where side='staff' and status='active' and id<>pulse.current_viewer()")).rows[0].v ?? []
      : [...new Set(b.memberIds ?? [])];
    if (!ids.length) v1Fail(400, 'Give memberIds or allActiveStaff true');
    if (ids.length > 256) v1Fail(400, 'A group holds at most 256 people');
    const groupId = await one<string>(ctx, 'select pulse.chat_group_create($1,$2) v', [b.name, ids]);
    const members = await one<number>(ctx, 'select count(*)::int v from pulse.chat_member where channel_id=$1', [groupId]);
    return { groupId, name: b.name.trim(), members, changeId: await change(ctx, 'chat.group.create', groupId, { name: b.name, members }) };
  },
});
defineV1Operation({ operationId: 'changeChatGroupMembers', method: 'POST', path: '/api/v1/chats/groups/{groupId}/members', scope: 'chats.write',
  summary: 'A group admin adds or removes members (undoable 7 days)',
  params: object({ groupId: uuid }), body: object({ add: { type: 'array', items: uuid, maxItems: 256 }, remove: { type: 'array', items: uuid, maxItems: 256 } }, []),
  response: object({ groupId: uuid, added: { type: 'array', items: uuid }, removed: { type: 'array', items: uuid }, members: int, changeId: str }),
  available: staffOnly, authorize: async ctx => person(ctx),
  mcp: { name: 'change_group_members', title: 'Add or remove group members', description: 'Adds and/or removes people (ids from search_people) in a group you admin. Undo with undo_change for 7 days.' },
  handler: async (ctx, { params, body }) => {
    const b = body as { add?: string[]; remove?: string[] };
    const before: string[] = (await ctx.client.query('select coalesce(array_agg(person_id),\'{}\') v from pulse.chat_member where channel_id=$1', [params.groupId])).rows[0].v;
    await ctx.client.query('select pulse.chat_group_members($1,$2,$3)', [params.groupId, b.add ?? [], b.remove ?? []]);
    const after: string[] = (await ctx.client.query('select coalesce(array_agg(person_id),\'{}\') v from pulse.chat_member where channel_id=$1', [params.groupId])).rows[0].v;
    const added = after.filter(id => !before.includes(id)), removed = before.filter(id => !after.includes(id));
    return { groupId: params.groupId, added, removed, members: after.length,
      changeId: await change(ctx, 'chat.members', params.groupId, { groupId: params.groupId, added, removed }) };
  },
});

// ------------------------------------------------------------------------------------------------ bug reports
const REPORT = object({ id: uuid, personName: str, platform: maybe, appVersion: maybe, page: maybe, body: str, hasScreenshot: bool, status: str, createdAt: str, handledBy: maybe });
defineV1Operation({ operationId: 'listBugReports', method: 'GET', path: '/api/v1/events/bug-reports', scope: 'events.read',
  summary: 'Bug reports and feedback sent from the Pulse apps (admin and leadership), newest first',
  query: object({ status: { enum: ['new', 'seen', 'done', 'all'] } }, []), response: list(REPORT),
  available: visible('admin', 'leadership'), authorize: async ctx => roles('admin', 'leadership')(ctx),
  mcp: { name: 'list_bug_reports', title: 'Bug reports', description: 'Lists up to 100 bug reports from the Pulse apps, newest first; status new (default), seen, done or all.' },
  handler: async (ctx, { query }) => ({ items: (await ctx.client.query(`select f.id,p.display_name "personName",f.platform,f.app_version "appVersion",f.page,f.body,
      f.screenshot is not null "hasScreenshot",f.status,f.created_at::text "createdAt",h.display_name "handledBy"
    from pulse.app_feedback f join pulse.person p on p.id=f.person_id left join pulse.person h on h.id=f.handled_by
    where $1='all' or f.status=$1 order by f.created_at desc limit 100`, [query.status ?? 'new'])).rows }),
});
defineV1Operation({ operationId: 'setBugReportStatus', method: 'POST', path: '/api/v1/events/bug-reports/{reportId}/status', scope: 'events.write',
  summary: 'Mark a bug report new, seen or done (undoable 7 days)',
  params: object({ reportId: uuid }), body: object({ status: { enum: ['new', 'seen', 'done'] } }),
  response: object({ id: uuid, from: str, to: str, changeId: maybe }),
  available: visible('admin', 'leadership'), authorize: async ctx => roles('admin', 'leadership')(ctx),
  mcp: { name: 'set_bug_report_status', title: 'Triage a bug report', idempotent: true, description: 'Marks one bug report new, seen or done. Undo with undo_change for 7 days.' },
  handler: async (ctx, { params, body }) => {
    const to = (body as { status: string }).status;
    const from = await one<string>(ctx, 'select status v from pulse.app_feedback where id=$1 for update', [params.reportId]) ?? v1Fail(404, 'Bug report unavailable');
    if (from === to) return { id: params.reportId, from, to, changeId: null };
    await ctx.client.query('update pulse.app_feedback set status=$2,handled_by=pulse.current_viewer(),handled_at=now() where id=$1', [params.reportId, to]);
    return { id: params.reportId, from, to, changeId: await change(ctx, 'feedback.status', params.reportId, { from, to }) };
  },
});

// ------------------------------------------------------------------------------------------------ changes and undo
defineV1Operation({ operationId: 'listMyChanges', method: 'GET', path: '/api/v1/people/me/changes', scope: 'people.read',
  summary: 'Changes you made through apps and tokens in the last 30 days, with what can still be undone',
  response: list(object({ changeId: uuid, app: str, action: str, subjectId: uuid, subjectName: maybe, detail: str, at: str, undoUntil: maybe, status: str })),
  mcp: { name: 'list_my_changes', title: 'Changes I made through apps', description: 'Lists changes you made through Claude, ChatGPT, the CLI or the API in the last 30 days, newest first, with undoUntil where undo_change still works.' },
  handler: async ctx => {
    person(ctx);
    const items = (await one<{ detail: unknown }[]>(ctx, 'select pulse.app_change_list(30) v')) ?? [];
    return { items: items.map(i => ({ ...i, detail: JSON.stringify(i.detail) })) };
  },
});
defineV1Operation({ operationId: 'undoChange', method: 'POST', path: '/api/v1/people/me/changes/{changeId}/undo', scope: 'people.write',
  summary: 'Undo a change you made through an app within 7 days (a later change by anyone wins)',
  params: object({ changeId: uuid }), body: object({}, []), response: object({ changeId: uuid, status: str, replayed: bool }),
  authorize: async ctx => person(ctx),
  mcp: { name: 'undo_change', title: 'Undo a change I made', destructive: true, idempotent: true,
    description: 'Undoes one change from list_my_changes within 7 days: a corrected field goes back, group members return, a bug report status goes back. Refused if someone changed it since. Passwords and e-mails already sent cannot be undone.' },
  handler: async (ctx, { params }) => one(ctx, 'select pulse.app_change_undo($1) v', [params.changeId]),
});

// ------------------------------------------------------------------------------------------------ search and fetch
// ChatGPT's deep-research shape: search → {results:[{id,title,url}]}, fetch → {id,title,text,url,metadata}.
const RESULT = object({ id: str, title: str, url: str });
const ID = '^(person|task|project):[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
defineV1Operation({ operationId: 'search', method: 'GET', path: '/api/v1/search', scope: 'search.read',
  summary: 'Search people, tasks and projects you can see', query: object({ query: { type: 'string', minLength: 1, maxLength: 200 } }),
  response: object({ results: { type: 'array', items: RESULT } }),
  mcp: { name: 'search', title: 'Search Pulse', description: 'Searches people, tasks and projects you can see for these words. Returns up to 20 results; read one with fetch.' },
  handler: async (ctx, { query }) => {
    person(ctx);
    const words = query.query.toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 6), base = companyOrigin();
    if (!words.length) return { results: [] };
    const all = (col: string) => words.map((_, i) => `${col} like '%'||$${i + 1}||'%'`).join(' and ');
    const people = (await ctx.client.query(`select 'person:'||p.id id,p.display_name||coalesce(' · '||pp.role,'') title,p.id ref from pulse.person p
      join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active'
      and ${all("lower(p.display_name||' '||coalesce(pp.username,'')||' '||coalesce(pp.role,'')||' '||coalesce(pp.department,''))")} order by p.display_name limit 8`, words)).rows;
    const tasks = (await ctx.client.query(`select 'task:'||t.id id,t.title||' · '||t.status title,t.id ref from pulse.task t
      where ${all('lower(t.title)')} order by t.due_at desc nulls last limit 8`, words)).rows;
    const projects = (await ctx.client.query(`select 'project:'||p.id id,coalesce(p.title,p.name) title,p.id ref from pulse.project p
      where ${all("lower(coalesce(p.title,p.name,''))")} limit 6`, words)).rows;
    const url = (kind: string, ref: string) => `${base}/${kind === 'person' ? 'people' : kind === 'task' ? 'tasks' : 'projects'}/${ref}`;
    return { results: [...people, ...tasks, ...projects].slice(0, 20).map(r => ({ id: r.id, title: r.title, url: url(r.id.split(':')[0], r.ref) })) };
  },
});
defineV1Operation({ operationId: 'fetch', method: 'GET', path: '/api/v1/search/{id}', scope: 'search.read',
  summary: 'Read one search result in full', params: object({ id: { type: 'string', pattern: ID } }),
  response: object({ id: str, title: str, text: str, url: str, metadata: object({ kind: str }) }),
  mcp: { name: 'fetch', title: 'Read a search result', description: 'Reads one result from search by its id (person:…, task:… or project:…).' },
  handler: async (ctx, { params }) => {
    person(ctx);
    const [kind, ref] = params.id.split(':'), base = companyOrigin();
    const sql = kind === 'person'
      ? `select p.display_name title,jsonb_build_object('name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,'workEmail',pp.email,
          'joinedOn',pp.joined_on,'manager',(select display_name from pulse.person where id=pp.manager_id),'status',p.status) body
         from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=$1 and p.side='staff'`
      : kind === 'task'
        ? `select t.title,jsonb_build_object('title',t.title,'status',t.status,'priority',t.priority,'due',t.due_at,'notes',left(t.notes,4000),
            'assignee',(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)),
            'project',(select coalesce(title,name) from pulse.project where id=t.project_id)) body from pulse.task t where t.id=$1`
        : `select coalesce(p.title,p.name) title,to_jsonb(p) - 'org_id' body from pulse.project p where p.id=$1`;
    const row = (await ctx.client.query(sql, [ref])).rows[0] ?? v1Fail(404, 'Not found or not visible to you');
    return { id: params.id, title: row.title, text: JSON.stringify(row.body), url: `${base}/${kind === 'person' ? 'people' : kind + 's'}/${ref}`, metadata: { kind } };
  },
});
