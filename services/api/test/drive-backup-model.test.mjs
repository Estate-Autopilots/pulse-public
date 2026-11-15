// COMPANY-OPS: the Drive backup's pure parts, and its Drive client against a fake Google (no network, no real key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { docPrint, driveWords, folderIdFrom, localDayHour, multipart, nightlyDue, parentsFirst, parseServiceAccount } from '../dist/drive-backup-model.js';
import { driveClient } from '../dist/drive-backup.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = JSON.stringify({ type: 'service_account', client_email: 'user-a2b701b4@org-01e0a5.example', private_key: KEY });

test('the service account key: JSON or base64; anything else is "not connected"', () => {
  assert.equal(parseServiceAccount(SA)?.email, 'user-a2b701b4@org-01e0a5.example');
  assert.equal(parseServiceAccount(Buffer.from(SA).toString('base64'))?.email, 'user-a2b701b4@org-01e0a5.example');
  assert.equal(parseServiceAccount(''), null);
  assert.equal(parseServiceAccount('{"type":"authorized_user"}'), null);
  assert.equal(parseServiceAccount('not json'), null);
});

test('the Drive folder from a pasted link or id', () => {
  assert.equal(folderIdFrom('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing'), '1AbCdEfGhIjKlMnOp');
  assert.equal(folderIdFrom('https://drive.google.com/drive/u/0/folders/0ABcdEFghIJk_lmN-9'), '0ABcdEFghIJk_lmN-9');
  assert.equal(folderIdFrom('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'), '1AbCdEfGhIjKlMnOp');
  assert.equal(folderIdFrom('1AbCdEfGhIjKlMnOp'), '1AbCdEfGhIjKlMnOp');
  assert.equal(folderIdFrom('https://example.test/'), null);
  assert.equal(folderIdFrom(''), null);
});

test('folders parents first; a folder whose parent is hidden goes to the top; loops do not hang', () => {
  const out = parentsFirst([{ id: 'c', parentId: 'b' }, { id: 'b', parentId: 'a' }, { id: 'a', parentId: null }, { id: 'x', parentId: 'hidden' }, { id: 'p', parentId: 'q' }, { id: 'q', parentId: 'p' }]);
  assert.deepEqual(out.map((f) => f.id).slice(0, 3), ['a', 'b', 'c']);
  assert.equal(out.find((f) => f.id === 'c').under, 'b');
  assert.equal(out.find((f) => f.id === 'x').under, null);
  assert.equal(out.length, 6);
});

test('a doc is copied again only when its version, title or folder changed', () => {
  const d = { version: 3, updatedAt: '2026-11-10T04:00:00Z', title: 'Plan', folderId: null };
  assert.equal(docPrint(d), docPrint({ ...d }));
  assert.notEqual(docPrint(d), docPrint({ ...d, version: 4 }));
  assert.notEqual(docPrint(d), docPrint({ ...d, title: 'Plan 2' }));
  assert.notEqual(docPrint(d), docPrint({ ...d, folderId: '11111111-1111-4111-8111-111111111111' }));
});

test('nightly: from 2 a.m. company time, once a day, a failed try again after 3 hours', () => {
  const tz = 'Asia/Kolkata', at = (iso) => new Date(iso);
  assert.deepEqual(localDayHour(at('2026-11-10T20:00:00Z'), tz), { day: '2026-11-11', hour: 1 });
  assert.equal(nightlyDue(at('2026-11-10T20:00:00Z'), tz, null, null), false); // 1:30 a.m. IST
  assert.equal(nightlyDue(at('2026-11-10T21:00:00Z'), tz, null, null), true); // 2:30 a.m. IST, never ran
  const okToday = at('2026-11-10T20:45:00Z');
  assert.equal(nightlyDue(at('2026-11-11T05:00:00Z'), tz, { startedAt: okToday, finishedAt: okToday, ok: true }, okToday), false);
  const failed = { startedAt: at('2026-11-10T21:00:00Z'), finishedAt: at('2026-11-10T21:05:00Z'), ok: false };
  assert.equal(nightlyDue(at('2026-11-10T22:00:00Z'), tz, failed, null), false);
  assert.equal(nightlyDue(at('2026-11-11T00:30:00Z'), tz, failed, null), true);
  assert.equal(nightlyDue(at('2026-11-10T21:30:00Z'), tz, { startedAt: at('2026-11-10T21:00:00Z'), finishedAt: null, ok: null }, null), false);
});

test('multipart body and Drive refusals in plain words', () => {
  const b = multipart({ name: 'a.pdf', parents: ['p'] }, 'application/pdf', new Uint8Array([37, 80, 68, 70]), 'B').toString();
  assert.ok(b.startsWith('--B\r\ncontent-type: application/json'));
  assert.ok(b.includes('{"name":"a.pdf","parents":["p"]}') && b.includes('%PDF') && b.endsWith('--B--'));
  assert.match(driveWords(404, 'notFound'), /can't see that Drive folder.*Content manager/);
  assert.match(driveWords(403, 'storageQuotaExceeded'), /shared drive/);
  assert.match(driveWords(403, 'insufficientFilePermissions'), /may not add files.*Content manager/);
  assert.match(driveWords(503, ''), /busy/);
});

test('the Drive client signs in, makes folders and files, updates in place and starts again when a file was binned', async () => {
  const sa = parseServiceAccount(SA), calls = [];
  const files = new Map([['root-folder-0001', { id: 'root-folder-0001', name: 'Backups', parents: [], trashed: false }]]);
  let n = 0;
  const fake = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'oauth2.googleapis.com') { assert.match(String(init.body), /grant_type=urn%3Aietf/); return json(200, { access_token: 'tok', expires_in: 3600 }); }
    assert.equal(init.headers.authorization, 'Bearer tok');
    const id = u.pathname.split('/').pop();
    if (method === 'GET') { const f = files.get(id); return f ? json(200, f) : json(404, { error: { errors: [{ reason: 'notFound' }] } }); }
    if (method === 'POST') {
      const text = typeof init.body === 'string' ? init.body : Buffer.from(await init.body.arrayBuffer()).toString();
      const meta = JSON.parse(text.includes('--pulse-') ? text.split('\r\n\r\n')[1].split('\r\n')[0] : text);
      const f = { id: `new-file-${String(++n).padStart(6, '0')}`, name: meta.name, parents: meta.parents, trashed: false }; files.set(f.id, f); return json(200, f);
    }
    if (method === 'PATCH') { const f = files.get(id); if (u.searchParams.get('addParents')) f.parents = [u.searchParams.get('addParents')]; return json(200, f); }
    return json(400, {});
  };
  const d = driveClient(sa, fake);
  assert.equal(await d.check('root-folder-0001'), 'Backups');
  await assert.rejects(d.check('missing-folder-01'), /drive 404/);
  const folder = await d.folder('01 Registration', 'root-folder-0001', null);
  assert.equal(await d.folder('01 Registration', 'root-folder-0001', folder), folder); // there already: nothing to do
  const pdf = await d.file('Plan.pdf', 'application/pdf', new Uint8Array([1]), folder, null);
  assert.equal(await d.file('Plan.pdf', 'application/pdf', new Uint8Array([2]), folder, pdf), pdf); // updated in place
  files.get(pdf).trashed = true;
  assert.notEqual(await d.file('Plan.pdf', 'application/pdf', new Uint8Array([3]), folder, pdf), pdf); // binned: a new copy
  assert.equal(calls.filter((x) => x.startsWith('POST /token')).length, 1); // one sign-in for the whole run
  assert.ok(calls.some((x) => x === `PATCH /upload/drive/v3/files/${pdf}`));
});
