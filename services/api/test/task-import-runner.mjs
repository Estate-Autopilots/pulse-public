// EST-2577: actual route, transaction rollback, concurrent connections and RLS; no browser or real people.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), owner = new Pool(JSON.parse(process.env.TEST_OWNER_CONFIG));
const app = createApp(pool, pool), E = JSON.parse(process.env.TEST_IDS);
async function own(sql, args = [], org = E.org) {
  const c = await owner.connect();
  try { await c.query('begin'); await c.query('set local role pulse_owner'); await c.query("select set_config('pulse.org_id',$1,true)", [org]);
    const r = await c.query(sql, args); await c.query('commit'); return r.rows;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
async function call(body, expected = 200, email = process.env.TEST_MEMBER, url = '/api/v0/tasks/import') {
  const r = await app.inject({ method: 'POST', url, payload: body, headers: { 'cf-access-authenticated-user-email': email } });
  assert.equal(r.statusCode, expected, r.body); return r.json();
}
const payload = (rows, extra = {}) => ({ importKey: randomUUID(), preview: true, rows, ...extra });
const snapshot = () => own('select (select count(*)::int from pulse.task) tasks,(select count(*)::int from pulse.task_import) imports');
const codes = r => r.problems.map(p => p.code);
try {
  const before = await snapshot();
  const aliases = ['todo', 'to do', 'new', 'open', 'doing', 'in progress', 'wip', 'started', 'blocked', 'waiting', 'on hold', 'done', 'complete', 'finished'];
  const priorities = ['p1', 'p2', 'p3', 'p4', 'urgent', 'high', 'normal', 'low'];
  let p = await call(payload(aliases.map((status, i) => ({ title: `Alias ${i}`, status, priority: priorities[i % 8] }))));
  assert.deepEqual(p.rows.map(r => r.status), ['open', 'open', 'open', 'open', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'blocked', 'blocked', 'blocked', 'done', 'done', 'done']);
  assert.deepEqual(p.rows.slice(0, 8).map(r => r.priority), ['urgent', 'high', 'normal', 'low', 'urgent', 'high', 'normal', 'low']);
  assert.ok(p.rows.every(r => !r.problems.length));
  p = await call(payload([{ title: 'Default row' }, { title: 'Names', assignee: 'Editor One', project: 'Shared project name' },
    { title: 'Ambiguous', assignee: 'Editor', due: '03/04/2030' }, { title: 'No match', assignee: 'Foreign Only', project: 'Foreign project' },
    { title: 'Foreign ids', assigneeId: E.foreignPerson, projectId: E.foreignProject }]));
  assert.deepEqual(p.rows[0].defaults, ['status', 'assignee', 'project', 'due', 'priority']);
  assert.equal(p.rows[1].assignee.id, E.member); assert.equal(p.rows[1].project.id, E.project); assert.equal(p.rows[1].assignee.isAgent, false);
  assert.deepEqual(codes(p.rows[2]), ['ambiguousAssignee', 'ambiguousDate']); assert.equal(p.rows[2].dueOn, '2030-04-03');
  assert.deepEqual(p.rows[2].candidates.assignee.map(x => x.id).sort(), [E.member, E.head].sort());
  for (const r of p.rows.slice(3)) assert.deepEqual(codes(r), ['unknownAssignee', 'unknownProject']);
  p = await call(payload([{ title: 'ISO', due: '2030-02-28' }, { title: 'Day month', due: '23 Oct' }, { title: 'Weekday', due: 'friday' },
    { title: 'Impossible', due: '2030-02-30' }, { title: 'Trailing junk', due: 'friday nonsense' }, { title: 'Impossible numeric', due: '31/02/2030' }]));
  assert.ok(p.rows.slice(0, 3).every(r => r.dueOn && !r.problems.length));
  assert.ok(p.rows.slice(3).every(r => codes(r).includes('invalidDate')));
  assert.equal((await call(payload([{ title: 'US date', due: '03/04/2030' }], { dateOrder: 'mdy' }))).rows[0].dueOn, '2030-03-04');
  assert.deepEqual(await snapshot(), before, 'all previews leave tasks and receipts unchanged');
  const extraProject = (await own("insert into pulse.project(org_id,registry_no,name,title) select $1,max(registry_no)+1,'Shared project sibling','Shared project sibling' from pulse.project returning id", [E.org]))[0].id;
  p = await call(payload([{ title: 'Ambiguous project', project: 'Shared project' }])); assert.ok(codes(p.rows[0]).includes('ambiguousProject')); assert.equal(p.rows[0].candidates.project.length, 2);
  assert.equal((await call(payload([{ title: 'Exact project', project: 'Shared project name' }]))).rows[0].project.id, E.project);
  const existing = await call({ title: '  Duplicate   title ', projectId: E.project }, 200, process.env.TEST_MEMBER, '/api/v0/work/tasks');
  p = await call(payload([{ title: 'duplicate title', projectId: E.project }, { title: 'Ｄuplicate title' }, { title: 'DUPLICATE TITLE' }]));
  assert.ok(p.rows.every(r => r.duplicateOf === existing.id)); assert.equal(p.rows[1].duplicateInPaste, 0); assert.equal(p.rows[2].duplicateInPaste, 0);
  assert.equal((await call(payload([{ title: 'Duplicate title', projectId: extraProject }]))).rows[0].duplicateOf, null);
  const badBefore = await snapshot();
  const bad = await call(payload([{ title: 'Good row' }, { title: 'Bad row', status: 'invented' }], { preview: false }), 400);
  assert.ok(codes(bad.rows[1]).includes('invalidStatus')); assert.deepEqual(await snapshot(), badBefore);
  for (const row of [{ title: 'x'.repeat(301) }, { title: '' }, { title: 'Alias commit', status: 'doing' }, { title: 'Priority commit', priority: 'p1' },
    { title: 'Wrong person', assigneeId: E.foreignPerson }, { title: 'Wrong project', projectId: E.foreignProject }, { title: 'Ambiguous date', due: '03/04/2030' }])
    await call(payload([{ title: 'Should roll back' }, row], { preview: false }), 400);
  assert.deepEqual(await snapshot(), badBefore);
  await own("create function pulse.import_test_refusal() returns trigger language plpgsql as $$ begin if new.title='Reject second import row' then raise exception 'Synthetic import refusal' using errcode='22023'; end if; return new; end $$; create trigger import_test_refusal before insert on pulse.task for each row execute function pulse.import_test_refusal()");
  try { await call(payload([{ title: 'First write rolls back' }, { title: 'Reject second import row' }], { preview: false }), 400); assert.deepEqual(await snapshot(), badBefore, 'a database failure after the first create rolls back tasks and receipt'); }
  finally { await own('drop trigger import_test_refusal on pulse.task; drop function pulse.import_test_refusal()'); }
  await call(payload(Array.from({ length: 201 }, () => ({ title: 'Too many' }))), 400);
  assert.equal((await call(payload(Array.from({ length: 200 }, (_, i) => ({ title: `${i} ${'界'.repeat(295)}` }))))).rows.length, 200);
  const unicode = await call(payload([{ title: '😀'.repeat(300) }], { preview: false })); assert.equal((await own('select title from pulse.task where id=$1', [unicode.created[0].id]))[0].title, '😀'.repeat(300));
  const batch = payload([{ title: 'Imported once', status: 'in_progress', priority: 'high' }, { title: '', skip: true }], { preview: false });
  const first = await call(batch), replay = await call({ ...batch, rows: [{ title: 'Changed retry body' }] });
  assert.equal(first.replay, false); assert.equal(replay.replay, true); assert.deepEqual(replay.created, first.created); assert.deepEqual(first.skipped, [1]);
  const saved = (await own('select status,assignee_person_id assignee from pulse.task where id=$1', [first.created[0].id]))[0];
  assert.equal(saved.status, 'in_progress'); assert.equal(saved.assignee, E.member);
  await call(batch, 409, process.env.TEST_HEAD);
  const concurrent = payload([{ title: 'Concurrent submit' }], { preview: false });
  const pair = await Promise.all([call(concurrent), call(concurrent)]);
  assert.deepEqual(pair[0].created, pair[1].created); assert.deepEqual(pair.map(x => x.replay).sort(), [false, true]);
  assert.equal((await own("select count(*)::int n from pulse.task where title='Concurrent submit'"))[0].n, 1);
  const ask = await call(payload([{ title: 'Request outside authority', assigneeId: E.head }], { preview: false }));
  assert.ok(ask.created[0].asked?.id); assert.equal((await own('select assignee_person_id a from pulse.task where id=$1', [ask.created[0].id]))[0].a, E.member);
  const direct = await call(payload([{ title: 'Direct assignment', assigneeId: E.member }], { preview: false }), 200, process.env.TEST_HEAD);
  assert.equal(direct.created[0].asked, null);
  const aiPreview = await call(payload([{ title: 'AI work', assignee: 'Import Helper AI' }]), 200, 'admin@estateautopilots.com');
  assert.equal(aiPreview.rows[0].assignee.isAgent, true); assert.equal(aiPreview.rows[0].assignee.id, E.agent);
  const ai = await call(payload([{ title: 'AI direct assignment', assigneeId: E.agent }], { preview: false }), 200, 'admin@estateautopilots.com');
  assert.equal(ai.created[0].asked, null); assert.equal((await own('select assignee_person_id a from pulse.task where id=$1', [ai.created[0].id]))[0].a, E.agent);
  const c = await pool.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true),set_config('pulse.viewer_id',$2,true)", [E.otherOrg, E.foreignPerson]);
    assert.equal((await c.query('select * from pulse.task_import where import_key=$1', [batch.importKey])).rowCount, 0);
    await assert.rejects(c.query('insert into pulse.task_import(org_id,import_key,creator_id,result) values($1,$2,$3,$4)', [E.org, randomUUID(), E.foreignPerson, '{}']), { code: '42501' });
    await c.query('rollback');
  } finally { c.release(); }
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ ok: true }));
} finally { await app.close(); await pool.end(); await owner.end(); }
