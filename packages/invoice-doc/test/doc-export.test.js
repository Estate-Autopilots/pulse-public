// COMPANY-OPS: a doc's Markdown as blocks, and as a PDF and a Word file (the Drive backup).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { docBlocks, docRuns, FONT_URLS, renderDocDocx, renderDocPdf, safeFileName } from '../src/index.js';

const MD = `> **Draft: review by CA or lawyer before signing.** Made on 10 Nov 2026.

## 1. Who
1. **Asha Rao** and **Ravi Iyer** ("the Founders").
2. Example Labs Private Limited.

## 2. Money
| Date | Amount | Where |
|---|---|---|
| 1 Nov 2026 | ₹40,000 | [Invoice](https://example.test/erp/documents/1) |

- one
  - two
---
Plain paragraph
that wraps.`;

test('blocks: headings, numbered and bullet lists, quotes, tables, rules, paragraphs', () => {
  const b = docBlocks(MD);
  assert.deepEqual(b.map((x) => x.type), ['quote', 'heading', 'number', 'number', 'heading', 'table', 'bullet', 'bullet', 'rule', 'paragraph']);
  assert.equal(b[1].level, 2);
  assert.equal(b[3].n, 2);
  assert.deepEqual(b[5].rows, [['Date', 'Amount', 'Where'], ['1 Nov 2026', '₹40,000', '[Invoice](https://example.test/erp/documents/1)']]);
  assert.equal(b[7].level, 1);
  assert.equal(b[9].text, 'Plain paragraph that wraps.');
});

test('inline marks: bold kept, links keep their address, other marks taken off', () => {
  assert.deepEqual(docRuns('a **b** [c](https://x.test/y) `d` *e*'), [{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c (https://x.test/y) d e', bold: false }]);
  assert.equal(safeFileName('Plan: A/B "test"?', 'pdf'), 'Plan A B test.pdf');
  assert.equal(safeFileName('', 'docx'), 'Untitled.docx');
});

test('PDF and Word files open and carry the words', async () => {
  const fonts = { regular: await readFile(FONT_URLS.regular), semibold: await readFile(FONT_URLS.semibold) };
  const long = `${MD}\n\n${Array.from({ length: 120 }, (_, i) => `- Line ${i} with a long link https://example.test/${'x'.repeat(120)}`).join('\n')}`;
  const pdf = await renderDocPdf({ title: 'Founding-customer agreement', markdown: long, footer: 'Example Labs · backed up 10 Nov 2026' }, { fonts });
  const doc = await PDFDocument.load(pdf);
  assert.ok(doc.getPageCount() >= 2);
  assert.equal(doc.getTitle(), 'Founding-customer agreement');
  const docx = await renderDocDocx({ title: 'Founding-customer agreement', markdown: MD });
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml').async('string');
  for (const w of ['Founding-customer agreement', 'Asha Rao', '₹40,000', 'Invoice (https://example.test/erp/documents/1)', 'Plain paragraph that wraps.']) assert.ok(xml.includes(w), w);
});
