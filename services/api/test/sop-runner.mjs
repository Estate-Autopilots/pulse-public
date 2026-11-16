// SOP-WORKFLOW acceptance against the built API on a disposable synthetic tenant (tests/core/test_sop.py): the
// library, From Drive (sources read into steps with a confidence), import, edit with versions, statuses, pasted text,
// who may do what. Identities are Access e-mails of synthetic people.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};

try {
  // Members read the library; Drive and writing are leadership's.
  let r = await call('member', '/api/v0/sops'); eq(r.status, 200); eq(r.data.canEdit, false); eq(r.data.drive, null); eq(r.data.sops, []);
  eq((await call('member', '/api/v0/sops/drive')).status, 403);
  eq((await call('hr', '/api/v0/sops/drive')).status, 403, 'HR does not bring in SOPs');
  eq((await call('member', '/api/v0/sops', { title: 'x', doc: { steps: [{ title: 'a' }] } })).status, 403);
  eq((await call('member', '/api/v0/sops/parse', { text: '1. One\n2. Two\n3. Three' })).status, 403);

  // From Drive: each source read into SOP parts, best first.
  r = await call('lead', '/api/v0/sops/drive'); eq(r.status, 200);
  eq(r.data.counts.new, 2); eq(r.data.sources.map((s) => s.name), ['PGS Workflow & Responsibilities', 'Visit SOP']);
  const table = r.data.sources[0]; eq(table.parts.length, 1);
  const part = table.parts[0];
  eq(part.preview.map((x) => x.title), ['Internal Handover', 'Client Kick-off Call', 'Brand Alignment']);
  eq(part.ownerRole, 'PGS'); ok(part.confidence >= 0.75, `confidence ${part.confidence}`); eq(part.confidenceWords, 'High');
  ok(part.evidence.some((e) => /A table of 3 steps/.test(e)), part.evidence.join(' | '));
  eq(part.done, null); ok(!('doc' in part), 'the list carries a preview, not the whole document');
  const detail = await call('lead', `/api/v0/sops/drive/${table.id}`); eq(detail.status, 200);
  ok(detail.data.source.excerpt.startsWith('Phase 1'), 'the text it was read from');
  eq(detail.data.source.parts[0].doc.steps[1].slaHours, 48);
  ok(detail.data.people.PGS.some((x) => x.id === P.pgs) && detail.data.people.PGS.some((x) => x.id === P.pgs2), 'who holds the PGS role (Senior PGS too)');
  eq((await call('lead', `/api/v0/sops/drive/${table.id}/import`, { part: 3 })).status, 400);

  // Bring it in as read: active at once, with the source and confidence; a second time is refused.
  r = await call('lead', `/api/v0/sops/drive/${table.id}/import`, { part: 0 }); eq(r.status, 200); const sid = r.data.id;
  eq((await call('lead', `/api/v0/sops/drive/${table.id}/import`, { part: 0 })).status, 409);
  r = await call('member', `/api/v0/sops/${sid}`); eq(r.status, 200);
  eq(r.data.sop.status, 'active'); eq(r.data.sop.source, 'drive'); eq(r.data.canEdit, false); ok(!('sourceLink' in r.data.sop), 'members do not see where in Drive it came from');
  eq(r.data.summary.steps, 3); eq(r.data.summary.handoffs, 0, 'one role does every step');
  ok(r.data.people.PGS.length === 2, 'the lane shows the people who hold the role');
  r = await call('lead', `/api/v0/sops/${sid}`); eq(r.data.sop.sourceName, 'PGS Workflow & Responsibilities'); eq(r.data.sop.sourceChanged, false);
  r = await call('lead', '/api/v0/sops/drive?status=imported'); eq(r.data.sources[0].parts[0].done, sid);

  // Edit: hand the brand work to the designer, add an approval that can send it back. A new version; handoffs counted.
  const doc = (await call('lead', `/api/v0/sops/${sid}`)).data.sop.doc;
  doc.steps[2].role = 'Graphic Designer';
  doc.steps.push({ id: 'ok', title: 'Client approves the brand', kind: 'approval', role: 'Client', next: [{ to: 'go', label: 'Approved' }, { to: doc.steps[2].id, label: 'Send back' }] },
    { id: 'go', title: 'Launch', role: 'PGS', slaHours: 8 });
  r = await call('lead', `/api/v0/sops/${sid}`, { title: 'PGS Workflow', purpose: 'Start every client the same way', ownerRole: 'PGS', doc, status: 'active', note: 'Designer and approval' });
  eq(r.status, 200); eq(r.data.sop.version, 2); eq(r.data.summary.steps, 5); eq(r.data.summary.handoffs, 4, 'the send-back changes hands too');
  ok(r.data.edges.some((e) => e.label === 'Send back'), 'the send-back connection is kept');
  eq(r.data.versions.map((v) => v.version), [2, 1]);
  eq((await call('lead', `/api/v0/sops/${sid}`, { title: 'PGS Workflow', doc: { steps: [{ title: '' }] } })).status, 400, 'a step needs a name');
  eq((await call('lead', `/api/v0/sops/${sid}`, { title: 'PGS Workflow', doc: { steps: Array.from({ length: 151 }, (_, i) => ({ title: `s${i}` })) } })).status, 400);

  // Paste: read pasted text, save it as a draft (members do not see drafts).
  r = await call('lead', '/api/v0/sops/parse', { title: 'Visit', text: 'Client Visit – Process\n1. Site check\n   * Confirm within 24 hours\n2. Crew shortlisting (Coordinator)\n3. Client approval\n' });
  eq(r.status, 200); eq(r.data.parts[0].doc.steps.length, 3); eq(r.data.parts[0].doc.steps[1].role, 'Coordinator');
  r = await call('lead', '/api/v0/sops', { title: 'Visit', doc: r.data.parts[0].doc, status: 'draft', source: 'paste' }); eq(r.status, 200); const draft = r.data.id;
  r = await call('member', '/api/v0/sops'); eq(r.data.sops.map((s) => s.title), ['PGS Workflow']);
  eq(r.data.sops[0].shape.length, 5); eq(r.data.sops[0].shape[0].title, '', 'the card shape carries no step text');
  eq((await call('member', `/api/v0/sops/${draft}`)).status, 404);
  r = await call('lead', '/api/v0/sops'); eq(r.data.sops.length, 2); eq(r.data.drive.waiting, 1);

  // Not an SOP, and back again; statuses.
  const visit = (await call('lead', '/api/v0/sops/drive')).data.sources[0];
  eq((await call('lead', `/api/v0/sops/drive/${visit.id}/dismiss`, {})).status, 200);
  eq((await call('lead', '/api/v0/sops/drive?status=dismissed')).data.sources.map((s) => s.id), [visit.id]);
  eq((await call('lead', `/api/v0/sops/drive/${visit.id}/restore`, {})).status, 200);
  eq((await call('lead', `/api/v0/sops/${sid}/status`, { status: 'archived' })).status, 200);
  eq((await call('member', '/api/v0/sops')).data.sops, []);
  eq((await call('lead', `/api/v0/sops/${sid}`, { title: 'PGS Workflow', doc })).status, 400, 'restore before changing');
  eq((await call('lead', `/api/v0/sops/${sid}/status`, { status: 'draft' })).status, 200);
  eq((await call('admin', `/api/v0/sops/${sid}/status`, { status: 'active' })).status, 200, 'admins too');
  eq((await call('lead', '/api/v0/sops/roles')).data.roles.find((x) => x.role === 'PGS').n, 1);

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
  console.log(`sop-runner: ${checks} checks`);
} finally { await app.close(); await pool.end(); }
