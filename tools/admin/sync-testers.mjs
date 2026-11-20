// tools/admin/sync-testers.py's runner (AC-CONTACTS-2, 18 Nov 2026): the register's rows through API v1's own add_contact
// and update_contact (services/api/dist: v1-money.ts), on one transaction, as the given admin of the organisation, with
// the approver as the audit actor. Reads the job as JSON on stdin; writes one JSON line per row and an "end" (or "error")
// line on stdout. The connection string comes in SYNC_TESTERS_DSN and is never printed. Run it through sync-testers.py.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const job = JSON.parse(await new Promise((ok) => { let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => ok(s)); }));
const require = createRequire(`${job.tree}/services/api/package.json`);
const pg = require('pg');
const Ajv2020 = require('ajv/dist/2020').default;
const dist = `${job.tree}/services/api/dist`;
await import(`${dist}/v1-money.js`);
const { v1Operations } = await import(`${dist}/v1.js`);
const op = (id) => v1Operations().find((o) => o.operationId === id) ?? fail(`API v1 has no ${id}: build services/api from a tree with AC-CONTACTS (2397)`);
const ADD = op('addContact'), UPDATE = op('updateContact');
const ajv = new Ajv2020({ allErrors: false, strict: false });
const valid = { add: ajv.compile(ADD.body), update: ajv.compile(UPDATE.body) };
const say = (x) => process.stdout.write(JSON.stringify(x) + '\n');
function fail(msg) { throw Object.assign(new Error(msg), { refused: true }); }

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');
const last10 = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
// The tester path: the register moves a status forward on it (or to stopped); a person's own status (client, talking,
// not_now) or a later step is kept.
const PATH = ['new', 'invited', 'installed', 'active'];
const nextStatus = (now, want) => {
  if (!want || now === want) return null;
  if (!now) return want;
  if (PATH.includes(now) && PATH.includes(want)) return PATH.indexOf(want) > PATH.indexOf(now) ? want : null;
  return want === 'stopped' && PATH.includes(now) ? want : null;
};
const STATUS_WORDS = { new: 'New', invited: 'Invited to test', installed: 'Installed', active: 'Using it', stopped: 'Stopped' };

const c = new pg.Client({ connectionString: process.env.SYNC_TESTERS_DSN, application_name: 'sync-testers' });
await c.connect();
const rows = async (sql, args = []) => (await c.query(sql, args)).rows;
let errors = 0;
try {
  await c.query('begin');
  await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.actor_account',$2,true)", [job.org, job.actor]);
  if (!(await rows("select to_regprocedure('pulse.contact_writer()') is not null v"))[0].v) fail('this database has no contact tags and status yet (migration 2397)');
  const me = await rows(`select p.id from pulse.people_profile pp join pulse.person p on p.id=pp.person_id
    where p.org_id=$1 and lower(pp.username)=lower($2) and p.side='staff' and p.status='active'`, [job.org, job.as]);
  if (me.length !== 1) fail(`no active staff member “${job.as}” in this organisation`);
  await c.query("select set_config('pulse.viewer_id',$1,true)", [me[0].id]);
  const ctx = { client: c, tenantId: job.org, requestId: randomUUID(), principal: { kind: 'person', id: me[0].id, tokenId: randomUUID(), actor: job.actor } };
  const call = async (o, check, input) => {
    if (!check(input.body)) fail(`${o.operationId}: ${check.errors?.[0]?.instancePath || '/'} ${check.errors?.[0]?.message}`);
    await o.authorize(ctx, input);
    return o.handler(ctx, input);
  };
  // Our own people: staff and AI members (never filed as contacts), by e-mail or name.
  const staff = await rows(`select p.display_name name,lower(btrim(pp.email)) email from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
    where p.org_id=$1 and p.side in ('staff','agent') and p.status<>'offboarded'`, [job.org]);
  const isStaff = (it) => staff.find((s) => (it.email && s.email === it.email) || [it.name, it.companyLabel].some((x) => x && squash(x) === squash(s.name)));
  const clientCompany = async (name) => !!name && (await rows(`select exists(select 1 from pulse.client cl where cl.org_id=$1 and lower(btrim(coalesce(cl.company_name,cl.display_name)))=lower($2))
      or exists(select 1 from pulse.company co join pulse.contact_profile cp on cp.company_id=co.id where co.org_id=$1 and lower(btrim(co.name))=lower($2)
        and ('client'=any(cp.tags) or cp.contact_status='client')) v`, [job.org, name]))[0].v;

  for (const it of job.items) {
    const out = { kind: 'row', row: it.row, name: it.label, email: it.email, phone: it.phone };
    await c.query('savepoint one');
    try {
      const s = isStaff(it);
      if (s) { say({ ...out, result: 'skip-staff', why: `our own: ${s.name} is staff here` }); await c.query('release savepoint one'); continue; }
      const prospect = !it.own && !it.tags.includes('client') && !(await clientCompany(it.company));
      const tags = [...new Set([...it.tags, ...(prospect ? ['prospect'] : []), ...(it.own ? ['staff'] : [])])];
      let card = null, how = '';
      if (it.own) {
        // Our own account: never added; tagged staff when it is already in Contacts.
        const hit = await rows(`select p.id from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id
          where p.org_id=$1 and p.status<>'offboarded' and p.side not in ('staff','agent')
            and (($2<>'' and lower(btrim(coalesce(cp.email,'')))=$2) or (length($3)>=6 and right(regexp_replace(coalesce(cp.phone,''),'\\D','','g'),10)=$3))`,
        [job.org, it.email ?? '', last10(it.phone)]);
        if (hit.length > 1) { say({ ...out, result: 'check-by-hand', why: `our own account; ${hit.length} contacts have its e-mail or phone` }); await c.query('release savepoint one'); continue; }
        if (!hit.length) { say({ ...out, result: 'skip-own', why: 'our own account, not in Contacts' }); await c.query('release savepoint one'); continue; }
        card = { id: hit[0].id }; how = 'e-mail';
      } else {
        const body = Object.fromEntries(Object.entries({ name: it.label.slice(0, 120), email: it.email, phone: it.phone, company: it.company, tags,
          status: it.status, device: it.device, cameFrom: job.cameFrom,
          note: `Tester register (${job.register}, synced ${job.today}): added as ${STATUS_WORDS[it.status] ?? it.status}.${it.said ? ` ${it.said}.` : ''}${
            it.name ? '' : ' No name in the register: the e-mail stands in until someone adds it.'}`.slice(0, 2000) })
          .filter(([, v]) => v !== null && v !== undefined && v !== ''));
        const a = await call(ADD, valid.add, { params: {}, query: {}, body });
        if (a.result === 'created') { say({ ...out, result: 'created', id: a.contact.id, tags: a.contact.tags, status: a.contact.status }); await c.query('release savepoint one'); continue; }
        const all = [a.contact, ...a.candidates];
        const same = all.filter((x) => (it.email && (x.email ?? '').toLowerCase().trim() === it.email) || (last10(it.phone).length >= 6 && last10(x.phone) === last10(it.phone)));
        if (same.length > 1) { say({ ...out, result: 'check-by-hand', why: `${same.length} contacts have this e-mail or phone` }); await c.query('release savepoint one'); continue; }
        if (same.length === 1) { card = same[0]; how = it.email && (card.email ?? '').toLowerCase().trim() === it.email ? 'e-mail' : 'phone'; }
        else if (all.length === 1 && it.company && squash(all[0].company) === squash(it.company)) { card = all[0]; how = 'name and company'; }
        else { say({ ...out, result: 'check-by-hand', why: `only the name matches (${all.map((x) => x.company ?? 'no company').join(', ')})` }); await c.query('release savepoint one'); continue; }
      }
      card = (await rows(`select p.id,p.display_name name,cp.email,cp.phone,coalesce(cp.tags,'{}') tags,cp.contact_status status,cp.device,cp.came_from "cameFrom"
        from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id where p.id=$1`, [card.id]))[0];
      const add = tags.filter((t) => !card.tags.includes(t)), status = nextStatus(card.status, it.status);
      const body = { ...(add.length ? { addTags: add } : {}), ...(status ? { status } : {}), ...(!card.device && it.device ? { device: it.device } : {}),
        ...(!card.cameFrom ? { cameFrom: job.cameFrom } : {}), ...(!card.email && it.email ? { email: it.email } : {}), ...(!card.phone && it.phone ? { phone: it.phone } : {}) };
      const kept = it.status && !status && card.status && card.status !== it.status ? `status ${card.status} kept (register: ${it.status})` : '';
      if (!Object.keys(body).length) { say({ ...out, result: 'in-step', id: card.id, name: card.name, why: kept || undefined }); await c.query('release savepoint one'); continue; }
      const what = [add.length ? `tags + ${add.join(', ')}` : '', status ? `status ${card.status ?? 'none'} → ${status}` : '', body.device ? `phone they use: ${body.device}` : '',
        body.cameFrom ? `came from: ${body.cameFrom}` : '', body.email ? 'e-mail added' : '', body.phone ? 'phone added' : '', kept].filter(Boolean).join('; ');
      body.note = `Tester register (${job.register}, synced ${job.today}): ${what}.${it.said ? ` ${it.said}.` : ''}`.slice(0, 2000);
      const u = await call(UPDATE, valid.update, { params: { contactId: card.id }, query: {}, body });
      say({ ...out, result: 'updated', id: card.id, name: card.name, matched: how, changed: u.changed, why: what });
      await c.query('release savepoint one');
    } catch (e) {
      if (e?.refused) throw e;
      errors += 1;
      await c.query('rollback to savepoint one');
      say({ ...out, result: 'error', why: String(e?.message ?? e).slice(0, 400) });
    }
  }
  const testers = Object.fromEntries((await rows(`select coalesce(contact_status,'none') s,count(*)::int n from pulse.contact_profile
    where org_id=$1 and 'tester'=any(tags) group by 1 order by 1`, [job.org])).map((r) => [r.s, r.n]));
  const commit = job.apply && !errors;
  await c.query(commit ? 'commit' : 'rollback');
  if (errors) say({ kind: 'error', error: `${errors} row(s) failed; nothing was written`, testers });
  else say({ kind: 'end', applied: commit, testers });
} catch (e) {
  await c.query('rollback').catch(() => {});
  say({ kind: 'error', error: String(e?.message ?? e).slice(0, 600) });
  process.exitCode = 1;
} finally { await c.end(); }
if (errors) process.exitCode = 1;
