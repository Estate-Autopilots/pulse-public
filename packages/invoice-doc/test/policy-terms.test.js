// AGREEMENTS (T1.2.1): a published policy's key terms, the steps of its acceptance view. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyTerms } from '../src/agreement-text.js';

// The shape HR-PEOPLE's pay policy document has (apps/web/app/people/pay/policy-doc.mjs payPolicyDoc).
const PAY = `# Pay policy

Kedab Studio pays everyone the same way. This page says how.

## 1. Who approves pay
Leadership approves every salary change.

## 2. Probation and offers
- 90 days of probation.
- An offer stays open 7 days.

## 3. Notice
15 days in probation, 30 days after.

### Exceptions
Leadership may shorten it.

## 4. A day's pay, leave and advances
A day's pay is the monthly gross divided by 30.

## 5. How your salary is split
| Part | Share |
| --- | --- |
| Basic | 50% |

## What happens next
Ask HR if anything is unclear.
`;

test('a "## " heading starts a term; the title, the opening words and "What happens next" are not terms', () => {
  const p = policyTerms(PAY);
  assert.equal(p.intro, 'Kedab Studio pays everyone the same way. This page says how.');
  assert.deepEqual(p.terms.map((t) => [t.key, t.number, t.title]), [
    ['t1-who-approves-pay', 1, 'Who approves pay'],
    ['t2-probation-and-offers', 2, 'Probation and offers'],
    ['t3-notice', 3, 'Notice'],
    ['t4-a-day-s-pay-leave-and-advances', 4, "A day's pay, leave and advances"],
    ['t5-how-your-salary-is-split', 5, 'How your salary is split'],
  ]);
  assert.match(p.terms[2].text, /### Exceptions\nLeadership may shorten it\.$/, 'a deeper heading stays inside its term');
  assert.match(p.terms[4].text, /\| Basic \| 50% \|/);
  assert.deepEqual(p.closing, { title: 'What happens next', text: 'Ask HR if anything is unclear.' });
});

test('the same text always gives the same terms (the API checks the ticks against them)', () => {
  assert.deepEqual(policyTerms(PAY), policyTerms(PAY.replace(/\n/g, '\r\n')));
});

test('a policy written as numbered lines (no "## ") uses the agreement headings', () => {
  const p = policyTerms('Synthetic Studio leave policy\n\n1. Leave entitlement\nTwelve days a year.\n\n2. Applying for leave\nAsk your manager first.\n');
  assert.equal(p.intro, 'Synthetic Studio leave policy');
  assert.deepEqual(p.terms.map((t) => [t.number, t.title, t.text]), [[1, 'Leave entitlement', 'Twelve days a year.'], [2, 'Applying for leave', 'Ask your manager first.']]);
  assert.equal(p.closing, null);
});

test('a "## " line inside a code block is not a heading', () => {
  const p = policyTerms('## One\nWords\n```\n## not a term\n```\n## Two\nMore');
  assert.deepEqual(p.terms.map((t) => t.title), ['One', 'Two']);
});

test('a policy with no headings is one term, the whole text; an empty one has none', () => {
  assert.deepEqual(policyTerms('Be kind to each other.\nAsk for help.'), { intro: '', terms: [{ key: 't1-policy', number: null, title: '', text: 'Be kind to each other.\nAsk for help.' }], closing: null });
  assert.deepEqual(policyTerms(''), { intro: '', terms: [], closing: null });
});
