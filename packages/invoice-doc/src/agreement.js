// CONTRACTS-2 (owner, 8 Nov 2026): an agreement as a PDF: the words, clause by clause, each side's signature (a typed
// name, or the drawing the person made with their finger), and an audit page: what happened, when, through which way
// (inside Vitals OS or the signing link), a digest of each signer's network address and their browser, and the SHA-256
// of the words that were signed, so anyone can check the copy was not changed. Drawn with pdf-lib (MIT), as letter.js.
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { agreementClauses, clauseName } from './agreement-text.js';

const INK = rgb(0.118, 0.106, 0.18), MUTED = rgb(0.42, 0.408, 0.5), ACCENT = rgb(0.42, 0.298, 0.941), RULE = rgb(0.886, 0.894, 0.91);
const GREEN = rgb(0.086, 0.639, 0.29), TINT = rgb(0.957, 0.949, 0.996);

/**
 * model: { title, from, reference, version, status ('active' signs it; anything else is a draft copy), signedAt,
 *   body, sha256, parties: [{ name, role, signer, signedAt, kind: 'typed'|'drawn'|'recorded'|null, image: Uint8Array|null, declinedAt }],
 *   audit: [{ at (display text), what, who, via, detail }], printed (display text) }
 * @returns {Promise<{ bytes: Uint8Array, pages: number }>}
 */
export async function renderAgreementPdf(model, { fonts }) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const semibold = await pdf.embedFont(fonts.semibold, { subset: true });
  pdf.setTitle(String(model.title ?? 'Agreement'));
  pdf.setProducer('Vitals OS');
  const known = new Set(regular.getCharacterSet());
  const clean = (s) => Array.from(String(s ?? '').replace(/\t/g, ' ').replace(/\r/g, '')).map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const W = 595.28, H = 841.89, M = 54, inner = W - 2 * M, FOOT = 28;
  const lh = (size) => size * 1.5;
  const pages = []; let page = null; let y = 0;
  const draft = model.status !== 'active';

  function wrap(s, font, size, max) {
    const out = [];
    for (const para of clean(s).split('\n')) {
      let line = '';
      for (const word of para.split(/ +/)) {
        const t = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(t, size) <= max) { line = t; continue; }
        if (line) out.push(line);
        let piece = word;
        while (font.widthOfTextAtSize(piece, size) > max && piece.length > 1) {
          let cut = piece.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > max) cut--;
          out.push(piece.slice(0, cut)); piece = piece.slice(cut);
        }
        line = piece;
      }
      out.push(line);
    }
    return out;
  }
  function text(s, x, top, { font = regular, size = 10, fill = INK, align = 'left', box = 0 } = {}) {
    const t = clean(s); if (!t) return;
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === 'right' ? x + box - w : align === 'center' ? x + (box - w) / 2 : x, y: H - top, size, font, color: fill });
  }
  const rule = (top, fill = RULE, thickness = 0.6, x = M, w = inner) => page.drawLine({ start: { x, y: H - top }, end: { x: x + w, y: H - top }, thickness, color: fill });
  function newPage() {
    page = pdf.addPage([W, H]); pages.push(page); y = M;
    if (pages.length > 1) { text(`${model.title}`, M, y + 8, { font: semibold, size: 8, fill: MUTED }); rule(y + 14); y += 30; }
    if (draft) text('DRAFT · NOT SIGNED BY EVERYONE YET', M, 30, { font: semibold, size: 7.5, fill: MUTED, align: 'right', box: inner });
  }
  const ensure = (h) => { if (y + h > H - M - FOOT) newPage(); };
  const para = (s, { font = regular, size = 10, fill = INK, gap = 6 } = {}) => {
    for (const l of wrap(s, font, size, inner)) { ensure(lh(size)); text(l, M, y + size, { font, size, fill }); y += lh(size); }
    y += gap;
  };

  // The heading.
  newPage();
  text(model.from ?? '', M, y + 9, { font: semibold, size: 9, fill: ACCENT });
  y += 22;
  for (const l of wrap(model.title ?? 'Agreement', semibold, 18, inner)) { text(l, M, y + 18, { font: semibold, size: 18 }); y += lh(18); }
  text([model.reference, `Draft ${model.version}`].filter(Boolean).join(' · '), M, y + 9, { size: 9, fill: MUTED });
  y += 22; rule(y, ACCENT, 1.4); y += 18;

  // The words, clause by clause.
  for (const c of agreementClauses(model.body ?? '')) {
    if (c.title) { ensure(lh(11.5) + lh(10) * 2); y += 4; text(clauseName(c), M, y + 11.5, { font: semibold, size: 11.5 }); y += lh(11.5) + 2; }
    if (c.text) for (const p of c.text.split(/\n{2,}/)) para(p);
  }

  // Signatures: one box per side.
  y += 8; ensure(150);
  text('Signatures', M, y + 11.5, { font: semibold, size: 11.5 }); y += lh(11.5) + 6;
  const parties = model.parties ?? [];
  const colW = (inner - 16) / 2;
  for (let i = 0; i < parties.length; i += 2) {
    ensure(118);
    const top = y;
    for (const [j, p] of parties.slice(i, i + 2).entries()) {
      const x = M + j * (colW + 16);
      page.drawRectangle({ x, y: H - top - 108, width: colW, height: 108, color: p.signedAt ? TINT : rgb(1, 1, 1), borderColor: RULE, borderWidth: 0.8 });
      text(`For ${p.name}`, x + 10, top + 16, { font: semibold, size: 9 });
      if (p.signedAt) {
        let img = null;
        if (p.image) { try { img = await pdf.embedPng(p.image); } catch { img = null; } }
        if (img) { const h = 40, w = Math.min(colW - 20, (img.width / img.height) * h); page.drawImage(img, { x: x + 10, y: H - (top + 26 + h), width: w, height: h }); }
        else text(p.signer ?? p.name, x + 10, top + 56, { font: semibold, size: 17, fill: ACCENT });
        page.drawLine({ start: { x: x + 10, y: H - (top + 70) }, end: { x: x + colW - 10, y: H - (top + 70) }, thickness: 0.5, color: MUTED });
        text(`${p.signer ?? ''}${p.kind === 'drawn' ? ' · drew their signature' : p.kind === 'typed' ? ' · typed their name' : ''}`, x + 10, top + 84, { size: 8, fill: MUTED });
        text(`Signed ${p.signedAt}`, x + 10, top + 98, { font: semibold, size: 8, fill: GREEN });
      } else {
        page.drawLine({ start: { x: x + 10, y: H - (top + 70) }, end: { x: x + colW - 10, y: H - (top + 70) }, thickness: 0.5, color: MUTED });
        text(p.declinedAt ? `Said no on ${p.declinedAt}` : 'Not signed yet', x + 10, top + 86, { size: 8, fill: MUTED });
      }
    }
    y = top + 120;
  }

  // The audit page.
  newPage();
  text('Audit trail', M, y + 15, { font: semibold, size: 15 }); y += lh(15) + 4;
  para('This page lists every step of this agreement, as Vitals OS recorded it. Times are shown in the sender\'s time zone.', { size: 9, fill: MUTED });
  const facts = [['Agreement', model.title], ['Reference', model.reference], ['Draft signed', String(model.version)],
    ['Status', model.status === 'active' ? `Signed by everyone${model.signedAt ? ` on ${model.signedAt}` : ''}` : 'Not signed by everyone yet'],
    ['SHA-256 of the words', model.sha256], ['Printed', model.printed]];
  for (const [k, v] of facts) {
    if (!v) continue;
    const ls = wrap(v, regular, 9, inner - 130);
    ensure(lh(9) * ls.length + 2);
    text(k, M, y + 9, { font: semibold, size: 9, fill: MUTED });
    ls.forEach((l, i) => text(l, M + 130, y + 9 + i * lh(9), { size: 9 }));
    y += lh(9) * ls.length + 3;
  }
  y += 8; rule(y); y += 12;
  for (const e of model.audit ?? []) {
    const detail = [e.detail, e.via, e.who].filter(Boolean).join(' · ');
    const ls = wrap(detail, regular, 8.5, inner - 130);
    ensure(lh(9.5) + lh(8.5) * ls.length + 6);
    text(e.at, M, y + 9.5, { size: 8.5, fill: MUTED });
    text(e.what, M + 130, y + 9.5, { font: semibold, size: 9.5 });
    y += lh(9.5);
    ls.forEach((l) => { text(l, M + 130, y + 8.5, { size: 8.5, fill: MUTED }); y += lh(8.5); });
    y += 6;
  }

  // Page numbers.
  pages.forEach((p, i) => {
    const t = clean(`${i + 1} / ${pages.length}`);
    p.drawText(t, { x: W - M - regular.widthOfTextAtSize(t, 7.5), y: 26, size: 7.5, font: regular, color: MUTED });
    if (model.reference) p.drawText(clean(model.reference), { x: M, y: 26, size: 7.5, font: regular, color: MUTED });
  });
  return { bytes: await pdf.save(), pages: pages.length };
}
