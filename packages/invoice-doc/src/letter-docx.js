// COMP-A: the letter model as a .docx file, for HR who want to edit or file it in Word. Same parts and words as the PDF.
import { AlignmentType, BorderStyle, CharacterSet, Document, Footer, ImageRun, Packer, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType } from 'docx';

const TWIP = 20;
const hex = (h) => String(h).replace('#', '').toUpperCase();
const tintHex = (h, t) => {
  const n = parseInt(hex(h), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

export async function renderLetterDocx(model, { fonts } = {}) {
  const fs = model.fontScale || 1, half = (pt) => Math.round(pt * fs * 2), FONT = 'Inter';
  const C = { accent: hex(model.colors.accent), text: hex(model.colors.text), muted: hex(model.colors.muted), tint: tintHex(model.colors.accent, 0.9) };
  const inner = (model.page.width - 2 * model.page.margin) * TWIP;
  const run = (text, { bold = false, size = 10, color = C.text, caps = false } = {}) => new TextRun({ text: String(text ?? ''), bold, size: half(size), color, font: FONT, allCaps: caps });
  const para = (children, { align = AlignmentType.LEFT, after = 0, before = 0, border } = {}) =>
    new Paragraph({ children: Array.isArray(children) ? children : [children], alignment: align, spacing: { after: after * TWIP, before: before * TWIP, line: 276 }, border });
  const image = (a, h, maxW) => (a?.bytes ? new ImageRun({ type: a.mime === 'image/png' ? 'png' : 'jpg', data: a.bytes,
    transformation: { width: Math.min(maxW, h * (a.width && a.height ? a.width / a.height : 3)) * 96 / 72, height: h * 96 / 72 } }) : null);
  const blocks = [];
  const logo = model.logo ? image(model.logo, model.logo.height, 170) : null;
  if (logo) blocks.push(para(logo, { align: model.logo.position === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT, after: 6 }));
  blocks.push(para([run(model.company.name, { bold: true, size: 12.5 })]));
  for (const l of model.company.lines) blocks.push(para(run(l, { size: 8, color: C.muted })));
  blocks.push(para([run(model.date, { bold: true, size: 9 }), ...(model.reference ? [run(`   ${model.reference}`, { size: 8, color: C.muted })] : [])],
    { align: AlignmentType.RIGHT, after: 10, border: { bottom: { style: BorderStyle.SINGLE, size: model.style === 'line' ? 12 : 4, color: model.style === 'minimal' ? 'E2E4E8' : C.accent, space: 4 } } }));
  blocks.push(para(run('To', { bold: true, size: 7, color: C.muted, caps: true }), { before: 8 }));
  blocks.push(para(run(model.to.name, { bold: true, size: 10.5 })));
  for (const l of model.to.lines) blocks.push(para(run(l, { size: 9, color: C.muted })));
  blocks.push(para(run(model.title, { bold: true, size: 13, color: C.accent }), { before: 12, after: 8 }));
  for (const p of model.paragraphs) blocks.push(para(run(p), { after: 7 }));
  if (model.table) {
    const t = model.table, n = t.columns.length, first = Math.round(inner * (n === 2 ? 0.7 : 0.5)), rest = Math.round((inner - first) / (n - 1));
    const widths = [first, ...Array(n - 1).fill(rest)];
    const cell = (text, i, { head = false, strong = false } = {}) => new TableCell({
      children: [para(run(text, { bold: head || strong || i === 0, size: head ? 8 : 9, color: head ? C.accent : C.text }), { align: i ? AlignmentType.RIGHT : AlignmentType.LEFT })],
      width: { size: widths[i], type: WidthType.DXA }, shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: C.tint } : undefined,
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
      borders: { top: NONE, left: NONE, right: NONE, bottom: { style: BorderStyle.SINGLE, size: strong ? 8 : 4, color: strong ? C.text : 'E2E4E8' } },
    });
    const rows = [new TableRow({ children: t.columns.map((c, i) => cell(c, i, { head: true })) }), ...t.rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, i)) })),
      ...(t.total ? [new TableRow({ children: t.total.map((c, i) => cell(c, i, { strong: true })) })] : [])];
    blocks.push(new Table({ rows, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED }));
    blocks.push(para(run(''), { after: 8 }));
  }
  blocks.push(para(run('Yours sincerely,'), { before: 6, after: 6 }));
  if (model.signature) {
    const s = model.signature, sig = s.image ? image(s.image, 32, 180) : null;
    blocks.push(para(run(s.forLine, { bold: true, size: 9 })));
    blocks.push(sig ? para(sig) : para(run(''), { after: 24 }));
    blocks.push(para(run(s.label, { size: 8.5, color: C.muted }), { border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.muted, space: 2 } } }));
    if ([s.name, s.title].filter(Boolean).length) blocks.push(para(run([s.name, s.title].filter(Boolean).join(', '), { size: 8.5 })));
  }
  if (model.acceptLine) {
    blocks.push(para(run('Accepted', { bold: true, size: 7, color: C.muted, caps: true }), { before: 16 }));
    blocks.push(model.accepted ? para(run(`${model.accepted.name}, ${model.accepted.at}`, { bold: true, size: 10 }))
      : para(run('Name, signature and date', { size: 8.5, color: C.muted }), { before: 24, border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.muted, space: 2 } } }));
  }
  const footer = new Footer({ children: [new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'E2E4E8', space: 4 } }, tabStops: [{ type: 'right', position: inner }],
    children: [run(model.footer ?? '', { size: 7, color: C.muted }), new TextRun({ children: ['\tPage ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: half(7), color: C.muted, font: FONT })] })] });
  const doc = new Document({
    creator: 'Pulse', title: model.meta_info?.title ?? model.title, description: model.meta_info?.subject ?? '',
    fonts: fonts ? [{ name: FONT, data: fonts.regular, characterSet: CharacterSet.ANSI }] : undefined,
    styles: { default: { document: { run: { font: FONT, size: half(10), color: C.text } } } },
    sections: [{ properties: { page: { size: { width: Math.round(model.page.width * TWIP), height: Math.round(model.page.height * TWIP) },
      margin: { top: model.page.margin * TWIP, bottom: model.page.margin * TWIP, left: model.page.margin * TWIP, right: model.page.margin * TWIP, footer: 20 * TWIP } } },
      footers: { default: footer }, children: blocks }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
