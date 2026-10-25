// Synthetic only. Run: node --experimental-transform-types tools/generate-document-key-vector.mjs
import { writeFile } from 'node:fs/promises';
import { bankContext, documentContext, parseKeyring, payContext, payrollContext, seal } from '../services/api/src/document-keys.ts';

const keyring = `synthetic-old ${Buffer.alloc(32, 17).toString('base64')}\nsynthetic-active ${Buffer.alloc(32, 42).toString('base64')}\n`;
const ring = parseKeyring(keyring), org = 'synthetic-org', person = 'synthetic-person';
const contexts = [documentContext(org, person, 'synthetic-id'), bankContext(org, person),
  payContext(org, person, 'change', 'synthetic-change'), payrollContext(org, 'totals', 'synthetic-run'),
  `${org}/ai/connection/synthetic-connection`, `${org}/ai/workspace/synthetic-workspace`,
  `${org}/sales-xray/client/https://synthetic.invalid`, `${org}/${person}/sales-xray/access`,
  `${org}/${person}/sales-xray/refresh`, `${org}/lead/synthetic-lead/media/synthetic-media`];
const vectors = contexts.map((context, i) => {
  const plain = i === 0 ? Buffer.alloc(0) : Buffer.concat([Buffer.from('Synthetic portability: नमस्ते\n'), Buffer.from([0, 1, 128, 255])]);
  const s = seal(i % 2 ? ring : { ...ring, active: 'synthetic-old' }, plain, context);
  return { context, plain: plain.toString('base64'), keyId: s.keyId, dataKey: s.dataKey.toString('base64'), data: s.data.toString('base64') };
});
const fixture = { generator: 'tools/generate-document-key-vector.mjs', keyring, vectors };
await writeFile(new URL('../packages/sdk-py/tests/fixtures/document-keys-v1.json', import.meta.url), JSON.stringify(fixture) + '\n');
console.log(`Generated ${vectors.length} synthetic vectors; key fingerprints available through pulse_sdk.document_keys.`);
