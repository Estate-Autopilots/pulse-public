// DOCS-EXPORT: the parts of a doc download that need no database: which formats are offered, the file name every
// computer saves (and the real one beside it), and the Markdown file's first line. The route itself, under row
// security, is tests/core/test_docs_export.py.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPORT_FORMATS, attachmentHeader, exportFormat, markdownFile } from '../dist/doc-export.js';

test('pdf, docx and md are offered (word and markdown are the same), anything else is a plain 400', () => {
  assert.equal(exportFormat('pdf'), 'pdf'); assert.equal(exportFormat('DOCX'), 'docx'); assert.equal(exportFormat(' md '), 'md');
  assert.equal(exportFormat('word'), 'docx'); assert.equal(exportFormat('markdown'), 'md');
  for (const bad of [undefined, '', 'exe', 'html', 'toString', '__proto__', 'constructor']) {
    assert.throws(() => exportFormat(bad), (e) => e.statusCode === 400 || /pdf, docx or md/.test(String(e.message)), String(bad));
  }
  assert.deepEqual(Object.keys(EXPORT_FORMATS).sort(), ['docx', 'md', 'pdf']);
  assert.equal(EXPORT_FORMATS.md.mime, 'text/markdown; charset=utf-8');
});

test('the file name has no slashes, quotes, colons or line breaks, and the real name rides in UTF-8', () => {
  const h = attachmentHeader('Q4 "launch" plan: Pune/Mumbai — ₹ budget\r\nX-Evil: 1', 'pdf');
  assert.ok(!/[\r\n]/.test(h), 'no header injection');
  const ascii = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.+)$/.exec(h);
  assert.ok(ascii, h);
  assert.ok(!/[/\\:"]/.test(ascii[1]) && ascii[1].endsWith('.pdf'), ascii[1]);
  assert.equal(decodeURIComponent(ascii[2]), 'Q4 launch plan Pune Mumbai — ₹ budget X-Evil 1.pdf');
  assert.match(attachmentHeader('', 'md'), /filename="Untitled\.md"/);
  assert.match(attachmentHeader('₹₹₹', 'docx'), /filename="doc\.docx"/, 'a name with no Latin letters still saves');
});

test('the Markdown file starts with the title as its heading', () => {
  assert.equal(markdownFile('  Weekly   plan ', '\nBody\n\n'), '# Weekly plan\n\nBody\n');
  assert.equal(markdownFile('', 'x'), '# Untitled\n\nx\n');
});
