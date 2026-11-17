// CA-ACCESS: the CA's access matrix at the API (accountant-access.ts). A CA reaches Finance read, their own desk writes
// (Verified / Ask, a comment, a month-close tick), their account, the switcher and their start-here guide; never HR,
// salaries, people, chats, tasks, settings, payroll or the owner's CA controls. The database tests
// (tests/core/test_ca_access.py) cover what the allowed routes return (salaries only with the owner's tick).
import assert from 'node:assert/strict';
import test from 'node:test';
import { accountantRoute } from '../dist/accountant-access.js';

const id = '00000000-0000-4000-8000-000000000001';

test('a CA reads Finance and writes only their own checks on the desk', () => {
  for (const [method, url, want] of [
    ['GET', '/api/v0/finance/desk', 'read'], ['GET', '/api/v0/finance/desk?pilot=synthetic', 'read'],
    ['GET', '/api/v0/finance/desk/files/synthetic-invoice?inline=1', 'read'], ['GET', '/api/v0/finance/desk/exports/gst?month=2026-10', 'read'],
    ['GET', '/api/v0/finance/desk/exports/tally', 'read'], ['GET', '/api/v0/erp/documents', 'read'], ['GET', `/api/v0/quotes/${id}`, 'read'],
    ['GET', '/api/v0/comp/totals', 'read'], ['HEAD', '/api/v0/finance/desk', 'read'],
    ['POST', '/api/v0/finance/desk/check', 'write'], ['POST', '/api/v0/finance/desk/note', 'write'], ['POST', '/api/v0/finance/desk/close', 'write'],
    ['GET', '/api/v0/me', 'self'], ['POST', '/api/v0/auth/account', 'self'], ['POST', '/api/v0/auth/logout', 'self'],
    ['POST', '/api/v0/account/switch', 'self'], ['POST', '/api/v0/account/accept', 'self'],
    ['GET', '/api/v0/account/onboarding', 'self'], ['POST', '/api/v0/account/onboarding', 'self'],
    ['GET', '/api/v0/account', 'self'], ['POST', '/api/v0/auth/join-peek', 'self'],
  ]) assert.equal(accountantRoute(method, url), want, `${method} ${url}`);
});

test('a CA never reaches salaries, HR, people, chats, tasks, settings or the owner’s controls', () => {
  for (const [method, url] of [
    // salaries and payroll (the CA sees monthly totals on the desk only)
    ['GET', '/api/v0/comp'], ['GET', '/api/v0/comp/people'], ['GET', `/api/v0/comp/people/${id}`], ['GET', '/api/v0/payroll'], ['GET', '/api/v0/payroll/runs'],
    ['GET', '/api/v0/people/pay'], ['GET', '/api/v0/finance/people-cost'], ['GET', '/api/v0/finance/live'], ['GET', '/api/v0/finance'],
    // HR
    ['GET', '/api/v0/hr'], ['GET', '/api/v0/hr/self'], ['GET', `/api/v0/people/${id}/hr`], ['GET', '/api/v0/me/hr'], ['GET', '/api/v0/attendance'], ['GET', '/api/v0/leave'],
    // people, work, chats, settings
    ['GET', '/api/v0/people'], ['GET', `/api/v0/people/${id}`], ['GET', '/api/v0/tasks'], ['GET', '/api/v0/chats'], ['GET', '/api/v0/settings/roles'],
    ['GET', '/api/v0/audit'], ['GET', '/api/v0/money'],
    // writes the CA must never make
    ['POST', '/api/v0/finance/desk/ca'], ['POST', '/api/v0/finance/desk/accountants'], ['POST', '/api/v0/finance/desk/approve-send'],
    ['POST', '/api/v0/account/invites'], ['POST', '/api/v0/erp/documents'], ['POST', '/api/v0/finance/source'], ['PUT', '/api/v0/finance/desk/check'],
    ['DELETE', '/api/v0/finance/desk/note'], ['GET', '/api/v0/finance/desk/check'], ['POST', '/api/v0/finance/desk/exports/gst'],
    ['GET', '/api/v0/account/invites'], ['POST', '/api/v0/account/leave'], ['GET', '/api/v0/finance/desk/../hr'],
    ['POST', '/api/v0/account'], ['GET', '/api/v0/account/profile'], ['POST', '/api/v0/auth/join'],
  ]) assert.equal(accountantRoute(method, url), null, `${method} ${url}`);
});
