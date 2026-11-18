import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { folderRulesSummary } from '../dist/folder-rules.js';

test('folder rule summary normalizes existing 0045 documents and reports counts only', () => {
  const summary = folderRulesSummary([{
    doc_key: 'ea-editor-config',
    version: 7,
    body: {
      index_rules: [{ match: 'approved videos?', kind: 'final' }],
      creative_type_rules: { folder_path: [{ match: 'vovs?', type: 'vov' }] },
      file_name: { legacy_type_hints: { model: 'MV' } },
    },
  }], 'synthetic-org');

  assert.equal(summary.valid, true);
  assert.deepEqual(summary.documents, [{ doc_key: 'ea-editor-config', version: 7 }]);
  assert.equal(summary.counts.index_rules, 1);
  assert.equal(summary.counts.exclusions, 5);
  assert.equal(summary.counts.creative_types, 1);
  assert.equal(summary.counts.legacy_type_hints, 1);
  assert.equal(JSON.stringify(summary).includes('file name'), false);
});

test('folder rule summary rejects unknown keys and invalid regular expressions', () => {
  const summary = folderRulesSummary([{
    doc_key: 'northwind-rules',
    version: 1,
    body: { schema_version: 1, unexpected: true, index_rules: [{ match: '[', kind: 'draft' }] },
  }], 'northwind-org');

  assert.equal(summary.valid, false);
  assert.ok(summary.errors.some(error => error.includes('unexpected')));
  assert.ok(summary.errors.some(error => error.includes('invalid regular expression')));
});

test('a missing exclusions field in a later document preserves an earlier exclusions list', () => {
  const summary = folderRulesSummary([
    { doc_key: 'a-x', version: 1, body: { schema_version: 1, exclusions: ['archive'] } },
    { doc_key: 'b-y', version: 1, body: {
      schema_version: 1, index_rules: [{ match: 'handoff', kind: 'final' }],
    } },
  ], 'northwind-org');

  assert.equal(summary.valid, true);
  assert.equal(summary.counts.exclusions, 1);
});

test('folder rules admin endpoint is admin-only and returns the same counts-only summary', async () => {
  const calls = [];
  const previousPublicLogin = process.env.PULSE_PUBLIC_LOGIN_ENABLED;
  process.env.PULSE_PUBLIC_LOGIN_ENABLED = '0';
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('pulse.auth_enforcement')) return { rows: [{ blocked: false }] };
      if (['begin', 'commit', 'rollback'].includes(sql.trim().toLowerCase()) || sql.includes('set_config')) return { rows: [] };
      if (sql.includes('select p.id person,p.display_name name')) {
        const admin = params[0] === 'admin@example.test';
        return { rows: [{ person: null, name: 'Synthetic Admin', status: 'active', pod: null, username: null,
          accounts: [params[0]], roles: admin ? ['admin'] : ['person'] }] };
      }
      if (sql.includes('select doc_key,version,body from pulse.tenant_config')) return { rows: [{
        doc_key: 'northwind-folder-rules', version: 2,
        body: { schema_version: 1, index_rules: [{ match: 'handoff', kind: 'final' }] },
      }] };
      if (sql.includes('pulse.audit_signin')) return { rows: [] };
      throw new Error(`Unexpected synthetic query: ${sql}`);
    },
    release() {},
  };
  const app = createApp({ query: async () => ({ rows: [] }) }, { connect: async () => client }, undefined,
    { readOrg: async () => '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75' });
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/v0/admin/config/folder-rules',
      headers: { 'cf-access-authenticated-user-email': 'member@example.test' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.some(({ sql }) => sql.includes('select doc_key,version,body from pulse.tenant_config')), false);

    const allowed = await app.inject({ method: 'GET', url: '/api/v0/admin/config/folder-rules',
      headers: { 'cf-access-authenticated-user-email': 'admin@example.test' } });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), {
      org: '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75',
      documents: [{ doc_key: 'northwind-folder-rules', version: 2 }],
      valid: true,
      errors: [],
      counts: { index_rules: 1, exclusions: 5, design_type_rules: 0, creative_types: 0,
        legacy_type_hints: 0, project_paths: 0, pods: 0, subfolders: 0 },
    });
    assert.equal(JSON.stringify(allowed.json()).includes('fileName'), false);
  } finally {
    await app.close();
    if (previousPublicLogin === undefined) delete process.env.PULSE_PUBLIC_LOGIN_ENABLED;
    else process.env.PULSE_PUBLIC_LOGIN_ENABLED = previousPublicLogin;
  }
});
