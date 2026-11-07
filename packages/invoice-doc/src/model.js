// ERP-INVOICE: what a document says, independent of how it is drawn. The PDF writer lays this model out on A4 and the
// DOCX writer turns the same model into Word tables, so a template's choices (colours, fields, terms, bank block,
// signature) mean the same thing in both, and the live preview is the PDF itself.
import { computeDocument, formatAmount, formatDate, stateLabel } from './gst.js';

export const DOC_TYPES = Object.freeze(['invoice', 'proforma', 'quotation', 'credit_note']);
export const DOC_LABELS = Object.freeze({
  invoice: { title: 'Tax Invoice', number: 'Invoice no.', date: 'Invoice date', noun: 'invoice' },
  proforma: { title: 'Proforma Invoice', number: 'Proforma no.', date: 'Date', noun: 'proforma invoice' },
  quotation: { title: 'Quotation', number: 'Quotation no.', date: 'Date', noun: 'quotation' },
  credit_note: { title: 'Credit Note', number: 'Credit note no.', date: 'Date', noun: 'credit note' },
});

/** The fields a template may show or hide, with their defaults. */
export const SHOW_DEFAULTS = Object.freeze({
  sac: true, qtyRate: true, discount: false, lineTax: false, taxSummary: true, words: true, bank: true, signature: true,
  placeOfSupply: true, dueDate: true, project: true, contact: true, notes: true, terms: true, pageNumbers: true, balance: true,
});
export const STYLES = Object.freeze(['band', 'line', 'minimal']);

/** A complete template design: missing or malformed choices fall back to the defaults. */
export function normaliseDesign(design = {}) {
  const d = design && typeof design === 'object' ? design : {};
  const hex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? String(v).toLowerCase() : fallback);
  const text = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const show = { ...SHOW_DEFAULTS };
  for (const key of Object.keys(SHOW_DEFAULTS)) if (typeof d.show?.[key] === 'boolean') show[key] = d.show[key];
  const bank = {};
  for (const key of ['accountName', 'bankName', 'accountNumber', 'ifsc', 'branch', 'upi']) bank[key] = text(d.bank?.[key], 120);
  return {
    style: STYLES.includes(d.style) ? d.style : 'line',
    accent: hex(d.accent, '#5b45d6'),
    text: hex(d.text, '#1f2430'),
    muted: hex(d.muted, '#667085'),
    fontScale: Math.min(1.15, Math.max(0.85, Number(d.fontScale) || 1)),
    logo: { show: d.logo?.show !== false, position: d.logo?.position === 'right' ? 'right' : 'left', height: Math.min(80, Math.max(20, Number(d.logo?.height) || 32)) },
    titles: Object.fromEntries(Object.keys(DOC_LABELS).map((k) => [k, text(d.titles?.[k], 40)])),
    show,
    terms: text(d.terms, 3000),
    bank,
    signature: { label: text(d.signature?.label, 60) || 'Authorised Signatory', name: text(d.signature?.name, 80), title: text(d.signature?.title, 80), showImage: d.signature?.showImage !== false },
    footer: text(d.footer, 300),
  };
}

/** Pixel size of a PNG or JPEG from its bytes (null when it is neither): the DOCX writer keeps the picture's shape. */
export function imageSize(bytes, mime) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (mime === 'image/png' && b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  }
  if (mime === 'image/jpeg' && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], size = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + size;
    }
  }
  return null;
}
const sized = (asset) => (asset?.bytes && ['image/png', 'image/jpeg'].includes(asset.mime) ? { ...asset, ...(imageSize(asset.bytes, asset.mime) ?? {}) } : null);

const lines = (...xs) => xs.flat().map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
const pct = (rate) => `${Number(rate)}%`;

/**
 * The document model. `doc` is the stored document (or a draft being edited); `assets` carries the logo and signature
 * images as { bytes, mime } (PNG or JPEG) when the template shows them.
 */
export function buildModel(designInput, doc, assets = {}) {
  const design = normaliseDesign(designInput);
  const show = design.show;
  const type = DOC_TYPES.includes(doc.docType) ? doc.docType : 'invoice';
  const label = DOC_LABELS[type];
  const seller = doc.seller ?? {};
  const buyer = doc.buyer ?? {};
  const computed = computeDocument({
    lines: doc.lines ?? [], sellerState: seller.stateCode, placeOfSupply: doc.placeOfSupply || buyer.stateCode || seller.stateCode,
    roundTotal: doc.roundTotal !== false, reverseCharge: !!doc.reverseCharge, zeroRated: !!doc.zeroRated,
  });
  const intra = computed.mode === 'intra';
  const draft = !doc.number || doc.status === 'draft';

  const meta = [[label.number, doc.number || 'Draft (numbered when issued)'], [label.date, formatDate(doc.issueDate)]];
  if (type === 'quotation' && doc.validUntil) meta.push(['Valid until', formatDate(doc.validUntil)]);
  if (show.dueDate && doc.dueDate && ['invoice', 'proforma'].includes(type)) meta.push(['Due date', formatDate(doc.dueDate)]);
  if (show.placeOfSupply) meta.push(['Place of supply', stateLabel(computed.placeOfSupply)]);
  if (type === 'invoice' || type === 'credit_note') meta.push(['Reverse charge', computed.reverseCharge ? 'Yes' : 'No']);
  if (type === 'credit_note' && doc.against?.number) meta.push(['Against invoice', `${doc.against.number}${doc.against.date ? `, ${formatDate(doc.against.date)}` : ''}`]);
  if (show.project && doc.reference?.project) meta.push(['Project', doc.reference.project]);
  if (doc.reference?.milestone) meta.push(['Milestone', doc.reference.milestone]);
  if (doc.reference?.po) meta.push(['PO / reference', doc.reference.po]);

  const sellerLines = lines(seller.tradeName && seller.tradeName !== seller.legalName ? seller.tradeName : null, seller.address,
    seller.gstin ? `GSTIN ${seller.gstin}` : null, seller.pan ? `PAN ${seller.pan}` : null,
    [seller.phone, seller.email].filter(Boolean).join(' · '), seller.website);
  const buyerLines = lines(buyer.address, buyer.stateCode ? `State: ${stateLabel(buyer.stateCode)}` : null,
    buyer.gstin ? `GSTIN ${buyer.gstin}` : 'Unregistered (no GSTIN)',
    show.contact ? [buyer.contactName ? `Attn: ${buyer.contactName}` : null, [buyer.phone, buyer.email].filter(Boolean).join(' · ')] : null);

  // Line items: the columns a template asks for, in a fixed order.
  const columns = [{ key: 'n', label: '#', align: 'left', width: 0.045 }, { key: 'item', label: 'Item & description', align: 'left', width: 0 }];
  if (show.sac) columns.push({ key: 'sac', label: 'SAC/HSN', align: 'left', width: 0.085 });
  if (show.qtyRate) columns.push({ key: 'qty', label: 'Qty', align: 'right', width: 0.075 }, { key: 'rate', label: 'Rate', align: 'right', width: 0.11 });
  if (show.discount && computed.discount) columns.push({ key: 'discount', label: 'Discount', align: 'right', width: 0.095 });
  // Without tax per line, "Amount" is the line's taxable value and the tax is in the totals.
  if (show.lineTax) {
    columns.push({ key: 'taxable', label: 'Taxable value', align: 'right', width: 0.12 });
    if (intra) columns.push({ key: 'cgst', label: 'CGST', align: 'right', width: 0.1 }, { key: 'sgst', label: computed.split, align: 'right', width: 0.1 });
    else columns.push({ key: 'igst', label: 'IGST', align: 'right', width: 0.11 });
  }
  columns.push({ key: 'total', label: 'Amount', align: 'right', width: 0.12 });
  const fixed = columns.reduce((n, c) => n + c.width, 0);
  columns.find((c) => c.key === 'item').width = Math.max(0.2, 1 - fixed);
  const qty = (l) => `${Number(l.qty ?? 1)}${l.unit ? ` ${l.unit}` : ''}`;
  const rows = computed.lines.map((l, i) => ({
    cells: {
      n: String(i + 1), item: String(l.description ?? '').trim() || 'Item', sac: l.sac ?? '', qty: qty(l), rate: formatAmount(l.rate),
      discount: l.discount ? formatAmount(l.discount) : '', taxable: formatAmount(l.taxable),
      cgst: formatAmount(l.cgst), sgst: formatAmount(l.sgst), igst: formatAmount(l.igst),
      total: formatAmount(show.lineTax ? l.total : l.taxable),
    },
    sub: {
      item: String(l.details ?? '').trim(),
      cgst: l.gstRate ? pct(l.gstRate / 2) : '', sgst: l.gstRate ? pct(l.gstRate / 2) : '', igst: l.gstRate ? pct(l.gstRate) : '',
    },
  }));

  // Totals: taxable value, each tax component per rate, round off, total; then what is paid and still due.
  const totals = [{ label: 'Taxable value', value: formatAmount(computed.taxable) }];
  for (const g of computed.byRate) {
    if (!g.tax && !g.gstRate) continue;
    if (intra) {
      totals.push({ label: `CGST ${pct(g.gstRate / 2)}`, value: formatAmount(g.cgst) }, { label: `${computed.split} ${pct(g.gstRate / 2)}`, value: formatAmount(g.sgst) });
    } else totals.push({ label: `IGST ${pct(g.gstRate)}`, value: formatAmount(g.igst) });
  }
  if (computed.zeroRated) totals.push({ label: 'IGST (zero-rated under LUT)', value: formatAmount(0) });
  if (computed.roundOff) totals.push({ label: 'Round off', value: `${computed.roundOff > 0 ? '+' : ''}${formatAmount(computed.roundOff)}` });
  totals.push({ label: type === 'credit_note' ? 'Total credit' : 'Total', value: `₹${formatAmount(computed.total)}`, strong: true });
  if (computed.reverseCharge) totals.push({ label: 'Tax payable by the recipient (reverse charge)', value: formatAmount(computed.tax) });
  let balance = null;
  if (show.balance && type === 'invoice' && Number(doc.paid) > 0) {
    balance = [{ label: 'Amount received', value: formatAmount(doc.paid) }, { label: 'Balance due', value: `₹${formatAmount(Math.max(0, computed.total - Number(doc.paid) - Number(doc.credited || 0)))}`, strong: true }];
  }

  const taxSummary = show.taxSummary && computed.tax ? {
    columns: intra ? ['SAC/HSN', 'Taxable value', 'CGST rate', 'CGST', `${computed.split} rate`, computed.split, 'Total tax'] : ['SAC/HSN', 'Taxable value', 'IGST rate', 'IGST', 'Total tax'],
    rows: computed.bySac.map((g) => (intra
      ? [g.sac || '—', formatAmount(g.taxable), pct(g.gstRate / 2), formatAmount(g.cgst), pct(g.gstRate / 2), formatAmount(g.sgst), formatAmount(g.tax)]
      : [g.sac || '—', formatAmount(g.taxable), pct(g.gstRate), formatAmount(g.igst), formatAmount(g.tax)])),
    total: intra ? ['Total', formatAmount(computed.taxable), '', formatAmount(computed.cgst), '', formatAmount(computed.sgst), formatAmount(computed.tax)]
      : ['Total', formatAmount(computed.taxable), '', formatAmount(computed.igst), formatAmount(computed.tax)],
  } : null;

  const notes = [];
  if (type === 'proforma') notes.push('This is a proforma invoice, not a tax invoice. A tax invoice follows on payment or supply.');
  if (type === 'quotation') notes.push('This quotation is not a demand for payment.');
  if (computed.zeroRated) notes.push('Supply meant for export under a Letter of Undertaking without payment of IGST.');
  if (show.notes && doc.notes) notes.push(String(doc.notes).trim());

  const b = design.bank;
  // EST-1261: quotations carry the bank block too, so a customer can pay the advance; a credit note never does.
  const bank = show.bank && ['invoice', 'proforma', 'quotation'].includes(type) && (b.accountNumber || b.upi)
    ? [['Account name', b.accountName || seller.legalName || ''], ['Bank', [b.bankName, b.branch].filter(Boolean).join(', ')], ['Account no.', b.accountNumber], ['IFSC', b.ifsc], ['UPI', b.upi]].filter(([, v]) => v)
    : null;

  return {
    docType: type,
    page: { width: 595.28, height: 841.89, margin: 40 },
    style: design.style,
    colors: { accent: design.accent, text: design.text, muted: design.muted },
    fontScale: design.fontScale,
    title: design.titles[type] || label.title,
    draft,
    cancelled: doc.status === 'cancelled',
    logo: design.logo.show && sized(assets.logo) ? { ...sized(assets.logo), position: design.logo.position, height: design.logo.height } : null,
    seller: { name: seller.legalName || 'Your company', lines: sellerLines },
    parties: [{ heading: type === 'quotation' ? 'Prepared for' : 'Bill to', name: buyer.name || 'Client', lines: buyerLines }],
    meta,
    table: { columns, rows },
    totals, balance,
    words: show.words ? computed.words : null,
    taxSummary,
    notes: notes.length ? notes.join('\n') : null,
    terms: show.terms ? (doc.terms ?? design.terms ?? '').trim() || null : null,
    bank,
    signature: show.signature ? {
      forLine: `For ${seller.legalName || 'the company'}`, label: design.signature.label, name: design.signature.name, title: design.signature.title,
      image: design.signature.showImage ? sized(assets.signature) : null,
    } : null,
    footer: design.footer || null,
    pageNumbers: show.pageNumbers,
    computed,
    meta_info: { title: `${design.titles[type] || label.title} ${doc.number || 'draft'}`, subject: buyer.name || '', date: doc.issueDate || null },
  };
}
