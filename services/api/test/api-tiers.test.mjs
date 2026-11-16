// API-PLATFORM-2 (1595): each key's requests per minute follow its company's API tier (free 60, pro 300, business
// 1,200, enterprise 5,000), and a key whose tier changes starts a new window at the new figure. No database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenBudgets } from '../dist/v1-limits.js';

test('per-tier budgets: the tier\'s figure a minute, then limited with a reset in seconds', () => {
  let now = 0; const spend = tokenBudgets(() => now);
  for (const limit of [60, 300, 1200, 5000]) {
    const token = `key-${limit}`;
    for (let i = 0; i < limit; i++) assert.equal(spend('org', token, limit).limited, false, `${limit}: call ${i + 1}`);
    const over = spend('org', token, limit);
    assert.equal(over.limited, true); assert.equal(over.limit, limit); assert.equal(over.remaining, 0); assert.ok(over.reset >= 1 && over.reset <= 60);
  }
  // A tier change (an upgrade, or the grace ending) starts a new window at the new figure.
  const moved = spend('org', 'key-60', 300);
  assert.equal(moved.limited, false); assert.equal(moved.limit, 300);
  // Keys and companies have separate budgets; a minute later the window is fresh.
  assert.equal(spend('other-org', 'key-60', 60).limited, false);
  now += 60_000;
  assert.equal(spend('org', 'key-5000', 5000).limited, false);
});

test('without a tier figure the budget keeps the old 120', () => {
  const spend = tokenBudgets(() => 0);
  for (let i = 0; i < 120; i++) assert.equal(spend('org', 'k').limited, false);
  assert.equal(spend('org', 'k').limited, true);
});
