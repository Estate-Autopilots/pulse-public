// ERP-INVOICE: the DOCX writer. The same model as the PDF, as Word tables: the same parts, order, wording, figures,
// colours and fonts (embedded), for a client or accountant who wants to edit or file the document in Word.
import { AlignmentType, BorderStyle, CharacterSet, Document, Footer, ImageRun, Packer, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType } from 'docx';

const TWIP = 20; // twips per point
const hex = (h) => String(h).replace('#', '').toUpperCase();
const tintHex = (h, t) => {
  const n = parseInt(hex(h), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const RULE = 'E2E4E8';

/** The model as a .docx file (bytes). `fonts` (optional) embeds the regular and semibold faces. */
export async function renderDocx(model, { fonts } = {}) {
  const fs = model.fontScale || 1;
  const half = (pt) => Math.round(pt * fs * 2); // docx sizes are half-points
  const C = { accent: hex(model.colors.accent), text: hex(model.colors.text), muted: hex(model.colors.muted), tint: tintHex(model.colors.accent, 0.9), soft: tintHex(model.colors.accent, 0.96) };
  const FONT = 'Inter';
  const band = model.style === 'band';
  const inner = (model.page.width - 2 * model.page.margin) * TWIP;

  const run = (text, { bold = false, size = 9, color = C.text, caps = false } = {}) =>
    new TextRun({ text: String(text ?? ''), bold, size: half(size), color, font: FONT, allCaps: caps });
  const para = (children, { align = AlignmentType.LEFT, after = 0, before = 0, border } = {}) =>
    new Paragraph({ children: Array.isArray(children) ? children : [children], alignment: align, spacing: { after: after * TWIP, before: before * TWIP, line: 264 }, border });
  const lines = (list, opts, align) => list.map((l) => para(run(l, opts), { align }));
  const image = (asset, heightPt, maxWidthPt) => {
    if (!asset?.bytes || !['image/png', 'image/jpeg'].includes(asset.mime)) return null;
    const ratio = asset.width && asset.height ? asset.width / asset.height : 3;
    const h = heightPt, w = Math.min(maxWidthPt, h * ratio);
    return new ImageRun({ type: asset.mime === 'image/png' ? 'png' : 'jpg', data: asset.bytes, transformation: { width: w * 96 / 72, height: h * 96 / 72 } });
  };
  const cell = (children, { width, shade, margins = 80, valign } = {}) => new TableCell({
    children: children.length ? children : [para(run(''))], width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, color: 'auto', fill: shade } : undefined, verticalAlign: valign ?? VerticalAlign.TOP,
    margins: { top: margins, bottom: margins, left: margins, right: margins }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
  });
  const grid = (rows, widths, extra = {}) => new Table({
    rows, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths,
    layout: TableLayoutType.FIXED, borders: NO_BORDERS, ...extra,
  });
  const ruleBelow = (color = RULE, size = 4) => ({ bottom: { style: BorderStyle.SINGLE, size, color, space: 1 } });

  // Header: seller (with logo) | title, number, draft mark.
  const onBand = band ? 'FFFFFF' : null;
  const logoRun = model.logo ? image(model.logo, model.logo.height, 170) : null;
  const sellerParts = [
    ...(logoRun && model.logo.position === 'left' ? [para(logoRun, { after: 6 })] : []),
    para(run(model.seller.name, { bold: true, size: 12.5, color: onBand ?? C.text })),
    ...lines(model.seller.lines, { size: 8, color: band ? tintHex(model.colors.accent, 0.82) : C.muted }),
  ];
  const titleParts = [
    ...(logoRun && model.logo.position === 'right' ? [para(logoRun, { align: AlignmentType.RIGHT, after: 6 })] : []),
    para(run(model.title, { bold: true, size: 19, color: onBand ?? C.accent }), { align: AlignmentType.RIGHT }),
    para(run(model.meta[0][1], { bold: true, size: 9.5, color: onBand ?? C.text }), { align: AlignmentType.RIGHT }),
    ...(model.draft || model.cancelled ? [para(run(model.cancelled ? 'CANCELLED' : 'DRAFT', { bold: true, size: 7.5, color: model.cancelled ? 'DC3333' : C.accent }), { align: AlignmentType.RIGHT, before: 4 })] : []),
  ];
  const header = grid([new TableRow({ children: [
    cell(sellerParts, { width: inner * 0.58, shade: band ? C.accent : undefined, margins: band ? 300 : 0 }),
    cell(titleParts, { width: inner * 0.42, shade: band ? C.accent : undefined, margins: band ? 300 : 0 }),
  ] })], [inner * 0.58, inner * 0.42]);
  const headerRule = model.style === 'line' ? para(run(''), { border: ruleBelow(C.accent, 12), after: 10 }) : model.style === 'minimal' ? para(run(''), { border: ruleBelow(), after: 10 }) : para(run(''), { after: 10 });

  // Parties | details.
  const partyParts = model.parties.flatMap((p) => [
    para(run(p.heading, { bold: true, size: 7, color: C.muted, caps: true })),
    para(run(p.name, { bold: true, size: 10.5 })),
    ...lines(p.lines, { size: 8.5 }),
  ]);
  const metaTable = grid(model.meta.slice(1).map(([k, v]) => new TableRow({ children: [
    cell([para(run(k, { size: 8.5, color: C.muted }))], { width: inner * 0.18, shade: C.soft, margins: 40 }),
    cell([para(run(v, { bold: true, size: 8.5 }), { align: AlignmentType.RIGHT })], { width: inner * 0.26, shade: C.soft, margins: 40 }),
  ] })), [inner * 0.18, inner * 0.26]);
  const parties = grid([new TableRow({ children: [cell(partyParts, { width: inner * 0.56, margins: 0 }), cell([metaTable], { width: inner * 0.44, margins: 0 })] })], [inner * 0.56, inner * 0.44]);

  // Line items.
  const widths = model.table.columns.map((c) => Math.round(c.width * inner));
  const alignOf = (c) => (c.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT);
  const headRow = new TableRow({ tableHeader: true, children: model.table.columns.map((c, i) => cell([para(run(c.label, { bold: true, size: 7.5, color: model.style === 'minimal' ? C.muted : C.accent }), { align: alignOf(c) })],
    { width: widths[i], shade: model.style === 'minimal' ? undefined : C.tint, margins: 70 })) });
  const bodyRows = model.table.rows.map((r) => new TableRow({ cantSplit: true, children: model.table.columns.map((c, i) => cell([
    para(run(r.cells[c.key] ?? '', { bold: c.key === 'item', size: 8.5 }), { align: alignOf(c) }),
    ...(r.sub?.[c.key] ? [para(run(r.sub[c.key], { size: 7, color: C.muted }), { align: alignOf(c) })] : []),
  ], { width: widths[i], margins: 70 })) }));
  const items = grid([headRow, ...bodyRows], widths, { borders: { ...NO_BORDERS, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } } });

  // Words and notes | totals.
  const left = [
    ...(model.words ? [para(run('Amount in words', { bold: true, size: 7, color: C.muted, caps: true })), para(run(model.words, { bold: true, size: 8.5 }), { after: 6 })] : []),
    ...(model.notes ? [para(run('Notes', { bold: true, size: 7, color: C.muted, caps: true })), ...lines(model.notes.split('\n'), { size: 8 })] : []),
  ];
  const totW = 220 * TWIP;
  const totalsTable = grid([...model.totals, ...(model.balance ?? [])].map((r) => new TableRow({ children: [
    cell([para(run(r.label, { bold: !!r.strong, size: r.strong ? 10.5 : 8.5, color: r.strong ? C.text : C.muted }))], { width: totW * 0.55, shade: r.strong ? C.soft : undefined, margins: 50 }),
    cell([para(run(r.value, { bold: !!r.strong, size: r.strong ? 10.5 : 8.5 }), { align: AlignmentType.RIGHT })], { width: totW * 0.45, shade: r.strong ? C.soft : undefined, margins: 50 }),
  ] })), [totW * 0.55, totW * 0.45]);
  const summary = grid([new TableRow({ children: [cell(left, { width: inner - totW, margins: 0 }), cell([totalsTable], { width: totW, margins: 0 })] })], [inner - totW, totW]);

  const blocks = [header, headerRule, parties, para(run(''), { after: 8 }), items, para(run(''), { after: 8 }), summary];

  if (model.taxSummary) {
    const t = model.taxSummary, w = Math.floor(inner / t.columns.length);
    const tw = t.columns.map(() => w);
    blocks.push(para(run('Tax summary (SAC/HSN)', { bold: true, size: 7, color: C.muted, caps: true }), { before: 12, after: 4 }));
    blocks.push(grid([
      new TableRow({ tableHeader: true, children: t.columns.map((c, i) => cell([para(run(c, { bold: true, size: 7.5, color: C.muted }), { align: i ? AlignmentType.RIGHT : AlignmentType.LEFT })], { width: w, shade: C.soft, margins: 50 })) }),
      ...[...t.rows, t.total].map((r, k) => new TableRow({ children: r.map((c, i) => cell([para(run(c, { size: 7.5, bold: k === t.rows.length }), { align: i ? AlignmentType.RIGHT : AlignmentType.LEFT })], { width: w, margins: 50 })) })),
    ], tw));
  }

  if (model.bank || model.signature) {
    const sigW = 200 * TWIP;
    const bank = model.bank ? [para(run('Bank details', { bold: true, size: 7, color: C.muted, caps: true })), ...model.bank.map(([k, v]) => para([run(`${k}  `, { size: 8, color: C.muted }), run(v, { bold: true, size: 8 })]))] : [];
    const s = model.signature;
    const sigImage = s?.image ? image(s.image, 36, 200) : null;
    const sig = s ? [
      para(run(s.forLine, { bold: true, size: 8.5 }), { align: AlignmentType.RIGHT }),
      sigImage ? para(sigImage, { align: AlignmentType.RIGHT }) : para(run(''), { after: 30 }),
      para(run(s.label, { size: 8, color: C.muted }), { align: AlignmentType.RIGHT, border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.muted, space: 2 } } }),
      ...([s.name, s.title].filter(Boolean).length ? [para(run([s.name, s.title].filter(Boolean).join(', '), { size: 8 }), { align: AlignmentType.RIGHT })] : []),
    ] : [];
    blocks.push(para(run(''), { after: 10 }));
    blocks.push(grid([new TableRow({ children: [cell(bank, { width: inner - sigW, margins: 0 }), cell(sig, { width: sigW, margins: 0 })] })], [inner - sigW, sigW]));
  }

  if (model.terms) {
    blocks.push(para(run('Terms & conditions', { bold: true, size: 7, color: C.muted, caps: true }), { before: 12, after: 2 }));
    blocks.push(...lines(model.terms.split('\n'), { size: 7.5, color: C.muted }));
  }

  const footer = new Footer({ children: [new Paragraph({
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 } },
    tabStops: [{ type: 'right', position: inner }],
    children: [
      run(model.footer ?? '', { size: 7, color: C.muted }),
      ...(model.pageNumbers ? [new TextRun({ children: ['\tPage ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: half(7), color: C.muted, font: FONT })] : []),
    ],
  })] });

  const doc = new Document({
    creator: 'Pulse ERP', title: model.meta_info?.title ?? model.title, description: model.meta_info?.subject ?? '',
    fonts: fonts ? [{ name: FONT, data: fonts.regular, characterSet: CharacterSet.ANSI }] : undefined,
    styles: { default: { document: { run: { font: FONT, size: half(9), color: C.text } } } },
    sections: [{
      properties: { page: { size: { width: Math.round(model.page.width * TWIP), height: Math.round(model.page.height * TWIP) },
        margin: { top: model.page.margin * TWIP, bottom: model.page.margin * TWIP, left: model.page.margin * TWIP, right: model.page.margin * TWIP, footer: 20 * TWIP } } },
      footers: { default: footer },
      children: blocks,
    }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
