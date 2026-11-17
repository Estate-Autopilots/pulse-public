import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectNotices } from './notices-collect.mjs';
import { NOTICES } from './notices.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

test('EST-1197: the trusted sentences are exactly the ones Pulse’s source writes (node apps/web/app/lib/notices-collect.mjs)', () => {
  const { notices, dynamic } = collectNotices(root);
  assert.deepEqual(dynamic, [], 'a page that builds its Message text at run time passes it as notice=');
  assert.deepEqual([...NOTICES], notices, 'notices.mjs is out of date: run node apps/web/app/lib/notices-collect.mjs');
});

test('EST-1197: no trusted sentence carries a credential, an address or markup', () => {
  for (const s of NOTICES) {
    assert.doesNotMatch(s, /[{}<>`]|https?:\/\/|\b(bearer|basic)\s+\S{6,}|\b(authori[sz]ation|x-pulse-[\w-]+|cookie|token|secret|api[ _-]?key)\s*[:=]|-----BEGIN|\b\d{1,3}(\.\d{1,3}){3}\b|\blocalhost:\d/i, s);
  }
});

test('EST-1197: a page’s own words and the API’s refusals are both on the list; values built at run time are not', () => {
  for (const s of ['Only an admin imports WhatsApp history. The owner operates real imports.', 'Admin access required', 'Chats are off for your organisation.', 'Access denied for this account',
    'Client accounts can open only their released portal work.', 'Sign in with the client login your project team issued.']) assert.ok(NOTICES.has(s), s);
  for (const s of ['Not Found', 'Please check your request', 'This form was sent ; the step is done.']) assert.ok(!NOTICES.has(s), s);
});

test('EST-1197: a SQL function’s fixed 403/404 refusal is on the list, both branches of a CASE included; one built from values is not', () => {
  // db/migrations/0190_erp_invoice.sql: raise exception '%', case when p_write then '…' else '…' end using errcode='42501'
  for (const s of ['ERP is for leadership, Finance and the Accountant', 'Invoicing is for leadership and the Finance role']) assert.ok(NOTICES.has(s), s);
  // 0153_work_domains_pool.sql builds this one from a value; 0350_chat_history_import.sql raises '%' with a variable.
  for (const s of ['This task is in the pool for %', 'This task is in the pool for the company']) assert.ok(!NOTICES.has(s), s);
  assert.ok(![...NOTICES].some((s) => s.includes('%')), 'no sentence keeps a % placeholder');
});
