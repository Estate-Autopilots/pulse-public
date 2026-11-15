// TG-VOICE (7 Nov 2026): an AI employee's key picks its organisation on the shared install whether it comes in its own
// header or as API v1's bearer (the runtime's Pulse tools call /api/v1/mcp with it). Synthetic keys only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentKeyFrom } from '../dist/agents.js';

const KEY = `pak_0a1b2c3d_${'e'.repeat(64)}`;

test('the key in its own header or as the bearer picks the organisation; anything else does not', () => {
  assert.equal(agentKeyFrom({ 'x-pulse-agent-key': KEY }), KEY);
  assert.equal(agentKeyFrom({ authorization: `Bearer ${KEY}` }), KEY);
  assert.equal(agentKeyFrom({ 'x-pulse-agent-key': 'pak_short' }), null);
  assert.equal(agentKeyFrom({ authorization: `Bearer ${KEY}x` }), null);
  assert.equal(agentKeyFrom({ authorization: 'Bearer ppt_' + 'a'.repeat(43) }), null);
  assert.equal(agentKeyFrom({ authorization: `Basic ${KEY}` }), null);
  assert.equal(agentKeyFrom({}), null);
});
