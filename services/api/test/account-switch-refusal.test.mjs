// BUGFIX #29: switching company from a company's own sign-in is refused by ACCOUNT-META (2125) with the hint
// personal_sign_in. The API keeps that reason as the answer's code so the switcher asks "Confirm it's you" (POST
// account/prove) instead of doing nothing; other refusals keep their plain status and no code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { plain } from '../dist/accounts.js';

const pg = (code, message, hint) => Object.assign(new Error(message), { code, hint });
const refusal = async (err) => { try { await plain(async () => { throw err; }); } catch (e) { return e; } assert.fail('expected a refusal'); };

test('the company-only switch refusal carries personal_sign_in as its code', async () => {
  const e = await refusal(pg('42501', 'To open your other companies, sign in as yourself: with your own e-mail or your Pulse password. A company\'s sign-in opens that company only.', 'personal_sign_in'));
  assert.equal(e.statusCode, 403);
  assert.equal(e.publicCode, 'personal_sign_in');
  assert.match(e.message, /sign in as yourself/);
});

test('other refusals keep their status and no code', async () => {
  const e = await refusal(pg('42501', 'You are not a member of that organisation'));
  assert.equal(e.statusCode, 403);
  assert.equal(e.publicCode, undefined);
  const dup = await refusal(pg('23505', 'Taken'));
  assert.equal(dup.statusCode, 409);
});
