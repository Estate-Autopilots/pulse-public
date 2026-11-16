// AGENT-MEMORY (1840): out of budget it says so in words, with who can add more and the link (never silence).
import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetLink, budgetWords } from '../dist/agent-budget.js';

const agent = { id: '00000000-0000-0000-0000-0000000000a1', name: 'Pip (test)' };
const base = { share: 100, key: 'month:2026-11', day: { used: 1000, limit: 160000, share: 1 }, month: { used: 500000, limit: 500000, share: 100 }, org: null,
  owner: { id: '00000000-0000-0000-0000-0000000000b2', name: 'Asha Rao' }, canAdd: false };

test('this month used up: the person hears the owner and the link', () => {
  const w = budgetWords({ ...base, level: 'out', period: 'month' }, agent, 'https://pulse.example.com/');
  assert.equal(w.link, 'https://pulse.example.com/people/00000000-0000-0000-0000-0000000000a1?tab=ai&s=model');
  assert.equal(w.reply, `I've used this month's budget. Asha Rao can add more here: ${w.link} I'll answer this as soon as it's added.`);
  assert.match(w.owner, /^Pip \(test\) here: I've used this month's budget \(5,00,000 of 5,00,000 tokens\), so people who write to me are waiting\. Add more here: https:/);
});

test('today, the company and its plan are named for what they are', () => {
  assert.match(budgetWords({ ...base, level: 'out', period: 'day' }, agent, 'https://x.example').reply, /^I've used today's budget\. Asha Rao can add more/);
  assert.match(budgetWords({ ...base, level: 'out', period: 'org' }, agent, 'https://x.example').reply, /^I've used the company's AI budget for today\./);
  assert.match(budgetWords({ ...base, level: 'out', period: 'plan' }, agent, 'https://x.example').reply, /the company has used its AI plan/);
  assert.match(budgetWords({ ...base, level: 'out', period: 'day', owner: { id: null, name: null } }, agent, 'https://x.example').reply, /An admin can add more here/);
});

test('at 80% the owner is warned with the share and the link', () => {
  const w = budgetWords({ ...base, level: 'warn', period: 'month', share: 82, month: { used: 410000, limit: 500000, share: 82 } }, agent, 'https://x.example');
  assert.equal(w.owner, `Pip (test) here: I've used 82% of this month's budget (4,10,000 of 5,00,000 tokens). Add more here before I run out: ${budgetLink(agent.id, 'https://x.example')}`);
});
