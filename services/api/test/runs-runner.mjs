// SOP-WORKFLOW part 4 acceptance (tests/core/test_sop.py::test_runs_overview): where runs stand. A late step (past its
// SLA), a run held up because nobody holds a step's role, a finished run, and the slowest steps; each seen only by
// those who may see the run.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const domain = process.env.TEST_DOMAIN; const S = JSON.parse(process.env.TEST_SETUP);
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url) => { const r = await app.inject({ url, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID() } }); return { status: r.statusCode, data: r.json() }; };
try {
  let r = await call('kedab', '/api/v0/workflows/runs'); eq(r.status, 200);
  eq(r.data.counts, { running: 2, late: 1, stuck: 1, finishedWeek: 1 });
  eq(r.data.late.map((x) => [x.runId, x.title]), [[S.lateRun, 'Call the client']]); ok(r.data.late[0].lateHours >= 2.9, String(r.data.late[0].lateHours));
  eq(r.data.stuck.map((x) => [x.runId, x.why]), [[S.stuckRun, 'Nobody to do it: choose someone']]);
  eq(r.data.slow.map((x) => [x.title, x.n, x.late]), [['Brief', 1, 1]]); ok(r.data.slow[0].hours >= 5, 'five hours');
  r = await call('kedab', `/api/v0/workflows/runs?projectId=${S.project}`); eq(r.data.runs.map((x) => x.id).sort(), [S.lateRun, S.doneRun].sort());
  r = await call('ishaan', '/api/v0/workflows/runs'); eq(r.data.counts.running, 0, 'nothing of theirs');
  r = await call('asha', '/api/v0/workflows/runs'); eq(r.data.late.map((x) => x.runId), [S.lateRun], 'Asha has the late step');
  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
} finally { await app.close(); await pool.end(); }
