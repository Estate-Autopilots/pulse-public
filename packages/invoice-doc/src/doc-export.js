// COMPANY-OPS (owner, 10 Nov 2026: "Backup to Google Drive … extremely important"): a Docs doc as a PDF and as a Word
// (.docx) file, for the Drive backup (and any later "Download as"). The doc arrives as the Markdown Docs already makes for
// export and AI (docs.ts htmlToMarkdown). This reads its blocks — headings, paragraphs, bullet and numbered lists, quotes,
// tables, rules — and draws them plainly: the backup is for keeping and reading the words, not for page design.
// Inline marks: **bold** is kept; links become "text (url)"; other Markdown marks are taken off.
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

const MAX_BLOCKS = 5000;

/** Inline Markdown → runs of { text, bold }. Links keep their address in brackets so a printed copy still has it. */
export function docRuns(line) {
  const plain = String(line ?? '')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, url) => (text === url ? url : `${text} (${url})`))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1$2')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');
  const runs = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let at = 0, m;
  while ((m = re.exec(plain))) {
    if (m.index > at) runs.push({ text: plain.slice(at, m.index), bold: false });
    runs.push({ text: m[1] ?? m[2], bold: true });
    at = m.index + m[0].length;
  }
  if (at < plain.length) runs.push({ text: plain.slice(at), bold: false });
  return runs.filter((r) => r.text.length);
}

const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/**
 * The doc's Markdown as blocks:
 *   { type: 'heading', level 1-4, text } | { type: 'paragraph', text } | { type: 'bullet' | 'number', level, text, n? }
 *   | { type: 'quote', text } | { type: 'table', rows: string[][] (first row: header) } | { type: 'rule' }
 */
export function docBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ type: 'paragraph', text: para.join(' ').trim() }); para = []; } };
  for (let i = 0; i < lines.length && out.length < MAX_BLOCKS; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push({ type: 'heading', level: Math.min(4, m[1].length), text: m[2].replace(/\s+#+\s*$/, '') }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ type: 'rule' }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        const r = cells(lines[i]);
        if (!r.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(r);
      }
      i--;
      if (rows.length) out.push({ type: 'table', rows });
      continue;
    }
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) { flush(); out.push({ type: 'bullet', level: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), text: m[2] }); continue; }
    if ((m = /^(\s*)(\d{1,4})[.)]\s+(.*)$/.exec(line))) { flush(); out.push({ type: 'number', level: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), n: Number(m[2]), text: m[3] }); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); const prev = out[out.length - 1]; if (prev?.type === 'quote' && lines[i - 1]?.trim().startsWith('>')) prev.text += ` ${m[1]}`; else out.push({ type: 'quote', text: m[1] }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

const plainOf = (text) => docRuns(text).map((r) => r.text).join('');
/** A file name Drive and every computer accept: no slashes or control characters, at most 150 characters. */
export function safeFileName(name, ext = '') {
  const base = String(name ?? '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Untitled';
  return ext ? `${base}.${ext}` : base;
}

// ---------------------------------------------------------------------------------------------------------------- PDF
const A4 = [595.28, 841.89], MARGIN = 56;
const SIZES = { 1: 18, 2: 15, 3: 13, 4: 12 };

/** Words → lines no wider than `width` (a word longer than a line is cut by characters). */
function wrap(runs, font, bold, size, width) {
  const lines = [];
  let line = [], w = 0;
  const space = font.widthOfTextAtSize(' ', size);
  const push = () => { lines.push(line); line = []; w = 0; };
  for (const r of runs) {
    const f = r.bold ? bold : font;
    for (const piece of r.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) { if (line.length) { line.push({ text: ' ', bold: r.bold }); w += space; } continue; }
      let word = piece, ww = f.widthOfTextAtSize(word, size);
      while (ww > width) { // a very long word (a link): cut it
        let k = word.length;
        while (k > 1 && f.widthOfTextAtSize(word.slice(0, k), size) > width - w) k--;
        if (k <= 1 && line.length) { push(); continue; }
        line.push({ text: word.slice(0, k), bold: r.bold }); push();
        word = word.slice(k); ww = f.widthOfTextAtSize(word, size);
      }
      if (w + ww > width && line.length) { while (line.length && line[line.length - 1].text === ' ') line.pop(); push(); }
      line.push({ text: word, bold: r.bold }); w += ww;
    }
  }
  if (line.length) push();
  return lines.length ? lines : [[]];
}

/**
 * The doc as a PDF (A4). doc: { title, markdown, footer? (one line on every page, e.g. company · backed up on …) }.
 * fonts: { regular, semibold } bytes (the invoice fonts: Inter, which has ₹).
 */
export async function renderDocPdf(doc, { fonts }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fonts.regular, { subset: true }), bold = await pdf.embedFont(fonts.semibold, { subset: true });
  pdf.setTitle(String(doc.title ?? 'Untitled'));
  const ink = rgb(0.12, 0.13, 0.16), soft = rgb(0.42, 0.44, 0.5), line = rgb(0.85, 0.86, 0.9);
  const width = A4[0] - MARGIN * 2;
  let page, y;
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - MARGIN; };
  const room = (h) => { if (y - h < MARGIN + 20) newPage(); };
  const draw = (lines, x, size, color = ink, lead = 1.45) => {
    for (const l of lines) {
      room(size * lead);
      let cx = x;
      for (const r of l) { const f = r.bold ? bold : font; page.drawText(r.text, { x: cx, y: y - size, size, font: f, color }); cx += f.widthOfTextAtSize(r.text, size); }
      y -= size * lead;
    }
  };
  newPage();
  draw(wrap([{ text: String(doc.title ?? 'Untitled'), bold: true }], font, bold, 20, width), MARGIN, 20);
  y -= 8;
  for (const b of docBlocks(doc.markdown)) {
    if (b.type === 'heading') { y -= 6; draw(wrap([{ text: plainOf(b.text), bold: true }], font, bold, SIZES[b.level], width), MARGIN, SIZES[b.level]); y -= 2; }
    else if (b.type === 'paragraph') { draw(wrap(docRuns(b.text), font, bold, 10.5, width), MARGIN, 10.5); y -= 5; }
    else if (b.type === 'quote') {
      const ls = wrap(docRuns(b.text), font, bold, 10.5, width - 14), top = y;
      draw(ls, MARGIN + 14, 10.5, soft);
      page.drawRectangle({ x: MARGIN + 2, y: y + 2, width: 2.5, height: Math.max(8, Math.min(top - y, top - MARGIN)), color: line });
      y -= 5;
    } else if (b.type === 'bullet' || b.type === 'number') {
      const indent = 14 + b.level * 14, mark = b.type === 'bullet' ? '•' : `${b.n}.`;
      room(15); page.drawText(mark, { x: MARGIN + indent - 12, y: y - 10.5, size: 10.5, font, color: ink });
      draw(wrap(docRuns(b.text), font, bold, 10.5, width - indent - 4), MARGIN + indent + 2, 10.5); y -= 2;
    } else if (b.type === 'rule') { room(12); page.drawLine({ start: { x: MARGIN, y: y - 5 }, end: { x: A4[0] - MARGIN, y: y - 5 }, thickness: 0.6, color: line }); y -= 12; }
    else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length)), cw = width / cols, size = cols > 4 ? 8.5 : 9.5;
      b.rows.forEach((r, ri) => {
        const wrapped = Array.from({ length: cols }, (_, ci) => wrap(ri === 0 ? [{ text: plainOf(r[ci] ?? ''), bold: true }] : docRuns(r[ci] ?? ''), font, bold, size, cw - 8));
        const h = Math.max(...wrapped.map((l) => l.length)) * size * 1.35 + 6;
        room(Math.min(h, A4[1] - MARGIN * 2 - 20));
        const top = y;
        wrapped.forEach((ls, ci) => { let ly = top - 3; for (const l of ls) { let cx = MARGIN + ci * cw + 4; for (const run of l) { const f = run.bold ? bold : font; if (ly - size > MARGIN) page.drawText(run.text, { x: cx, y: ly - size, size, font: f, color: ink }); cx += f.widthOfTextAtSize(run.text, size); } ly -= size * 1.35; } });
        y = top - h;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: ri === 0 ? 0.8 : 0.4, color: line });
      });
      y -= 8;
    }
  }
  if (doc.footer) {
    const pages = pdf.getPages();
    pages.forEach((p, i) => p.drawText(`${String(doc.footer).slice(0, 140)} · ${i + 1}/${pages.length}`, { x: MARGIN, y: MARGIN / 2, size: 7.5, font, color: soft }));
  }
  return pdf.save();
}

// --------------------------------------------------------------------------------------------------------------- DOCX
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
const textRuns = (text, extra = {}) => docRuns(text).map((r) => new TextRun({ text: r.text, bold: r.bold || undefined, ...extra }));

/** The doc as a Word file (.docx). doc: { title, markdown, footer? }. */
export async function renderDocDocx(doc) {
  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: String(doc.title ?? 'Untitled') })] })];
  for (const b of docBlocks(doc.markdown)) {
    if (b.type === 'heading') children.push(new Paragraph({ heading: HEADINGS[b.level], children: textRuns(b.text) }));
    else if (b.type === 'paragraph') children.push(new Paragraph({ children: textRuns(b.text), spacing: { after: 120 } }));
    else if (b.type === 'quote') children.push(new Paragraph({ children: textRuns(b.text, { italics: true }), indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D8DBE3', space: 8 } } }));
    else if (b.type === 'bullet') children.push(new Paragraph({ children: textRuns(b.text), bullet: { level: b.level } }));
    else if (b.type === 'number') children.push(new Paragraph({ children: [new TextRun({ text: `${b.n}. ` }), ...textRuns(b.text)], indent: { left: 360 + b.level * 360, hanging: 260 } }));
    else if (b.type === 'rule') children.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D8DBE3', space: 1 } } }));
    else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new TableRow({ tableHeader: ri === 0, children: Array.from({ length: cols }, (_, ci) => new TableCell({
          children: [new Paragraph({ children: ri === 0 ? [new TextRun({ text: plainOf(r[ci] ?? ''), bold: true })] : textRuns(r[ci] ?? '') })] })) })) }));
      children.push(new Paragraph({ children: [] }));
    }
  }
  if (doc.footer) children.push(new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: String(doc.footer).slice(0, 200), size: 16, color: '6B7080' })] }));
  return Packer.toBuffer(new Document({ creator: 'Vitals OS', title: String(doc.title ?? 'Untitled'), sections: [{ children }] }));
}
