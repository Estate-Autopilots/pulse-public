// ERP-INVOICE: the PDF writer. One layout for the browser's live preview and the API's issued copy: the same model,
// fonts and code give the same pages (and, with fixed metadata, the same bytes) on both sides.
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb } from 'pdf-lib';

const hexRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const color = (hex) => { const [r, g, b] = hexRgb(hex); return rgb(r / 255, g / 255, b / 255); };
/** The colour `t` of the way from `hex` to white (0.9 → a pale tint). */
const tint = (hex, t) => { const [r, g, b] = hexRgb(hex); return rgb((r + (255 - r) * t) / 255, (g + (255 - g) * t) / 255, (b + (255 - b) * t) / 255); };
const RULE = rgb(0.886, 0.894, 0.91);
const WHITE = rgb(1, 1, 1);

/** Fixed document dates (the issue date) so the same document always gives the same file. */
function fixedDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(Date.UTC(2000, 0, 1));
}

/**
 * The model drawn on A4. `fonts` are the regular and semibold font files (TTF bytes). Returns the PDF bytes and the
 * page count.
 */
export async function renderPdf(model, { fonts }) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const semibold = await pdf.embedFont(fonts.semibold, { subset: true });
  const known = new Set(regular.getCharacterSet());
  const clean = (s) => Array.from(String(s ?? '').replace(/\t/g, ' ').replace(/\r/g, '')).map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const embed = async (asset) => {
    if (!asset?.bytes) return null;
    try { return asset.mime === 'image/png' ? await pdf.embedPng(asset.bytes) : asset.mime === 'image/jpeg' ? await pdf.embedJpg(asset.bytes) : null; } catch { return null; }
  };
  const logo = await embed(model.logo);
  const signatureImage = await embed(model.signature?.image);

  const { width: W, height: H, margin: M } = model.page;
  const fs = model.fontScale || 1;
  const C = { accent: color(model.colors.accent), text: color(model.colors.text), muted: color(model.colors.muted), tint: tint(model.colors.accent, 0.9), soft: tint(model.colors.accent, 0.96) };
  const inner = W - 2 * M;
  const FOOT = 8; // the footer and page number sit in the bottom margin; keep a little air above them
  const pages = [];
  let page = null;
  let y = 0;

  const width = (s, font, size) => font.widthOfTextAtSize(clean(s), size);
  /** Text broken into lines that fit `max` points; long words break by character. */
  function wrap(s, font, size, max) {
    const out = [];
    for (const para of clean(s).split('\n')) {
      let line = '';
      for (const word of para.split(/ +/)) {
        const tryLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(tryLine, size) <= max) { line = tryLine; continue; }
        if (line) out.push(line);
        let piece = word;
        while (font.widthOfTextAtSize(piece, size) > max && piece.length > 1) {
          let cut = piece.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > max) cut--;
          out.push(piece.slice(0, cut));
          piece = piece.slice(cut);
        }
        line = piece;
      }
      out.push(line);
    }
    return out;
  }
  const lh = (size) => size * 1.38;
  /** Draws one line with its baseline `top` points below the page's top edge. */
  function text(s, x, top, { font = regular, size = 9 * fs, fill = C.text, align = 'left', box = 0 } = {}) {
    const t = clean(s);
    if (!t) return;
    const w = font.widthOfTextAtSize(t, size);
    const left = align === 'right' ? x + box - w : align === 'center' ? x + (box - w) / 2 : x;
    page.drawText(t, { x: left, y: H - top, size, font, color: fill });
  }
  function rect(x, top, w, h, fill) { page.drawRectangle({ x, y: H - top - h, width: w, height: h, color: fill }); }
  function rule(x, top, w, fill = RULE, thickness = 0.6) { page.drawLine({ start: { x, y: H - top }, end: { x: x + w, y: H - top }, thickness, color: fill }); }
  /** Lines of text drawn from `top`; returns the height used. */
  function block(list, x, top, opts) {
    const size = opts.size ?? 9 * fs;
    list.forEach((l, i) => text(l, x, top + size + i * lh(size), { ...opts, size }));
    return list.length * lh(size);
  }

  function newPage() {
    page = pdf.addPage([W, H]);
    pages.push(page);
    y = M;
    if (pages.length > 1) {
      text(`${model.title} · ${model.meta[0][1]}`, M, y + 8, { font: semibold, size: 8 * fs, fill: C.muted });
      text(model.seller.name, M, y + 8, { size: 8 * fs, fill: C.muted, align: 'right', box: inner });
      rule(M, y + 14, inner);
      y += 26;
    }
  }
  /** Starts a new page unless `h` more points fit above the footer. */
  function ensure(h) { if (y + h > H - M - FOOT) newPage(); }

  // ---------------------------------------------------------------------------------------------------- header
  newPage();
  const band = model.style === 'band';
  const onBand = band ? WHITE : null;
  const titleSize = 19 * fs, nameSize = 12.5 * fs, small = 8 * fs;
  const logoH = logo ? model.logo.height : 0;
  const logoW = logo ? Math.min(170, (logo.width / logo.height) * logoH) : 0;
  const leftLogo = logo && model.logo.position === 'left';
  // A left logo sits above the company's name (as in the DOCX), so the address keeps its full width.
  const sellerX = M;
  const sellerW = inner * 0.58;
  const sellerTop = leftLogo ? logoH + 8 : 0;
  const sellerLines = model.seller.lines.flatMap((l) => wrap(l, regular, small, sellerW));
  const sellerH = sellerTop + lh(nameSize) + sellerLines.length * lh(small);
  const titleLines = wrap(model.title, semibold, titleSize, inner * 0.4);
  const rightLogoH = logo && !leftLogo ? logoH + 8 : 0;
  const titleH = rightLogoH + titleLines.length * lh(titleSize) + lh(9.5 * fs) + (model.draft || model.cancelled ? 18 : 0);
  const headH = Math.max(sellerH, titleH);
  const pad = band ? 22 : 0;
  if (band) rect(0, 0, W, headH + pad * 2 + M - 18, C.accent);
  const top = band ? M - 18 + pad : y;
  if (leftLogo) page.drawImage(logo, { x: M, y: H - top - logoH, width: logoW, height: logoH });
  text(model.seller.name, sellerX, top + sellerTop + nameSize, { font: semibold, size: nameSize, fill: onBand ?? C.text });
  block(sellerLines, sellerX, top + sellerTop + lh(nameSize), { size: small, fill: band ? tint(model.colors.accent, 0.82) : C.muted });
  let ty = top;
  if (logo && !leftLogo) { page.drawImage(logo, { x: W - M - logoW, y: H - ty - logoH, width: logoW, height: logoH }); ty += logoH + 8; }
  titleLines.forEach((l, i) => text(l, M, ty + titleSize + i * lh(titleSize), { font: semibold, size: titleSize, fill: onBand ?? C.accent, align: 'right', box: inner }));
  ty += titleLines.length * lh(titleSize);
  text(model.meta[0][1], M, ty + 9.5 * fs + 2, { font: semibold, size: 9.5 * fs, fill: onBand ?? C.text, align: 'right', box: inner });
  ty += lh(9.5 * fs) + 4;
  if (model.draft || model.cancelled) {
    const tag = model.cancelled ? 'CANCELLED' : 'DRAFT';
    const tw = width(tag, semibold, 7.5 * fs) + 14;
    const tagFill = model.cancelled ? rgb(0.86, 0.2, 0.2) : band ? WHITE : C.tint;
    rect(W - M - tw, ty, tw, 13, tagFill);
    text(tag, W - M - tw, ty + 9.3, { font: semibold, size: 7.5 * fs, fill: model.cancelled ? WHITE : C.accent, align: 'center', box: tw });
  }
  y = top + headH + (band ? pad + 10 : 12);
  if (model.style === 'line') { rule(M, y, inner, C.accent, 1.6); y += 14; } else if (model.style === 'minimal') { rule(M, y, inner); y += 14; }

  // ------------------------------------------------------------------------------------ parties and the details
  const leftW = inner * 0.52, rightX = M + inner * 0.56, rightW = inner * 0.44;
  let partyH = 0;
  for (const p of model.parties) {
    const pl = p.lines.flatMap((l) => wrap(l, regular, 8.5 * fs, leftW));
    const nameLines = wrap(p.name, semibold, 10.5 * fs, leftW);
    text(p.heading.toUpperCase(), M, y + partyH + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
    block(nameLines, M, y + partyH + 11 * fs, { font: semibold, size: 10.5 * fs });
    block(pl, M, y + partyH + 11 * fs + nameLines.length * lh(10.5 * fs), { size: 8.5 * fs });
    partyH += 11 * fs + nameLines.length * lh(10.5 * fs) + pl.length * lh(8.5 * fs) + 8;
  }
  const metaRows = model.meta.slice(1).map(([k, v]) => ({ k, v: wrap(v, semibold, 8.5 * fs, rightW * 0.58) }));
  const metaH = metaRows.reduce((n, r) => n + r.v.length * lh(8.5 * fs) + 4, 10);
  rect(rightX - 10, y - 4, rightW + 10, metaH + 2, C.soft);
  let my = y + 4;
  for (const r of metaRows) {
    text(r.k, rightX, my + 8.5 * fs, { size: 8.5 * fs, fill: C.muted });
    r.v.forEach((v, i) => text(v, rightX, my + 8.5 * fs + i * lh(8.5 * fs), { font: semibold, size: 8.5 * fs, align: 'right', box: rightW - 8 }));
    my += r.v.length * lh(8.5 * fs) + 4;
  }
  y += Math.max(partyH, metaH) + 14;

  // ------------------------------------------------------------------------------------------------ line items
  const cols = model.table.columns.map((c) => ({ ...c, w: c.width * inner }));
  let cx = M;
  for (const c of cols) { c.x = cx; cx += c.w; }
  const cell = 8.5 * fs, sub = 7 * fs, padX = 4, padY = 4;
  function tableHead() {
    const hh = lh(7.5 * fs) + padY * 2;
    if (model.style === 'minimal') rule(M, y + hh, inner, C.text, 0.8); else rect(M, y, inner, hh, C.tint);
    for (const c of cols) text(c.label, c.x + padX, y + padY + 7.5 * fs, { font: semibold, size: 7.5 * fs, fill: model.style === 'minimal' ? C.muted : C.accent, align: c.align, box: c.w - padX * 2 });
    y += hh;
  }
  ensure(60);
  tableHead();
  for (const row of model.table.rows) {
    const content = cols.map((c) => {
      const main = c.key === 'item' ? wrap(row.cells[c.key] ?? '', regular, cell, c.w - padX * 2) : [row.cells[c.key] ?? ''];
      const extra = row.sub?.[c.key] ? wrap(row.sub[c.key], regular, sub, c.w - padX * 2) : [];
      return { main, extra, h: main.length * lh(cell) + extra.length * lh(sub) };
    });
    const rowH = Math.max(...content.map((c) => c.h)) + padY * 2;
    if (y + rowH > H - M - FOOT) { newPage(); tableHead(); }
    cols.forEach((c, i) => {
      const { main, extra } = content[i];
      main.forEach((l, j) => text(l, c.x + padX, y + padY + cell + j * lh(cell), { font: c.key === 'item' ? semibold : regular, size: cell, align: c.align, box: c.w - padX * 2 }));
      extra.forEach((l, j) => text(l, c.x + padX, y + padY + main.length * lh(cell) + sub + j * lh(sub), { size: sub, fill: C.muted, align: c.align, box: c.w - padX * 2 }));
    });
    y += rowH;
    rule(M, y, inner);
  }
  y += 10;

  // -------------------------------------------------------------------------- words and notes | totals, balance
  const totW = 220, totX = W - M - totW, noteW = inner - totW - 24;
  const totalRows = [...model.totals, ...(model.balance ?? [])];
  const totH = totalRows.reduce((n, r) => n + (r.strong ? lh(10.5 * fs) + 10 : lh(8.5 * fs) + 3), 0);
  const wordLines = model.words ? wrap(model.words, semibold, 8.5 * fs, noteW) : [];
  const noteLines = model.notes ? wrap(model.notes, regular, 8 * fs, noteW) : [];
  const leftH = (wordLines.length ? 12 + wordLines.length * lh(8.5 * fs) + 8 : 0) + (noteLines.length ? 12 + noteLines.length * lh(8 * fs) : 0);
  ensure(Math.max(totH, leftH));
  let ly = y;
  if (wordLines.length) {
    text('AMOUNT IN WORDS', M, ly + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
    block(wordLines, M, ly + 10 * fs, { font: semibold, size: 8.5 * fs });
    ly += 12 + wordLines.length * lh(8.5 * fs) + 8;
  }
  if (noteLines.length) {
    text('NOTES', M, ly + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
    block(noteLines, M, ly + 10 * fs, { size: 8 * fs, fill: C.text });
    ly += 12 + noteLines.length * lh(8 * fs);
  }
  let ry = y;
  for (const r of totalRows) {
    if (r.strong) {
      rule(totX, ry + 2, totW, C.text, 0.8);
      rect(totX, ry + 3, totW, lh(10.5 * fs) + 6, C.soft);
      text(r.label, totX + 6, ry + 6 + 10.5 * fs, { font: semibold, size: 10.5 * fs });
      text(r.value, totX, ry + 6 + 10.5 * fs, { font: semibold, size: 10.5 * fs, align: 'right', box: totW - 6 });
      ry += lh(10.5 * fs) + 10;
    } else {
      text(r.label, totX + 6, ry + 8.5 * fs, { size: 8.5 * fs, fill: C.muted });
      text(r.value, totX, ry + 8.5 * fs, { size: 8.5 * fs, align: 'right', box: totW - 6 });
      ry += lh(8.5 * fs) + 3;
    }
  }
  y = Math.max(ly, ry) + 14;

  // --------------------------------------------------------------------------------------------- tax summary
  if (model.taxSummary) {
    const t = model.taxSummary;
    const n = t.columns.length;
    const tw = inner / n;
    const rowH = lh(7.5 * fs) + 6;
    ensure(rowH * (t.rows.length + 3) + 14);
    text('TAX SUMMARY (SAC/HSN)', M, y + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
    y += 12;
    rect(M, y, inner, rowH, C.soft);
    t.columns.forEach((c, i) => text(c, M + i * tw + 4, y + 3 + 7.5 * fs, { font: semibold, size: 7.5 * fs, fill: C.muted, align: i ? 'right' : 'left', box: tw - 8 }));
    y += rowH;
    for (const [i, r] of [...t.rows, t.total].entries()) {
      const last = i === t.rows.length;
      if (last) rule(M, y, inner, C.text, 0.6);
      r.forEach((c, k) => text(c, M + k * tw + 4, y + 3 + 7.5 * fs, { font: last ? semibold : regular, size: 7.5 * fs, align: k ? 'right' : 'left', box: tw - 8 }));
      y += rowH;
    }
    y += 8;
  }

  // ------------------------------------------------------------------------------------- bank | signature
  if (model.bank || model.signature) {
    const sigW = 200, bankW = inner - sigW - 24;
    const bankH = model.bank ? 12 + model.bank.length * (lh(8 * fs) + 1) : 0;
    const sigH = model.signature ? 48 + 8 * fs + 3 + ([model.signature.name, model.signature.title].some(Boolean) ? lh(8 * fs) : 0) + 4 : 0;
    ensure(Math.max(bankH, sigH) + 6);
    if (model.bank) {
      text('BANK DETAILS', M, y + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
      model.bank.forEach(([k, v], i) => {
        const top = y + 12 + 8 * fs + i * (lh(8 * fs) + 1);
        text(k, M, top, { size: 8 * fs, fill: C.muted });
        text(v, M + 78, top, { font: semibold, size: 8 * fs });
      });
    }
    if (model.signature) {
      const s = model.signature, sx = W - M - sigW;
      text(s.forLine, sx, y + 8.5 * fs, { font: semibold, size: 8.5 * fs, align: 'right', box: sigW });
      if (signatureImage) {
        const h = 30, w = Math.min(sigW, (signatureImage.width / signatureImage.height) * h);
        page.drawImage(signatureImage, { x: W - M - w, y: H - (y + 14 + h), width: w, height: h });
      }
      rule(sx + 40, y + 48, sigW - 40, C.muted, 0.5);
      text(s.label, sx, y + 48 + 8 * fs + 3, { size: 8 * fs, fill: C.muted, align: 'right', box: sigW });
      const who = [s.name, s.title].filter(Boolean).join(', ');
      if (who) text(who, sx, y + 48 + 8 * fs + 3 + lh(8 * fs), { size: 8 * fs, align: 'right', box: sigW });
    }
    y += Math.max(bankH, sigH) + 10;
  }

  // ----------------------------------------------------------------------------------------------------- terms
  if (model.terms) {
    const termLines = wrap(model.terms, regular, 7.5 * fs, inner);
    ensure(12 + lh(7.5 * fs) * Math.min(2, termLines.length)); // the heading never ends a page alone
    text('TERMS & CONDITIONS', M, y + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
    y += 12;
    for (const l of termLines) {
      ensure(lh(7.5 * fs));
      text(l, M, y + 7.5 * fs, { size: 7.5 * fs, fill: C.muted });
      y += lh(7.5 * fs);
    }
  }

  // ------------------------------------------------------------------------- footer, page numbers, watermark
  pages.forEach((p, i) => {
    page = p;
    const fy = H - M + 14;
    rule(M, fy - 12, inner);
    if (model.footer) text(model.footer, M, fy, { size: 7 * fs, fill: C.muted });
    if (model.pageNumbers) text(`Page ${i + 1} of ${pages.length}`, M, fy, { size: 7 * fs, fill: C.muted, align: 'right', box: inner });
    if (model.draft || model.cancelled) {
      const word = model.cancelled ? 'CANCELLED' : 'DRAFT';
      const size = 96;
      const w = semibold.widthOfTextAtSize(word, size);
      const angle = 35 * Math.PI / 180;
      p.drawText(word, { x: W / 2 - (w / 2) * Math.cos(angle), y: H / 2 - (w / 2) * Math.sin(angle), size, font: semibold, color: model.cancelled ? rgb(0.86, 0.2, 0.2) : C.accent, opacity: 0.07, rotate: degrees(35) });
    }
  });

  const when = fixedDate(model.meta_info?.date);
  pdf.setTitle(clean(model.meta_info?.title ?? model.title));
  pdf.setSubject(clean(model.meta_info?.subject ?? ''));
  pdf.setAuthor(clean(model.seller.name));
  pdf.setCreator('Pulse ERP');
  pdf.setProducer('Pulse ERP (pdf-lib)');
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);
  const bytes = await pdf.save();
  return { bytes, pages: pages.length };
}
