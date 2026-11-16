// CONTRACTS-PRO (owner, 15 Nov 2026): a contract drawn as a typeset legal document on A4: the company's letterhead
// (Billing's own template design and logo, as invoices and pay letters use), the title, the parties block, the
// background, numbered clauses (1 / 1.1 / (a)), defined terms in bold, schedules on their own pages, a signature block
// per party (a drawing, a cleaned photo of a signature traced to vector paths, or a typed name), page numbers, and for a
// signed copy a final certificate page with every step and the SHA-256 of the signed words. The screen shows these very
// bytes (PDF.js), so what people read is what they download. Drawn with pdf-lib (MIT), like letter.js and agreement.js.
import fontkit from '@pdf-lib/fontkit';
import { degrees, drawSvgPath as svgPathOps, LineCapStyle, PDFDocument, PDFHexString, PDFName, PDFOperator, rgb } from 'pdf-lib';
import { normaliseDesign, imageSize } from './model.js';
import { clauseRefs, contractLayers, contractType, documentParties, fillRuns, parseContract, PARTY_TYPES, partyRuns, readSource } from './contract-source.js';
import { tidyVector, vectorOfPng } from './signature-vector.js';
import { scriptSignature } from './signature-script.js';

const hexRgb = (hex) => { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const color = (hex) => { const [r, g, b] = hexRgb(hex); return rgb(r / 255, g / 255, b / 255); };
const tint = (hex, t) => { const [r, g, b] = hexRgb(hex); return rgb((r + (255 - r) * t) / 255, (g + (255 - g) * t) / 255, (b + (255 - b) * t) / 255); };
const RULE = rgb(0.86, 0.865, 0.885), INK = rgb(0.09, 0.1, 0.16), GAP = rgb(1, 0.95, 0.8);
const FALLBACK = { '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '•': '-', '…': '...', ' ': ' ', '≥': '>=', '≤': '<=', '×': 'x' };

/**
 * The model the writer draws, from the contract as the API reads it.
 * input: { title, body (the source), status ('draft'|'proposed'|'active'|'ended'|'cancelled'), version, reference,
 *   company: { name, lines } (the letterhead), parties: rows [{ key, name, role, kind, signer, signedAt (display),
 *   signKind: 'typed'|'drawn'|'uploaded'|'recorded', image: PNG bytes | null, paths: { w, h, d: string[] } | null,
 *   network, device, declinedAt }], audit: [{ at, what, who, via, detail }], sha256, printed }
 * @param {unknown} designInput Billing's template design @param {any} input @param {{ logo?: { bytes: Uint8Array; mime: string } | null }} assets
 */
export function buildContractModel(designInput, input, assets = {}) {
  const design = normaliseDesign(designInput);
  const { meta, text } = readSource(input.body ?? '');
  const parsed = parseContract(text);
  const type = contractType(meta?.type);
  const logo = design.logo.show && assets.logo?.bytes && ['image/png', 'image/jpeg'].includes(assets.logo.mime) ? { ...assets.logo, ...(imageSize(assets.logo.bytes, assets.logo.mime) ?? {}) } : null;
  const parties = documentParties(meta, input.parties ?? []);
  const refs = clauseRefs(text);
  const fill = (runs) => fillRuns(runs, meta, refs);
  return {
    colors: { accent: design.accent, text: design.text, muted: design.muted }, fontScale: design.fontScale,
    logo: logo ? { ...logo, position: design.logo.position, height: design.logo.height } : null,
    company: { name: String(input.company?.name ?? ''), lines: (input.company?.lines ?? []).map(String).filter(Boolean).slice(0, 4) },
    title: String(input.title || parsed.title || type.title), typeLabel: type.short, structured: !!meta,
    date: meta?.date ? longDate(meta.date) : '', place: meta?.place ?? '',
    reference: String(input.reference ?? ''), version: Number(input.version ?? 1), status: String(input.status ?? 'draft'),
    signed: input.status === 'active' || input.status === 'ended',
    parties: parties.map((p) => ({ runs: meta ? partyRuns(p) : [{ text: String(p.name ?? '').toUpperCase(), bold: true }, { text: ';' }], name: String(p.name ?? ''),
      defined: String(p.defined ?? '').replace(/^the\s+/i, ''), type: p.type, signatory: p.signatory || p.row?.signer || '', title: p.title || '',
      sign: p.row ? { signed: !!p.row.signedAt, at: p.row.signedAt ?? null, by: p.row.signer ?? null, kind: p.row.signKind ?? null, image: p.row.image ?? null, paths: p.row.paths ?? null,
        vector: tidyVector(p.row.vector) ?? vectorOfPng(p.row.image), network: p.row.network ?? null, device: p.row.device ?? null, declinedAt: p.row.declinedAt ?? null } : null,
      facts: { type: p.type, reg: p.reg ?? '', address: p.address ?? '' } })),
    // POLISH-1115: a contract with its facts line opens on a cover (title, parties, the layers at a glance) and, when it has
    // five clauses or more, a contents page; every part is a bookmark, so a PDF reader and the agreement page can jump to it.
    layers: meta ? contractLayers(input.body ?? '') : [], cover: !!meta,
    blocks: parsed.blocks.map((b) => (b.runs ? { ...b, runs: fill(b.runs) } : b.kind === 'table' ? { ...b, rows: b.rows.map((r) => r.map(fill)) } : b)),
    audit: Array.isArray(input.audit) ? input.audit : [], sha256: String(input.sha256 ?? ''), printed: String(input.printed ?? ''),
  };
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-11-15" → "15 November 2026"; anything else as it is. @param {string} s */
export function longDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(s ?? '');
}

/** The contract on A4: { bytes, pages }. @param {ReturnType<typeof buildContractModel>} model @param {{ fonts: { regular: Uint8Array; semibold: Uint8Array } }} o */
export async function renderContractPdf(model, { fonts }) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const semibold = await pdf.embedFont(fonts.semibold, { subset: true });
  pdf.setTitle(model.title); pdf.setProducer('Vitals OS'); pdf.setCreator('Vitals OS contracts');
  const known = new Set(regular.getCharacterSet());
  const clean = (s) => Array.from(String(s ?? '').replace(/\t/g, ' ').replace(/\r/g, '')).map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)) ? ch
    : FALLBACK[ch] ?? '?')).join('');
  const embed = async (a) => { if (!a?.bytes) return null; try { return a.mime === 'image/png' ? await pdf.embedPng(a.bytes) : await pdf.embedJpg(a.bytes); } catch { return null; } };
  const logo = await embed(model.logo);
  const sigImages = new Map();
  for (const p of model.parties) if (p.sign?.image?.length) { try { sigImages.set(p, await pdf.embedPng(p.sign.image)); } catch { /* a broken picture is left out */ } }
  const fs = model.fontScale || 1;
  const C = { accent: color(model.colors.accent), text: color(model.colors.text), muted: color(model.colors.muted), tint: tint(model.colors.accent, 0.93), soft: tint(model.colors.accent, 0.6) };
  const W = 595.28, H = 841.89, ML = 64, MR = 64, MT = 58, MB = 66, inner = W - ML - MR;
  const BODY = 10.2 * fs, LEAD = 1.52, SMALL = 8 * fs;
  const draft = !model.signed;
  /** @type {import('pdf-lib').PDFPage[]} */
  const pages = []; let page = /** @type {any} */ (null); let y = 0;

  function newPage() { page = pdf.addPage([W, H]); pages.push(page); y = MT; }
  const room = () => H - MB - y;
  const ensure = (h) => { if (h > room()) newPage(); };
  function text(s, x, top, { font = regular, size = BODY, fill = C.text, align = 'left', box = 0, skew = 0 } = {}) {
    const t = clean(s); if (!t) return 0;
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === 'right' ? x + box - w : align === 'center' ? x + (box - w) / 2 : x, y: H - top, size, font, color: fill, ...(skew ? { ySkew: degrees(skew) } : {}) });
    return w;
  }
  const rule = (x, top, w, fill = RULE, thickness = 0.6) => page.drawLine({ start: { x, y: H - top }, end: { x: x + w, y: H - top }, thickness, color: fill });
  const rect = (x, top, w, h, fill) => page.drawRectangle({ x, y: H - top - h, width: w, height: h, color: fill });

  // ---- rich text: runs → words with their font, wrapped to a width, justified like a printed contract.
  /** @param {{ text: string; bold?: boolean; gap?: boolean }[]} runs */
  function words(runs, size, boldAll = false) {
    const out = [];
    let space = false;
    for (const r of runs) {
      const font = r.bold || boldAll ? semibold : regular;
      for (const part of clean(r.text).split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { space = true; continue; }
        out.push({ t: part, font, gap: !!r.gap, space, w: font.widthOfTextAtSize(part, size) });
        space = false;
      }
    }
    if (out[0]) out[0].space = false;
    return out;
  }
  function lay(ws, size, max) {
    const lines = []; let cur = [], width = 0;
    const sp = regular.widthOfTextAtSize(' ', size);
    for (const w0 of ws) {
      let w = w0;
      const add = (cur.length && w.space ? sp : 0) + w.w;
      if (cur.length && width + add > max) { lines.push({ ws: cur, width }); cur = []; width = 0; w = { ...w, space: false }; }
      while (w.w > max && w.t.length > 1) { // a very long word (a hash, an address) is cut to fit
        let cut = w.t.length - 1;
        while (cut > 1 && w.font.widthOfTextAtSize(w.t.slice(0, cut), size) > max) cut--;
        lines.push({ ws: [{ ...w, t: w.t.slice(0, cut), w: w.font.widthOfTextAtSize(w.t.slice(0, cut), size), space: false }], width: max });
        w = { ...w, t: w.t.slice(cut), w: w.font.widthOfTextAtSize(w.t.slice(cut), size), space: false };
      }
      width += (cur.length && w.space ? sp : 0) + w.w; cur.push(w);
    }
    if (cur.length) lines.push({ ws: cur, width });
    return lines;
  }
  function drawLine(line, x, top, size, max, justify, fill = C.text) {
    const sp = regular.widthOfTextAtSize(' ', size);
    const gaps = line.ws.filter((w, i) => i > 0 && w.space).length;
    const extra = justify && gaps >= 3 && max - line.width < max * 0.28 ? (max - line.width) / gaps : 0;
    let cx = x;
    line.ws.forEach((w, i) => {
      if (i > 0 && w.space) cx += sp + extra;
      if (w.gap) rect(cx - 1, top - size * 0.95, w.w + 2, size * 1.25, GAP);
      page.drawText(w.t, { x: cx, y: H - top, size, font: w.font, color: w.gap ? rgb(0.55, 0.33, 0) : fill });
      cx += w.w;
    });
  }
  /** A paragraph with an optional hanging number; breaks across pages line by line. */
  function paragraph(runs, { x = ML, numberAt = null, number = null, size = BODY, gapAfter = 6.5, boldAll = false, fill = C.text, keep = 1 } = {}) {
    const max = ML + inner - x;
    const lines = lay(words(runs, size, boldAll), size, max);
    const lh = size * LEAD;
    ensure(lh * Math.min(lines.length, Math.max(keep, 2)));
    lines.forEach((l, i) => {
      ensure(lh);
      if (i === 0 && number != null) text(number, numberAt ?? ML, y + size, { font: boldAll ? semibold : regular, size, fill });
      drawLine(l, x, y + size, size, max, i < lines.length - 1, fill);
      y += lh;
    });
    y += gapAfter;
  }

  // ---- page 1: the letterhead (as Billing's documents and pay letters), then the title.
  /** @type {{ title: string; page: import('pdf-lib').PDFPage; top: number; number?: string; part?: string; level: number }[]} */
  const marks = [];
  const mark = (title, o = {}) => marks.push({ title, page, top: y, level: 1, ...o });
  newPage();
  function letterhead() {
    const logoH = logo ? model.logo.height : 0, logoW = logo ? Math.min(170, (logo.width / logo.height) * logoH) : 0;
    if (logo) page.drawImage(logo, { x: model.logo.position === 'right' ? W - MR - logoW : ML, y: H - y - logoH, width: logoW, height: logoH });
    const headTop = y + (logo && model.logo.position !== 'right' ? logoH + 8 : 0);
    if (model.company.name) text(model.company.name, ML, headTop + 12 * fs, { font: semibold, size: 12 * fs });
    model.company.lines.forEach((l, i) => text(l, ML, headTop + 12 * fs + 7 + (i + 1) * SMALL * 1.45, { size: SMALL, fill: C.muted }));
    y = headTop + (model.company.name ? 12 * fs + 10 : 0) + model.company.lines.length * SMALL * 1.45 + 10;
    rule(ML, y, inner, C.accent, 1.4);
  }
  if (model.cover) { rule(ML, y, inner, C.accent, 1.4); y += 26; } else { letterhead(); y += 34; }
  mark(model.parties.length ? 'Parties' : 'The agreement');
  for (const l of lay(words([{ text: model.title.toUpperCase() }], 15 * fs, true), 15 * fs, inner - 40)) {
    drawLine(l, ML + (inner - l.width) / 2, y + 15 * fs, 15 * fs, inner, false, C.text); y += 15 * fs * 1.35;
  }
  y += 4;
  const made = model.date ? `This Agreement is made on ${model.date}${model.place ? ` at ${model.place}` : ''}.` : model.structured ? 'This Agreement is made on the date on which the last Party signs it.' : '';
  if (made) { text(made, ML, y + 9.5 * fs, { size: 9.5 * fs, fill: C.muted, align: 'center', box: inner }); y += 9.5 * fs * 1.6; }
  // A draft says so; a sent copy says it waits for signatures (no DRAFT mark once it is sent).
  if (draft) { text(model.status === 'proposed' ? `Sent for signing · version ${model.version} · not signed by everyone yet` : `Draft ${model.version} · not signed yet`, ML, y + SMALL, { font: semibold, size: SMALL, fill: C.accent, align: 'center', box: inner }); y += SMALL * 1.6; }
  y += 14;

  // ---- the parties block.
  const label = (s, gap = 8) => { ensure(BODY * 3); text(s, ML, y + 8.5 * fs, { font: semibold, size: 8.5 * fs, fill: C.accent }); y += 8.5 * fs + gap; };
  if (model.parties.length) {
    label('BETWEEN');
    model.parties.forEach((p, i) => {
      const last = i === model.parties.length - 1;
      const runs = last && model.structured ? [...p.runs.slice(0, -1), { text: '.' }] : p.runs;
      paragraph(runs, { x: ML + 30, number: `(${i + 1})`, numberAt: ML, gapAfter: 8 });
      if (!last) { text('AND', ML, y + 8.5 * fs, { font: semibold, size: 8.5 * fs, fill: C.muted }); y += 8.5 * fs + 10; }
    });
    if (model.structured && model.parties.length > 1) paragraph([{ text: 'Each of them is a ' }, { text: '“Party”', bold: true }, { text: ', and together they are the ' }, { text: '“Parties”', bold: true }, { text: '.' }], { gapAfter: 10, fill: C.muted, size: 9.5 * fs });
  }

  // ---- the words.
  const hasRecitals = model.blocks.some((b) => b.kind === 'heading' && b.part === 'recitals');
  const sigAt = model.blocks.findIndex((b) => b.kind === 'heading' && b.part === 'signatures');
  const firstSchedule = model.blocks.findIndex((b) => b.kind === 'heading' && b.part === 'schedule');
  let agreed = false, signaturesDrawn = false, part = 'opening', numbered = false;
  const indentFor = () => (numbered ? ML + 30 : ML);

  model.blocks.forEach((b, i) => {
    if (i === firstSchedule && !signaturesDrawn && sigAt < 0) { signatures(); signaturesDrawn = true; }
    if (b.kind === 'heading' && b.level === 1) {
      part = b.part;
      if (b.part === 'signatures') { signatures(); signaturesDrawn = true; return; }
      if (b.part === 'clause' && !agreed && (model.parties.length || hasRecitals) && model.structured) {
        agreed = true; y += 4; paragraph([{ text: 'IT IS AGREED', bold: true }, { text: ' as follows:' }], { gapAfter: 8 });
      }
      if (b.part === 'schedule') {
        newPage();
        mark(`${b.number}${b.title ? `: ${b.title}` : ''}`, { number: b.number, part: 'schedule' });
        text(String(b.number).toUpperCase(), ML, y + 11 * fs, { font: semibold, size: 11 * fs, fill: C.accent, align: 'center', box: inner }); y += 11 * fs * 1.6;
        if (b.title) { for (const l of lay(words([{ text: b.title.toUpperCase() }], 10.5 * fs, true), 10.5 * fs, inner)) { drawLine(l, ML + (inner - l.width) / 2, y + 10.5 * fs, 10.5 * fs, inner, false); y += 10.5 * fs * 1.45; } }
        y += 12; numbered = false; return;
      }
      ensure(BODY * LEAD * 4);
      y += 7;
      if (b.part === 'clause' && b.number) mark(`${b.number}. ${b.title}`, { number: b.number, part: 'clause' });
      else if (b.part === 'recitals') mark('Background', { part: 'recitals', level: 2 });
      const size = 10.4 * fs;
      if (b.number) text(`${b.number}.`, ML, y + size, { font: semibold, size });
      const lines = lay(words([{ text: (b.title || '').toUpperCase() }], size, true), size, inner - 30);
      lines.forEach((l) => { drawLine(l, ML + 30, y + size, size, inner - 30, false); y += size * 1.45; });
      y += 4;
      numbered = false;
      return;
    }
    if (b.kind === 'heading') {
      ensure(BODY * LEAD * 3);
      y += 2;
      if (b.number) text(b.number, ML, y + BODY, { font: semibold, size: BODY });
      const x = b.number ? ML + 30 : ML;
      for (const l of lay(words([{ text: b.title }], BODY, true), BODY, ML + inner - x)) { drawLine(l, x, y + BODY, BODY, inner, false); y += BODY * LEAD; }
      y += 2; numbered = true;
      return;
    }
    if (b.kind === 'para') {
      if (b.number && part === 'recitals') { paragraph(b.runs, { x: ML + 30, number: b.number, numberAt: ML }); return; }
      if (b.number) { numbered = true; paragraph(b.runs, { x: ML + 30, number: b.number, numberAt: ML }); return; }
      paragraph(b.runs, { x: part === 'clause' || part === 'schedule' ? (part === 'clause' ? ML + 30 : ML) : ML, gapAfter: 6.5 });
      return;
    }
    if (b.kind === 'item') {
      const base = part === 'clause' ? ML + 30 : indentFor();
      const at = b.depth === 1 ? base : base + 26;
      paragraph(b.runs, { x: at + 26, number: b.number, numberAt: at, gapAfter: 4 });
      return;
    }
    if (b.kind === 'note') {
      const lines = lay(words(b.runs, 9 * fs), 9 * fs, inner - 24);
      const h = lines.length * 9 * fs * LEAD + 12;
      ensure(h + 6);
      rect(ML, y, inner, h, C.tint); rect(ML, y, 2.5, h, C.accent);
      let ty = y + 6;
      lines.forEach((l, k) => { drawLine(l, ML + 14, ty + 9 * fs, 9 * fs, inner - 24, k < lines.length - 1); ty += 9 * fs * LEAD; });
      y += h + 10;
      return;
    }
    if (b.kind === 'table') { table(b.rows, part === 'clause' ? ML + 30 : ML); return; }
    if (b.kind === 'rule') { ensure(12); rule(ML, y + 4, inner); y += 12; }
  });
  if (!signaturesDrawn) signatures();

  function table(rows, x0) {
    const width = ML + inner - x0, size = 9.2 * fs, pad = 5;
    const cols = Math.max(...rows.map((r) => r.length));
    // Column widths from their longest words, capped, then stretched to the width.
    const need = Array.from({ length: cols }, (_, c) => Math.max(40, Math.min(width * 0.6, ...[0], Math.max(...rows.map((r) => (r[c] ?? []).reduce((s, run) => s + regular.widthOfTextAtSize(clean(run.text), size), 0) + pad * 2)))));
    const sum = need.reduce((a, b) => a + b, 0);
    const widths = need.map((n) => (n / sum) * width);
    rows.forEach((r, ri) => {
      const cells = widths.map((cw, c) => lay(words(r[c] ?? [], size, ri === 0), size, cw - pad * 2));
      const h = Math.max(1, ...cells.map((l) => l.length)) * size * 1.42 + pad * 2;
      ensure(h + (ri === 0 ? size * 3 : 0));
      if (ri === 0) rect(x0, y, width, h, C.tint);
      let cx = x0;
      cells.forEach((lines, c) => { let ty = y + pad; lines.forEach((l) => { drawLine(l, cx + pad, ty + size, size, widths[c] - pad * 2, false); ty += size * 1.42; }); cx += widths[c]; });
      rule(x0, y + h, width, RULE, 0.6); if (ri === 0) rule(x0, y, width, RULE, 0.6);
      y += h;
    });
    y += 10;
  }

  function signatures() {
    if (!model.parties.length) return;
    ensure(150);
    y += 8;
    mark('Signatures', { part: 'signatures' });
    text('SIGNATURES', ML, y + 10.4 * fs, { font: semibold, size: 10.4 * fs }); y += 10.4 * fs * 1.6;
    paragraph([{ text: model.signed ? 'Signed by the Parties on the dates set out below.' : 'To be signed by each Party below. The time, the way each Party signed and a record of every step are added when it is signed.' }], { gapAfter: 10, fill: C.muted, size: 9.5 * fs });
    const colW = (inner - 24) / 2, boxH = 168;
    for (let i = 0; i < model.parties.length; i += 2) {
      ensure(boxH + 6);
      const top = y;
      for (let k = 0; k < 2 && i + k < model.parties.length; k++) block(model.parties[i + k], ML + k * (colW + 24), top, colW);
      y = top + boxH;
    }
  }
  function block(p, x, top, w) {
    const s = p.sign;
    const forLine = p.type === 'individual' ? `Signed by ${p.name.toUpperCase()}` : `For and on behalf of ${p.name.toUpperCase()}`;
    let ty = top;
    for (const l of lay(words([{ text: forLine }], 8.6 * fs, true), 8.6 * fs, w)) { drawLine(l, x, ty + 8.6 * fs, 8.6 * fs, w, false); ty += 8.6 * fs * 1.4; }
    if (p.defined) { text(`(the “${p.defined}”)`, x, ty + 8 * fs, { size: 8 * fs, fill: C.muted }); ty += 8 * fs * 1.5; }
    const area = { x, top: ty + 6, w: Math.min(w, 220), h: 54 };
    if (s?.signed) {
      if (s.vector) inkOnLine(s.vector, area);
      else if (sigImages.get(p)) {
        const img = sigImages.get(p);
        { const r = Math.min(area.w / img.width, area.h / img.height); page.drawImage(img, { x: area.x, y: H - area.top - area.h + (area.h - img.height * r) / 2, width: img.width * r, height: img.height * r }); }
      } else if (s.by) {
        // A typed name, written as handwriting (Hershey script strokes); a name the face cannot write is set in plain type.
        const hand = scriptSignature(s.by);
        if (hand) {
          const scale = Math.min(area.w / hand.width, area.h / hand.height);
          page.drawSvgPath(hand.d, { x: area.x + 2, y: H - area.top - (area.h - hand.height * scale) / 2, scale, borderColor: INK, borderWidth: 1.5 / scale, borderLineCap: LineCapStyle.Round });
        } else text(s.by, area.x + 2, area.top + area.h * 0.68, { font: semibold, size: 19, fill: INK, skew: 12 });
      }
    }
    rule(x, area.top + area.h + 2, Math.min(w, 220), C.muted, 0.7);
    ty = area.top + area.h + 8;
    const facts = [['Name', s?.by || p.signatory || ''], ['Title', p.title || (p.type === 'individual' ? '' : 'Authorised signatory')], ['Date', s?.signed ? String(s.at ?? '') : '']];
    for (const [k, v] of facts) {
      if (k === 'Title' && !v) continue;
      text(`${k}:`, x, ty + 8.6 * fs, { size: 8.6 * fs, fill: C.muted });
      text(v || '', x + 38, ty + 8.6 * fs, { size: 8.6 * fs, font: v ? semibold : regular });
      if (!v) rule(x + 38, ty + 10, Math.min(w, 220) - 38, RULE, 0.5);
      ty += 8.6 * fs * 1.55;
    }
    const how = s?.signed ? [HOW[s.kind] ?? 'Signed electronically', s.network ? `network ${s.network}` : null, s.device].filter(Boolean).join(' · ')
      : s?.declinedAt ? `Declined ${s.declinedAt}` : 'Not signed yet';
    for (const l of lay(words([{ text: how }], 7 * fs), 7 * fs, w)) { drawLine(l, x, ty + 7 * fs, 7 * fs, w, false, s?.signed ? C.muted : C.accent); ty += 7 * fs * 1.4; }
  }

  /**
   * POLISH-1115: a signature's vector, scaled to the signing box and sitting on its line (the ink's lowest point 2 pt
   * above the rule, its left edge at the box's), never stretched. A traced photo is filled even-odd (the eye of an "e"
   * stays open); a drawn one is stroked with its pen width.
   * @param {{ box: number[]; d: string[]; stroke?: number }} v @param {{ x: number; top: number; w: number; h: number }} area
   */
  function inkOnLine(v, area) {
    const [bx, by, bw, bh] = v.box, pad = v.stroke ? v.stroke / 2 : 0;
    const sc = Math.min(area.w / (bw + pad * 2), area.h / (bh + pad * 2));
    const lineTop = area.top + area.h;
    const x = area.x + pad * sc - bx * sc, yTop = lineTop - 2 - (by + bh + pad) * sc;
    const d = v.d.join(' ');
    const ops = v.stroke
      ? svgPathOps(d, { x, y: H - yTop, scale: sc, borderColor: INK, borderWidth: v.stroke, borderLineCap: LineCapStyle.Round })
      : svgPathOps(d, { x, y: H - yTop, scale: sc, color: INK }).map((op) => (String(op) === 'f' ? PDFOperator.of(/** @type {any} */ ('f*')) : op));
    page.pushOperators(...ops);
  }

  // ---- the front pages, planned now (the certificate counts the pages): a cover, and contents for five clauses or more.
  const withCertificate = !!(model.audit.length || model.signed);
  const isEntry = (m) => m.part === 'clause' || m.part === 'schedule' || m.part === 'signatures' || m.part === 'certificate' || m.title === 'Parties';
  const perPage = 34;
  const contentsPages = model.cover && marks.filter((m) => m.part === 'clause').length >= 5 ? Math.ceil((marks.filter(isEntry).length + (withCertificate ? 1 : 0)) / perPage) : 0;
  const frontPages = model.cover ? 1 + contentsPages : 0;

  // ---- the certificate page (a signed or sent copy with its record).
  if (withCertificate) {
    newPage();
    mark('Certificate of signing', { part: 'certificate' });
    text('CERTIFICATE OF SIGNING', ML, y + 12 * fs, { font: semibold, size: 12 * fs }); y += 12 * fs * 1.7;
    paragraph([{ text: 'This page is added by Vitals OS. It records who signed, when and how, and the fingerprint (SHA-256) of the exact words signed. Anyone can check a copy against it: if a single character of the words changes, the fingerprint changes.' }], { fill: C.muted, size: 9 * fs, gapAfter: 10 });
    const rows = [['Document', model.title], ['Reference', model.reference], ['Version', String(model.version)], ['Status', model.signed ? 'Signed by every Party' : 'Not signed by every Party yet'],
      ['Pages', String(pages.length - 1 + frontPages)], ['SHA-256 of the words', model.sha256], ...(model.printed ? [['This copy made', model.printed]] : [])];
    for (const [k, v] of rows) {
      const lines = lay(words([{ text: v }], 9 * fs, k === 'SHA-256 of the words'), 9 * fs, inner - 130);
      ensure(lines.length * 9 * fs * 1.5 + 4);
      text(k, ML, y + 9 * fs, { size: 9 * fs, fill: C.muted });
      lines.forEach((l, n) => { drawLine(l, ML + 130, y + 9 * fs + n * 9 * fs * 1.5, 9 * fs, inner - 130, false); });
      y += Math.max(1, lines.length) * 9 * fs * 1.5 + 3;
    }
    y += 8;
    label('SIGNATURES', 6);
    for (const p of model.parties) {
      const s = p.sign;
      const line = s?.signed ? `${s.by ?? p.name} for ${p.name}: ${HOW[s.kind] ?? 'signed'} on ${s.at}${s.network ? `, network ${s.network}` : ''}${s.device ? `, ${s.device}` : ''}.` : `${p.name}: not signed yet.`;
      paragraph([{ text: line }], { size: 9 * fs, gapAfter: 4 });
    }
    if (model.audit.length) {
      y += 6; label('EVERY STEP', 6);
      for (const e of model.audit) {
        const lines = lay(words([{ text: [e.what, e.who ? `by ${e.who}` : null, e.via, e.detail].filter(Boolean).join(' · ') }], 8.4 * fs), 8.4 * fs, inner - 130);
        ensure(lines.length * 8.4 * fs * 1.45 + 3);
        text(String(e.at ?? ''), ML, y + 8.4 * fs, { size: 8.4 * fs, fill: C.muted });
        lines.forEach((l, n) => drawLine(l, ML + 130, y + 8.4 * fs + n * 8.4 * fs * 1.45, 8.4 * fs, inner - 130, false));
        y += Math.max(1, lines.length) * 8.4 * fs * 1.45 + 3;
      }
    }
  }

  // ---- POLISH-1115: the cover and the contents, put in front once the body knows where each part falls.
  let front = 0;
  if (model.cover) {
    const entries = marks.filter(isEntry);
    const coverPage = pdf.insertPage(0, [W, H]);
    const contents = Array.from({ length: contentsPages }, (_, i) => pdf.insertPage(1 + i, [W, H]));
    pages.unshift(coverPage, ...contents);
    front = 1 + contentsPages;
    page = coverPage; y = MT;
    drawCover();
    marks.unshift({ title: 'Cover', page: coverPage, top: MT, level: 1 });
    if (contentsPages) {
      const numberOf = (m) => pages.indexOf(m.page) + 1;
      contents.forEach((pg, ci) => {
        page = pg; y = MT;
        if (ci === 0) { marks.splice(1, 0, { title: 'Contents', page: pg, top: MT, level: 1 }); text('CONTENTS', ML, y + 12 * fs, { font: semibold, size: 12 * fs }); y += 12 * fs + 22; }
        for (const m of entries.slice(ci * perPage, (ci + 1) * perPage)) {
          const size = 9.6 * fs, num = m.part === 'clause' ? m.number : '';
          const title = m.part === 'clause' ? m.title.replace(/^\d+\.\s*/, '') : m.title;
          const pn = String(numberOf(m));
          if (m.part === 'schedule' && !entries.slice(0, entries.indexOf(m)).some((e) => e.part === 'schedule')) y += 8;
          if (num) text(num, ML, y + size, { size, fill: C.muted });
          const tx = ML + (num ? 26 : 0), pw = regular.widthOfTextAtSize(pn, size);
          const tw = text(title.length > 80 ? `${title.slice(0, 78)}…` : title, tx, y + size, { size, font: m.part === 'clause' ? regular : semibold });
          // A dotted leader to the page number, as printed contracts have.
          for (let dx = tx + tw + 6; dx < ML + inner - pw - 6; dx += 4) page.drawCircle({ x: dx, y: H - (y + size - 1.5), size: 0.45, color: C.muted });
          text(pn, ML, y + size, { size, fill: C.muted, align: 'right', box: inner });
          y += size * 1.95;
        }
      });
    }
  }
  function drawCover() {
    letterhead();
    const right = [model.reference, `Version ${model.version}`].filter(Boolean).join(' · ');
    text(right, ML, MT + 9, { size: 7.6, fill: C.muted, align: 'right', box: inner });
    y += 92;
    text(String(model.typeLabel || 'Agreement').toUpperCase(), ML, y + 8.6 * fs, { font: semibold, size: 8.6 * fs, fill: C.accent }); y += 8.6 * fs + 12;
    for (const l of lay(words([{ text: model.title }], 25 * fs, true), 25 * fs, inner - 20)) { drawLine(l, ML, y + 25 * fs, 25 * fs, inner, false); y += 25 * fs * 1.22; }
    y += 10; rect(ML, y, 44, 3, C.accent); y += 18;
    const dated = model.date ? `Dated ${model.date}${model.place ? `, at ${model.place}` : ''}` : 'Dated the day the last Party signs';
    text(dated, ML, y + 10 * fs, { size: 10 * fs, fill: C.muted }); y += 10 * fs + 30;
    if (model.parties.length) {
      text('BETWEEN', ML, y + 8.2 * fs, { font: semibold, size: 8.2 * fs, fill: C.accent }); y += 8.2 * fs + 12;
      model.parties.forEach((p, i) => {
        text(`(${i + 1})`, ML, y + 11.5 * fs, { size: 10 * fs, fill: C.muted });
        for (const l of lay(words([{ text: p.name || `[${p.defined || 'Party'}: name]` }], 11.5 * fs, true), 11.5 * fs, inner - 30)) { drawLine(l, ML + 30, y + 11.5 * fs, 11.5 * fs, inner, false); y += 11.5 * fs * 1.3; }
        const kind = PARTY_TYPES.find((t) => t.key === p.facts?.type)?.label ?? '';
        const reg = p.facts?.reg ? `${PARTY_TYPES.find((t) => t.key === p.facts?.type)?.reg || 'Reg.'} ${p.facts.reg}` : '';
        const line = [kind, reg, p.defined ? `the “${p.defined}”` : ''].filter(Boolean).join('  ·  ');
        if (line) { text(line, ML + 30, y + 8.6 * fs, { size: 8.6 * fs, fill: C.muted }); y += 8.6 * fs * 1.5; }
        y += 10;
      });
    }
    // The layers at a glance: each one's clauses and its facts, two to a row, in a tinted panel at the foot.
    const cells = model.layers.filter((l) => l.key !== 'parties' && (l.clauses.length || l.facts.length)).slice(0, 8).map((l) => {
      const nums = l.clauses.map((c) => c.number).filter(Boolean);
      const where = l.key === 'schedules' ? l.clauses.map((c) => c.number).join(', ') : nums.length ? `${nums.length === 1 ? 'Clause' : 'Clauses'} ${nums.join(', ')}` : '';
      const facts = l.facts.slice(0, 3).map((f) => `${f.label}: ${f.value}`);
      return { label: l.label, where, facts };
    });
    if (cells.length) {
      const cw = (inner - 28 - 20) / 2, size = 8.4 * fs;
      const rows = []; for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
      const hOf = (c) => 10 * fs * 1.3 + (c.where ? size * 1.45 : 0) + c.facts.reduce((s, f) => s + lay(words([{ text: f }], size), size, cw).length * size * 1.4, 0) + 10;
      const heights = rows.map((r) => Math.max(...r.map(hOf)));
      let total = 14 + 9 * fs + 14 + heights.reduce((a, b) => a + b, 0) + 8;
      while (rows.length && y + total > H - MB - 30) { total -= heights.pop() ?? 0; rows.pop(); }
      if (rows.length) {
        const top = Math.max(y + 6, H - MB - 30 - total);
        rect(ML, top, inner, total, C.tint); rect(ML, top, 2.5, total, C.accent);
        y = top + 14;
        text('WHAT THIS AGREEMENT COVERS', ML + 14, y + 8 * fs, { font: semibold, size: 8 * fs, fill: C.accent }); y += 9 * fs + 14;
        rows.forEach((r, ri) => {
          r.forEach((c, k) => {
            const x = ML + 14 + k * (cw + 20); let ty = y;
            text(c.label, x, ty + 10 * fs, { font: semibold, size: 10 * fs }); ty += 10 * fs * 1.3;
            if (c.where) { text(c.where, x, ty + size, { size, fill: C.accent }); ty += size * 1.45; }
            for (const f of c.facts) for (const l of lay(words([{ text: f }], size), size, cw)) { drawLine(l, x, ty + size, size, cw, false, C.muted); ty += size * 1.4; }
          });
          y += heights[ri];
        });
      }
    }
    const status = model.signed ? 'Signed by every Party' : model.status === 'proposed' ? `Sent for signing · version ${model.version}` : `Draft ${model.version} · not signed yet`;
    text(status, ML, H - MB + 6, { font: semibold, size: 8 * fs, fill: model.signed ? C.text : C.accent });
  }

  // ---- bookmarks (the PDF's outline), so a reader's side bar lists the parts and the page can jump to a clause.
  if (marks.length) {
    const ctx = pdf.context;
    const root = ctx.nextRef();
    const top = marks.filter((m) => m.level === 1);
    const refs = top.map(() => ctx.nextRef());
    top.forEach((m, i) => {
      ctx.assign(refs[i], ctx.obj({ Title: PDFHexString.fromText(m.title.slice(0, 120)), Parent: root, Dest: [m.page.ref, 'XYZ', null, Math.round(H - Math.max(0, m.top - 6)), null],
        ...(i > 0 ? { Prev: refs[i - 1] } : {}), ...(i < top.length - 1 ? { Next: refs[i + 1] } : {}) }));
    });
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: top.length }));
    pdf.catalog.set(PDFName.of('Outlines'), root);
  }

  // ---- every page: a draft mark, the reference and "Page n of N".
  const total = pages.length;
  pages.forEach((pg, n) => {
    page = pg;
    if (n === 0 && front) { if (model.status === 'draft') page.drawText('DRAFT', { x: W / 2 - 150, y: H / 2 - 110, size: 96, font: semibold, color: C.accent, opacity: 0.045, rotate: degrees(35) }); return; }
    if (model.status === 'draft') page.drawText('DRAFT', { x: W / 2 - 150, y: H / 2 - 110, size: 96, font: semibold, color: C.accent, opacity: 0.045, rotate: degrees(35) });
    rule(ML, H - MB + 26, inner, RULE, 0.5);
    const left = [model.title, model.reference, `Version ${model.version}`].filter(Boolean).join(' · ');
    text(left.length > 90 ? `${left.slice(0, 88)}…` : left, ML, H - MB + 40, { size: 7.4, fill: C.muted });
    text(`Page ${n + 1} of ${total}`, ML, H - MB + 40, { size: 7.4, fill: C.muted, align: 'right', box: inner });
    if (model.signed && model.sha256) text(`SHA-256 ${model.sha256.slice(0, 16)}…`, ML, H - MB + 50, { size: 6.6, fill: C.muted });
  });
  return { bytes: await pdf.save({ useObjectStreams: false }), pages: total };
}
const HOW = { drawn: 'Drew their signature', typed: 'Typed their name', uploaded: 'Uploaded a photo of their signature (cleaned)', recorded: 'Signed on paper (recorded)' };
