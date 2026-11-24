// QUOTE-LINKS (owner, 22 Nov 2026: "links go to pulse dot estate autopilots, which is not even what we use now"): a link a
// customer opens never points at the install's old address or this machine (tenant-context.ts customerOrigin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { customerOrigin } from '../dist/tenant-context.js';

const env = { PULSE_PUBLIC_URL: 'https://pulse.estateautopilots.com',
  PULSE_HOST_FAMILIES: JSON.stringify([{ name: 'vitals', app: 'app.vitalsos.ai', api: 'api.vitalsos.ai', mcp: 'mcp.vitalsos.ai', id: 'id.vitalsos.ai' }]) };

test('the install\'s old address and this machine become the brand address', () => {
  assert.equal(customerOrigin('https://pulse.estateautopilots.com', env), 'https://app.vitalsos.ai');
  assert.equal(customerOrigin('https://127.0.0.1', env), 'https://app.vitalsos.ai');
  assert.equal(customerOrigin('http://localhost:8081', env), 'https://app.vitalsos.ai');
  assert.equal(customerOrigin('not a url', env), 'https://app.vitalsos.ai');
});

test('a company\'s own address and the brand\'s hosts stay as they are; without a brand family nothing changes', () => {
  assert.equal(customerOrigin('https://pulse.wiselifee.com', env), 'https://pulse.wiselifee.com');
  assert.equal(customerOrigin('https://app.vitalsos.ai', env), 'https://app.vitalsos.ai');
  assert.equal(customerOrigin('https://pulse.estateautopilots.com', { PULSE_PUBLIC_URL: 'https://pulse.estateautopilots.com' }), 'https://pulse.estateautopilots.com');
});
