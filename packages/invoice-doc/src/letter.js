// COMP-A: letters about pay (an offer, a revision, a promotion, probation, a pause, the full and final). They use the
// ERP template's design (colours, logo, signature, footer, fonts), and one model is drawn as the PDF (the browser's live
// preview and the API's filed copy: same code, same bytes) and as DOCX. The words are the company's templates with the
// fields filled in here, so the preview and the issued letter can never say different things.
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb } from 'pdf-lib';
import { formatAmount, formatDate } from './gst.js';
import { imageSize, normaliseDesign } from './model.js';

export const LETTER_KINDS = Object.freeze(['offer', 'revision', 'promotion', 'role_change', 'correction', 'start', 'probation_confirm', 'probation_extend',
  'probation_end', 'pause', 'settlement']);

/** The default letters (India). A company replaces any of them in its pay policy; {{field}} is filled from the letter's data. */
export const LETTER_DEFAULTS = Object.freeze({
  offer: { title: 'Offer of employment', body: 'Dear {{firstName}},\n\nWe are pleased to offer you the role of {{role}} at {{company}}, starting on {{start}}.\n\n{{paySentence}}\n\n{{probationSentence}} {{noticeSentence}}\n\n{{terms}}\n\nThis offer is open until {{validUntil}}. To accept it, use the link we shared with you, or answer it in Pulse.\n\nWe look forward to working with you.' },
  revision: { title: 'Revision of your pay', body: 'Dear {{firstName}},\n\n{{changeSentence}}\n\n{{reason}}\n\nAll other terms of your {{engagement}} stay the same.\n\nThank you for your work.' },
  promotion: { title: 'Promotion', body: 'Dear {{firstName}},\n\nWe are pleased to tell you that you are promoted to {{role}}, effective {{effective}}.\n\n{{paySentence}}\n\n{{reason}}\n\nCongratulations, and thank you.' },
  role_change: { title: 'Change of role', body: 'Dear {{firstName}},\n\nYour role changes from {{previousRole}} to {{role}}, effective {{effective}}.\n\n{{paySentence}}\n\n{{reason}}\n\nAll other terms of your {{engagement}} stay the same.' },
  correction: { title: 'Correction to your pay record', body: 'Dear {{firstName}},\n\nWe have corrected your pay record from {{effective}}. {{paySentence}}\n\n{{reason}}\n\nThis replaces the figures we gave you before. We are sorry for the confusion.' },
  start: { title: 'Confirmation of your pay', body: 'Dear {{firstName}},\n\nThis letter records your pay as {{role}} from {{effective}}. {{paySentence}}\n\n{{reason}}' },
  probation_confirm: { title: 'Confirmation of employment', body: 'Dear {{firstName}},\n\nWe are pleased to confirm your employment as {{role}} from {{effective}}, at the end of your probation.\n\nFrom now on your notice period is {{noticeConfirmed}} days. All other terms of your employment stay the same.\n\nThank you, and congratulations.' },
  probation_extend: { title: 'Extension of probation', body: 'Dear {{firstName}},\n\nYour probation is extended until {{probationEnd}}.\n\n{{reason}}\n\nWe will review it with you again before that date. Your pay and the other terms of your employment stay the same.' },
  probation_end: { title: 'End of employment during probation', body: 'Dear {{firstName}},\n\nWe have decided to end your employment during probation. Your last working day will be {{lastDay}}.\n\n{{reason}}\n\nWe will prepare your full and final settlement and share it with you. Please return company property by your last working day.' },
  pause: { title: 'Pause in pay', body: 'Dear {{firstName}},\n\nYour pay is paused from {{pauseFrom}} to {{pauseTo}} ({{pauseReason}}). For these days you will be paid {{paidShare}} of your usual pay.\n\n{{reason}}\n\nYour usual pay resumes from {{resumeOn}}. All other terms of your {{engagement}} stay the same.' },
  settlement: { title: 'Full and final settlement and relieving letter', body: 'Dear {{firstName}},\n\nThis letter confirms your full and final settlement with {{company}}. Your last working day was {{lastDay}}, and you are relieved of your duties from the close of that day.\n\nThe statement below lists what is paid to you and what is recovered. The net amount of {{net}} will be paid by {{settleBy}}.\n\nThank you for your time with us, and we wish you well.' },
});

const PAY_TYPE = { salary: 'salary', stipend: 'stipend', contractor: 'contract fee', retainer: 'retainer', hourly: 'hourly rate' };
const PAUSE_REASON = { unpaid_leave: 'unpaid leave', sabbatical: 'sabbatical', hold: 'pay on hold', other: 'as agreed' };
/** Money in whole rupees (or the record's currency code): "₹40,000". Amounts arrive in paise. */
export function letterMoney(paise, currency = 'INR') {
  const text = formatAmount(paise, { decimals: Math.round(Number(paise) || 0) % 100 !== 0 });
  return currency === 'INR' ? `₹${text}` : `${currency} ${text}`;
}

/**
 * The fields a letter's template may name, from the letter's data: figures in paise, dates as YYYY-MM-DD.
 * data: { kind, company, companyLines, name, role, previousRole, payType, currency, monthly, yearly, previousMonthly,
 *   previousYearly, rate, hours, effective, start, validUntil, probationDays, probationEnd, noticeProbation,
 *   noticeConfirmed, terms, reason, pauseFrom, pauseTo, paidPercent, pauseReason, lastDay, settleBy, net }
 */
export function letterFields(data) {
  const d = data ?? {};
  const money = (p) => (p == null || p === '' ? '' : letterMoney(p, d.currency || 'INR'));
  const contractor = ['contractor', 'retainer'].includes(d.payType);
  const per = d.payType === 'hourly' ? `${money(d.rate)} an hour${d.hours ? ` (about ${d.hours} hours a month, ${money(d.monthly)})` : ''}`
    : `${money(d.monthly)} a month${d.yearly && !contractor && d.payType !== 'stipend' ? ` (${money(d.yearly)} a year, cost to company)` : ''}`;
  const paySentence = d.monthly == null && d.rate == null ? '' : `Your ${PAY_TYPE[d.payType] ?? 'pay'} will be ${per}${d.components?.length ? '; the breakdown is below' : ''}.`;
  const up = d.previousMonthly != null && d.monthly != null ? Number(d.monthly) - Number(d.previousMonthly) : null;
  const changeSentence = d.previousMonthly == null ? paySentence
    : `Your ${PAY_TYPE[d.payType] ?? 'pay'} is ${up > 0 ? 'raised' : up < 0 ? 'revised' : 'restated'} from ${money(d.previousMonthly)} to ${per}, effective ${formatDate(d.effective)}.`;
  const prob = Number(d.probationDays) || 0;
  return {
    company: d.company ?? '', name: d.name ?? '', firstName: String(d.name ?? '').split(/\s+/)[0] ?? '', role: d.role ?? '', previousRole: d.previousRole ?? '',
    engagement: contractor ? 'engagement' : 'employment', payType: PAY_TYPE[d.payType] ?? '', monthly: money(d.monthly), yearly: money(d.yearly),
    previousMonthly: money(d.previousMonthly), effective: formatDate(d.effective), start: formatDate(d.start), validUntil: formatDate(d.validUntil),
    probationEnd: formatDate(d.probationEnd), lastDay: formatDate(d.lastDay), settleBy: formatDate(d.settleBy), pauseFrom: formatDate(d.pauseFrom),
    pauseTo: formatDate(d.pauseTo), resumeOn: formatDate(d.resumeOn), net: money(d.net), terms: d.terms ?? '', reason: d.reason ?? '',
    noticeConfirmed: String(d.noticeConfirmed ?? ''), noticeProbation: String(d.noticeProbation ?? ''),
    paidShare: Number(d.paidPercent) > 0 ? `${Number(d.paidPercent)}%` : 'nothing', pauseReason: PAUSE_REASON[d.pauseReason] ?? 'as agreed',
    paySentence, changeSentence,
    probationSentence: prob > 0 ? `Your first ${prob} days are a probation period${d.probationEnd ? `, until ${formatDate(d.probationEnd)}` : ''}.` : contractor ? '' : 'There is no probation period.',
    noticeSentence: d.noticeProbation != null && prob > 0 ? `During probation either side may end the ${contractor ? 'engagement' : 'employment'} with ${d.noticeProbation} days' notice${d.noticeConfirmed != null ? `; after confirmation the notice period is ${d.noticeConfirmed} days` : ''}.`
      : d.noticeConfirmed != null ? `The notice period is ${d.noticeConfirmed} days.` : '',
  };
}

/** A template with its {{fields}} filled; paragraphs left empty by missing fields are dropped. */
export function fillLetter(template, fields) {
  return String(template ?? '').replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_, k) => String(fields[k] ?? '')).split(/\n{2,}/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

/** What a letter says: title, paragraphs and its table, from the kind, the data and the company's own wording. */
export function letterContent(kind, data, overrides = {}) {
  const k = LETTER_KINDS.includes(kind) ? kind : 'revision';
  const own = overrides?.[k] ?? {};
  const t = { title: String(own.title || LETTER_DEFAULTS[k].title).slice(0, 120), body: String(own.body || LETTER_DEFAULTS[k].body).slice(0, 6000) };
  const fields = letterFields({ ...data, kind: k });
  const money = (p) => (p == null ? '' : letterMoney(p, data?.currency || 'INR'));
  let table = null;
  if (k === 'settlement' && Array.isArray(data?.statement)) {
    table = { columns: ['', 'Amount'], rows: data.statement.map((l) => [l.label, `${l.kind === 'deduction' ? '− ' : ''}${money(Math.abs(l.amount))}`]),
      total: ['Net payable', money(data.net)] };
  } else if (Array.isArray(data?.components) && data.components.length) {
    table = { columns: ['', 'A month', 'A year'], rows: data.components.map((c) => [c.label, money(c.amount), money(c.amount * 12)]),
      total: data.monthly != null ? ['Total', money(data.monthly), data.yearly != null ? money(data.yearly) : ''] : null };
  }
  return { kind: k, title: t.title, paragraphs: fillLetter(t.body, fields), table };
}

/**
 * The letter model drawn by the writers. letter: { kind, title, paragraphs, table, date, reference, to: {name, lines},
 * company: {name, lines}, accepted: {name, at} | null, draft }. assets: { logo, signature } images.
 */
export function buildLetterModel(designInput, letter, assets = {}) {
  const design = normaliseDesign(designInput);
  const sized = (a) => (a?.bytes && ['image/png', 'image/jpeg'].includes(a.mime) ? { ...a, ...(imageSize(a.bytes, a.mime) ?? {}) } : null);
  const logo = design.logo.show ? sized(assets.logo) : null;
  const company = letter.company ?? {};
  return {
    page: { width: 595.28, height: 841.89, margin: 48 }, style: design.style, fontScale: design.fontScale,
    colors: { accent: design.accent, text: design.text, muted: design.muted },
    logo: logo ? { ...logo, position: design.logo.position, height: design.logo.height } : null,
    company: { name: String(company.name ?? ''), lines: (company.lines ?? []).map(String).filter(Boolean).slice(0, 6) },
    date: formatDate(letter.date), reference: String(letter.reference ?? ''),
    to: { name: String(letter.to?.name ?? ''), lines: (letter.to?.lines ?? []).map(String).filter(Boolean).slice(0, 4) },
    title: String(letter.title ?? ''), paragraphs: (letter.paragraphs ?? []).map(String), table: letter.table ?? null,
    signature: design.show.signature && letter.kind !== 'payslip' ? { forLine: `For ${company.name ?? ''}`, label: design.signature.label, name: design.signature.name, title: design.signature.title,
      image: design.signature.showImage ? sized(assets.signature) : null } : null,
    // COMP-B: a payslip ends with a line saying who issued it, not a signature.
    ...(letter.kind === 'payslip' ? { closing: `Issued by ${company.name ?? ''} through Pulse. A payslip needs no signature.` } : {}),
    accepted: letter.accepted ?? null, acceptLine: letter.kind === 'offer',
    footer: design.footer || null, draft: !!letter.draft,
    meta_info: { title: String(letter.title ?? ''), subject: String(letter.to?.name ?? ''), date: letter.date ?? null },
  };
}

const hexRgb = (hex) => { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const color = (hex) => { const [r, g, b] = hexRgb(hex); return rgb(r / 255, g / 255, b / 255); };
const tint = (hex, t) => { const [r, g, b] = hexRgb(hex); return rgb((r + (255 - r) * t) / 255, (g + (255 - g) * t) / 255, (b + (255 - b) * t) / 255); };
const RULE = rgb(0.886, 0.894, 0.91);
function fixedDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(Date.UTC(2000, 0, 1));
}

/** The letter on A4: PDF bytes and the page count. */
export async function renderLetterPdf(model, { fonts }) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const semibold = await pdf.embedFont(fonts.semibold, { subset: true });
  const known = new Set(regular.getCharacterSet());
  const clean = (s) => Array.from(String(s ?? '').replace(/\t/g, ' ').replace(/\r/g, '')).map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const embed = async (a) => { if (!a?.bytes) return null; try { return a.mime === 'image/png' ? await pdf.embedPng(a.bytes) : await pdf.embedJpg(a.bytes); } catch { return null; } };
  const logo = await embed(model.logo);
  const sigImage = await embed(model.signature?.image);
  const { width: W, height: H, margin: M } = model.page;
  const fs = model.fontScale || 1, inner = W - 2 * M, FOOT = 10;
  const C = { accent: color(model.colors.accent), text: color(model.colors.text), muted: color(model.colors.muted), tint: tint(model.colors.accent, 0.9) };
  const lh = (size) => size * 1.45;
  const pages = []; let page = null; let y = 0;
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
  function text(s, x, top, { font = regular, size = 10 * fs, fill = C.text, align = 'left', box = 0 } = {}) {
    const t = clean(s); if (!t) return;
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: align === 'right' ? x + box - w : align === 'center' ? x + (box - w) / 2 : x, y: H - top, size, font, color: fill });
  }
  const rule = (x, top, w, fill = RULE, thickness = 0.6) => page.drawLine({ start: { x, y: H - top }, end: { x: x + w, y: H - top }, thickness, color: fill });
  const rect = (x, top, w, h, fill) => page.drawRectangle({ x, y: H - top - h, width: w, height: h, color: fill });
  function newPage() {
    page = pdf.addPage([W, H]); pages.push(page); y = M;
    if (pages.length > 1) { text(`${model.title} · ${model.to.name}`, M, y + 8, { font: semibold, size: 8 * fs, fill: C.muted }); rule(M, y + 14, inner); y += 28; }
  }
  const ensure = (h) => { if (y + h > H - M - FOOT) newPage(); };

  // Letterhead: logo and company on the left, the date and reference on the right.
  newPage();
  const logoH = logo ? model.logo.height : 0, logoW = logo ? Math.min(170, (logo.width / logo.height) * logoH) : 0;
  if (logo) page.drawImage(logo, { x: model.logo.position === 'right' ? W - M - logoW : M, y: H - y - logoH, width: logoW, height: logoH });
  const headTop = y + (logo && model.logo.position !== 'right' ? logoH + 8 : 0);
  text(model.company.name, M, headTop + 12.5 * fs, { font: semibold, size: 12.5 * fs });
  model.company.lines.forEach((l, i) => text(l, M, headTop + lh(12.5 * fs) + 8 * fs + i * lh(8 * fs), { size: 8 * fs, fill: C.muted }));
  const rightTop = y + (logo && model.logo.position === 'right' ? logoH + 8 : 0);
  text(model.date, M, rightTop + 9 * fs, { font: semibold, size: 9 * fs, align: 'right', box: inner });
  if (model.reference) text(model.reference, M, rightTop + 9 * fs + lh(8 * fs), { size: 8 * fs, fill: C.muted, align: 'right', box: inner });
  y = Math.max(headTop + lh(12.5 * fs) + model.company.lines.length * lh(8 * fs), rightTop + lh(9 * fs) * 2) + 10;
  if (model.style === 'band') { rect(M, y, inner, 3, C.accent); y += 18; } else { rule(M, y, inner, model.style === 'line' ? C.accent : RULE, model.style === 'line' ? 1.6 : 0.6); y += 18; }

  // To, subject.
  text('TO', M, y + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
  text(model.to.name, M, y + 9 + 10.5 * fs, { font: semibold, size: 10.5 * fs });
  model.to.lines.forEach((l, i) => text(l, M, y + 9 + lh(10.5 * fs) + 9 * fs + i * lh(9 * fs), { size: 9 * fs, fill: C.muted }));
  y += 9 + lh(10.5 * fs) + model.to.lines.length * lh(9 * fs) + 14;
  for (const l of wrap(model.title, semibold, 13 * fs, inner)) { text(l, M, y + 13 * fs, { font: semibold, size: 13 * fs, fill: C.accent }); y += lh(13 * fs); }
  y += 8;

  // The paragraphs.
  const body = 10 * fs;
  for (const p of model.paragraphs) {
    const ls = wrap(p, regular, body, inner);
    ensure(lh(body) * Math.min(2, ls.length));
    for (const l of ls) { ensure(lh(body)); text(l, M, y + body, { size: body }); y += lh(body); }
    y += 7;
  }

  // The table (pay breakdown or statement).
  if (model.table) {
    const t = model.table, n = t.columns.length, firstW = inner * (n === 2 ? 0.7 : 0.5), restW = (inner - firstW) / (n - 1);
    const xs = [M, ...Array.from({ length: n - 1 }, (_, i) => M + firstW + i * restW)], ws = [firstW, ...Array(n - 1).fill(restW)];
    const cell = 9 * fs, pad = 5, rowH = lh(cell) + pad * 2;
    ensure(rowH * Math.min(3, t.rows.length + 1) + 6);
    y += 4; rect(M, y, inner, rowH, C.tint);
    t.columns.forEach((c, i) => text(c, xs[i] + pad, y + pad + cell, { font: semibold, size: 8 * fs, fill: C.accent, align: i ? 'right' : 'left', box: ws[i] - pad * 2 }));
    y += rowH;
    const row = (cells, strong) => {
      ensure(rowH);
      cells.forEach((c, i) => text(c, xs[i] + pad, y + pad + cell, { font: strong || !i ? semibold : regular, size: cell, align: i ? 'right' : 'left', box: ws[i] - pad * 2 }));
      y += rowH; rule(M, y, inner);
    };
    t.rows.forEach((r) => row(r, false));
    if (t.total) { row(t.total, true); rule(M, y, inner, C.text, 0.9); }
    y += 14;
  }

  // Closing and signature; the offer's acceptance line. A payslip has its issuing line instead (COMP-B).
  if (model.closing) { ensure(lh(8.5 * fs) * 2); for (const l of wrap(model.closing, regular, 8.5 * fs, inner)) { text(l, M, y + 8.5 * fs, { size: 8.5 * fs, fill: C.muted }); y += lh(8.5 * fs); } }
  else { ensure(110);
  text('Yours sincerely,', M, y + body, { size: body }); y += lh(body) + 6; }
  if (model.signature) {
    const s = model.signature;
    text(s.forLine, M, y + 9 * fs, { font: semibold, size: 9 * fs });
    if (sigImage) { const h = 32, w = Math.min(180, (sigImage.width / sigImage.height) * h); page.drawImage(sigImage, { x: M, y: H - (y + 16 + h), width: w, height: h }); }
    rule(M, y + 54, 180, C.muted, 0.5);
    text(s.label, M, y + 54 + 8.5 * fs + 3, { size: 8.5 * fs, fill: C.muted });
    const who = [s.name, s.title].filter(Boolean).join(', ');
    if (who) text(who, M, y + 54 + 8.5 * fs + 3 + lh(8.5 * fs), { size: 8.5 * fs });
    if (model.acceptLine) {
      const ax = M + inner - 200;
      text('ACCEPTED', ax, y + 7 * fs, { font: semibold, size: 7 * fs, fill: C.muted });
      if (model.accepted) {
        text(model.accepted.name, ax, y + 16 + 10 * fs, { font: semibold, size: 10 * fs });
        text(`Accepted on ${formatDate(model.accepted.at)}${model.accepted.via ? ` (${model.accepted.via})` : ''}`, ax, y + 16 + 10 * fs + lh(8.5 * fs), { size: 8.5 * fs, fill: C.muted });
      } else {
        rule(ax, y + 54, 200, C.muted, 0.5);
        text('Name, signature and date', ax, y + 54 + 8.5 * fs + 3, { size: 8.5 * fs, fill: C.muted });
      }
    }
    y += 54 + 8.5 * fs + 3 + (who ? lh(8.5 * fs) : 0) + 10;
  }

  pages.forEach((p, i) => {
    page = p;
    const fy = H - M + 16;
    rule(M, fy - 12, inner);
    if (model.footer) text(model.footer, M, fy, { size: 7 * fs, fill: C.muted });
    text(`Page ${i + 1} of ${pages.length}`, M, fy, { size: 7 * fs, fill: C.muted, align: 'right', box: inner });
    if (model.draft) {
      const size = 96, w = semibold.widthOfTextAtSize('DRAFT', size), a = 35 * Math.PI / 180;
      p.drawText('DRAFT', { x: W / 2 - (w / 2) * Math.cos(a), y: H / 2 - (w / 2) * Math.sin(a), size, font: semibold, color: C.accent, opacity: 0.07, rotate: degrees(35) });
    }
  });
  const when = fixedDate(model.meta_info?.date);
  pdf.setTitle(clean(model.meta_info?.title ?? model.title)); pdf.setSubject(clean(model.meta_info?.subject ?? ''));
  pdf.setAuthor(clean(model.company.name)); pdf.setCreator('Pulse'); pdf.setProducer('Pulse (pdf-lib)');
  pdf.setCreationDate(when); pdf.setModificationDate(when);
  return { bytes: await pdf.save(), pages: pages.length };
}
