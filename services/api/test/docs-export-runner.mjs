// DOCS-EXPORT (17 Nov 2026): a doc downloads as PDF, Word and Markdown for whoever may open it, and for nobody else, on
// disposable synthetic companies (tests/core/test_docs_export.py). Through the real API (createApp, under row security):
// the three files with their types, names and words; a private doc refused to a colleague and a company doc given to
// them; a doc of another company refused to this company's admin (404, as opening it); a bad format and a bad id
// refused; no sign-in, no file. Every name and word is synthetic.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER_EMAIL, FOREIGN = process.env.TEST_FOREIGN_DOC;
let checks = 0;
const as = (who) => (who ? { 'cf-access-authenticated-user-email': who } : {});
const raw = (path, who, method = 'GET', body) => app.inject({ url: '/api/v0/' + path, method, headers: as(who), ...(body === undefined ? {} : { payload: body }) });
const status = async (path, who, expected, why) => { const r = await raw(path, who); assert.equal(r.statusCode, expected, `${why}: ${r.body.slice(0, 300)}`); checks++; return r; };

const MD = `## Plan for the week (synthetic)

The **launch** stays on Friday. Links keep their address: [the brief](https://example.test/brief).

- Draft the offer
- Check the numbers
  - twice

1. Call the printer
2. Book the room

> Keep it short.

| Item | Owner | Cost (₹) |
| --- | --- | --- |
| Banner | Asha (synthetic) | 1,200 |
| Stall | Ravi (synthetic) | 8,500 |
`;
const TITLE = 'Q4 "launch" plan: Pune/Mumbai — ₹ budget (synthetic)';

try {
  assert.ok(ADMIN && MEMBER && FOREIGN, 'TEST_ADMIN_EMAIL, TEST_MEMBER_EMAIL and TEST_FOREIGN_DOC are set');
  const post = async (body) => { const r = await raw('docs', ADMIN, 'POST', body); assert.equal(r.statusCode, 200, r.body.slice(0, 300)); return r.json().doc; };
  const mine = await post({ title: TITLE, markdown: MD });               // private by default
  const shared = await post({ title: 'Team handbook (synthetic)', access: 'company', markdown: '## Leave\n\nAsk two days ahead.' });

  // Markdown: the title as its heading, then the doc's own Markdown, table and all.
  const md = await status(`docs/${mine.id}/export?format=md`, ADMIN, 200, 'the owner downloads Markdown');
  assert.match(md.headers['content-type'], /^text\/markdown; charset=utf-8/);
  assert.match(md.body, /^# Q4 "launch" plan: Pune\/Mumbai — ₹ budget \(synthetic\)\n\n/);
  assert.match(md.body, /\*\*launch\*\*/); assert.match(md.body, /Banner[\s\S]*Asha \(synthetic\)[\s\S]*1,200/); assert.match(md.body, /Keep it short/);
  checks++;
  // The file name: no slashes, quotes or colons (any computer saves it), and the real name in UTF-8 beside it.
  const cd = md.headers['content-disposition'];
  assert.match(cd, /^attachment; filename="[^"/\\:]+\.md"; filename\*=UTF-8''/);
  assert.ok(decodeURIComponent(cd.split("filename*=UTF-8''")[1]).endsWith('Q4 launch plan Pune Mumbai — ₹ budget (synthetic).md'), cd);
  assert.equal(md.headers['cache-control'], 'private, no-store'); assert.equal(md.headers['x-content-type-options'], 'nosniff');
  checks++;
  assert.equal((await status(`docs/${mine.id}/export?format=markdown`, ADMIN, 200, '"markdown" is Markdown too')).body, md.body);

  // PDF: a real PDF with the doc's title in it.
  const pdf = await status(`docs/${mine.id}/export?format=pdf`, ADMIN, 200, 'the owner downloads a PDF');
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.rawPayload.subarray(0, 5).toString('latin1'), '%PDF-'); assert.ok(pdf.rawPayload.length > 2000, `PDF ${pdf.rawPayload.length} bytes`);
  assert.match(pdf.headers['content-disposition'], /filename="[^"]+\.pdf"/);
  checks++;

  // Word: a .docx (a zip holding word/document.xml) with the doc's words in it.
  const docx = await status(`docs/${mine.id}/export?format=docx`, ADMIN, 200, 'the owner downloads Word');
  assert.equal(docx.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.rawPayload.subarray(0, 2).toString('latin1'), 'PK'); assert.ok(docx.rawPayload.includes(Buffer.from('word/document.xml')));
  const mammoth = (await import('mammoth')).default;
  const words = (await mammoth.extractRawText({ buffer: docx.rawPayload })).value;
  for (const w of ['Plan for the week (synthetic)', 'Draft the offer', 'Call the printer', 'Banner', '8,500', 'the brief (https://example.test/brief)']) assert.ok(words.includes(w), `the Word file says "${w}"`);
  assert.equal((await status(`docs/${mine.id}/export?format=word`, ADMIN, 200, '"word" is Word too')).headers['content-type'], docx.headers['content-type']);
  checks++;

  // Who may: a private doc is the owner's alone; a company doc is everyone's in the company, in every format.
  for (const f of ['pdf', 'docx', 'md']) {
    await status(`docs/${mine.id}/export?format=${f}`, MEMBER, 404, `a colleague cannot download a private doc as ${f}`);
    await status(`docs/${shared.id}/export?format=${f}`, MEMBER, 200, `a colleague downloads a company doc as ${f}`);
    // Another company's doc does not exist for this company, its admin included: the same 404 as opening it.
    await status(`docs/${FOREIGN}/export?format=${f}`, ADMIN, 404, `another company's doc is refused as ${f}`);
  }
  await status(`docs/${FOREIGN}`, ADMIN, 404, 'and opening it is refused the same way');
  // Shared with the colleague by name: now they may.
  const share = await raw(`docs/${mine.id}/share`, ADMIN, 'POST', { access: 'people', people: [{ personId: process.env.TEST_MEMBER_ID, canEdit: false }] });
  if (share.statusCode === 200) { await status(`docs/${mine.id}/export?format=md`, MEMBER, 200, 'shared by name, the colleague downloads it'); }

  // Refusals: a format that is not offered, an id that is not one, and nobody signed in.
  const bad = await status(`docs/${mine.id}/export?format=exe`, ADMIN, 400, 'an unknown format');
  assert.match(bad.body, /pdf, docx or md/);
  await status(`docs/${mine.id}/export`, ADMIN, 400, 'no format');
  await status('docs/not-a-doc/export?format=pdf', ADMIN, 404, 'not an id');
  const nobody = await raw(`docs/${shared.id}/export?format=md`, null); checks++;
  assert.ok(nobody.statusCode >= 400 && nobody.statusCode < 500 && !nobody.body.includes('Ask two days ahead'), `no sign-in, no file: ${nobody.statusCode}`);

  writeFileSync(process.env.DOCS_EXPORT_REPORT || join(tmpdir(), 'docs-export.json'), JSON.stringify({ checks, docId: mine.id }));
  console.log(`docs-export: ${checks} checks pass`);
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
