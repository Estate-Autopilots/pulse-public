// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C): a synthetic company for tests/e2e/quote-builder.spec.ts.
// Invented names and figures only (the board's "Dorugohum Residency (sample)"); never routes to a real database.
//   synthetic-builder          a draft quotation: your own price on a line, installation and loading, and one AI change
//                              card waiting (transport 65 km at ₹100/km, settled at the end; 5% off the inverter)
//   synthetic-builder-invoice  a draft invoice whose transport is still an estimate (it must be confirmed first)
//   synthetic-builder-issued   an approved two-page quotation with its real PDF (WL #10: the phone's Preview scrolls)
//   synthetic-builder-phased   QUOTE-BUILDER-4 (Kazuk's 19 Nov test): a package opened into phase parts, its seats sold
//                              per user per month as 5 users × 4 months with the 5% prepaid discount; an old draft item
//                              in the catalogue that must never be offered
import { buildModel, FONT_URLS, renderPdf } from '../../../packages/invoice-doc/src/index.js';
import { readFile } from 'node:fs/promises';

export const QB_EMAIL = 'admin@quote-builder.example';
const R = (rupees) => rupees * 100;
const company = { legalName: 'Sample Solar LLP', tradeName: 'Sample Solar', stateCode: '27', gstin: '27AAAAA0000A1Z5', address: ['1 Sample Road, Pune'] };
const item = (id, name, price, cost) => ({ id, kind: 'product', name, description: '', sac: '85044010', unit: 'nos', price, gstRate: 18, cost, status: 'active', code: null, open: false, addOns: [] });
const SOLAR = item('qb-solar', 'PUREPower 5 kW solar system', R(385000), R(300000));
const INVERTER = item('qb-inverter', 'Hybrid inverter 5 kVA', R(110000), R(90000));
const BATTERY = item('qb-battery', 'Lithium battery 5 kWh', R(75000), R(60000));
const items = [SOLAR, INVERTER, BATTERY];
// QUOTE-BUILDER-4: a company that sells by phase (invented names, Kazuk's shapes: per user per month, prepaid by months).
const PHASES = [{ key: 'p1', name: 'Phase 1: Sample blueprint', groups: [] }, { key: 'p2', name: 'Phase 2: Sample creative', groups: [] },
  { key: 'p3', name: 'Phase 3: Sample buyer journey', groups: [] }, { key: 'p4', name: 'Phase 4: Sample sales system', groups: [] }];
const TIERS = [{ months: 2, percent: 0 }, { months: 3, percent: 5 }, { months: 6, percent: 10 }, { months: 12, percent: 15 }];
const svc = (id, name, price, phase, extra = {}) => ({ ...item(id, name, price, null), kind: 'service', sac: '998361', phase, phaseGroup: null, included: false, ...extra });
const STUDY = svc('qb-study', 'Sample market study', R(4200), 'p1');
const VIDEO = svc('qb-video', 'Sample model-led video (standard)', R(33505.5), 'p2');
const VIDEO_LUX = svc('qb-video-lux', 'Sample model-led video (luxury)', R(61250), 'p2');
const ADS = svc('qb-ads', 'Sample Meta ads and nurturing', R(7000), 'p3', { unit: 'month' });
const SEATS = svc('qb-seats', 'Sample CRM seats (pro)', R(1199), 'p4', { unit: 'user/month', termTiers: TIERS });
const SEATS_AI = svc('qb-seats-ai', 'Sample CRM seats (AI)', R(1899), 'p4', { unit: 'user/month', termTiers: TIERS });
const OLD_DRAFT = svc('qb-old-film', 'Sample brand film (old draft)', R(100000), 'p2', { status: 'draft' });
const GROWTH = { ...svc('qb-growth', 'Sample Growth Package', 0, null), kind: 'package', unit: 'package', description: '4-month term' };
const phasedItems = [GROWTH, STUDY, VIDEO, VIDEO_LUX, ADS, SEATS, SEATS_AI, OLD_DRAFT];
const PKG = { packageId: GROWTH.id, packageLabel: 'Sample Growth Package · 4-month term' };
const part = (it, qty, rate, at, extra = {}) => ({ ...line(it, qty, rate), ...PKG, phase: PHASES[at].name, phaseOrder: at, phaseGroup: null, role: null,
  packageDefault: { qty, rate, itemId: it.id, ...(extra.qtyDims ? { qtyDims: extra.qtyDims } : {}), ...(extra.discountPercent ? { discountPercent: extra.discountPercent } : {}) }, listRate: null, ...extra });
const phasedLines = () => [part(STUDY, 1, R(4200), 0), part(VIDEO, 2, R(33505.5), 1), part(ADS, 4, R(7000), 2),
  part(SEATS, 20, R(1199), 3, { qtyDims: [{ n: 5, unit: 'user' }, { n: 4, unit: 'month' }], discountPercent: 5 })];
const line = (it, qty, rate, extra = {}) => ({ itemId: it.id, description: it.name, details: '', sac: it.sac, unit: it.unit, qty, rate, discount: 0, discountPercent: null, gstRate: 18,
  open: false, notNeeded: false, catalogueRate: it.price, charge: null, confirmed: false, priceNote: null, ...extra });
const charge = (description, rate, kind, extra = {}) => ({ itemId: null, description, details: '', sac: null, unit: null, qty: 1, rate, discount: 0, discountPercent: null, gstRate: 18,
  open: false, notNeeded: false, catalogueRate: null, charge: kind, confirmed: false, priceNote: null, ...extra });
const buyer = { name: 'Dorugohum Residency (sample)', stateCode: '27', address: ['Baner, Pune'], contactName: 'Neha Kireteso (sample)', phone: null, email: null, gstin: null };
const base = (id, docType) => ({ id, docType, status: 'draft', number: null, issueDate: '2026-11-20', dueDate: null, validUntil: '2026-12-20', buyer, placeOfSupply: '27', reference: {},
  notes: '', terms: null, reverseCharge: false, zeroRated: false, roundTotal: true, templateId: null, clientId: null, contactPersonId: null, siteLocation: 'Hinjewadi, Pune',
  updatedAt: '2026-11-20T06:00:00Z', revision: 0, taxMode: 'intra', ownerApproval: null, taskId: null });
const card = () => ({ id: 'qb-card-1', status: 'pending', ask: 'Add transport to Hinjewadi, 65 km at ₹100 per km, and give 5% off the inverter', stale: false, by: 'Billing assistant',
  createdAt: '2026-11-20T06:05:00Z',
  items: [{ op: 'add_charge', text: 'Add Transport to Hinjewadi · ₹100/km × 65 km · ₹6,500 (estimate, settled at the end)' }, { op: 'price', text: 'Hybrid inverter 5 kVA: ₹1,10,000 → ₹1,04,500 (−5%)' }],
  before: { total: R(753430), estimate: 0, totalRupees: '₹7,53,430', estimateRupees: '₹0' },
  after: { total: R(746940), estimate: R(7670), totalRupees: '₹7,46,940', estimateRupees: '₹7,670' } });
const fresh = () => ({
  quote: { document: base('synthetic-builder', 'quotation'), lines: [
    line(SOLAR, 1, R(365000), { priceNote: 'Festive offer' }), line(INVERTER, 1, R(110000)), line(BATTERY, 2, R(75000)),
    charge('Installation', R(12000), 'fixed'), charge('Loading & unloading', R(1500), 'fixed')], proposals: [card()] },
  invoice: { document: { ...base('synthetic-builder-invoice', 'invoice'), validUntil: null, dueDate: '2026-12-05' }, lines: [
    line(SOLAR, 1, R(365000)), line(INVERTER, 1, R(104500)), charge('Transport', R(100), 'variable', { unit: 'km', qty: 65 }), charge('Installation', R(12000), 'fixed')], proposals: [] },
  phased: { document: { ...base('synthetic-builder-phased', 'quotation'), buyer: { ...buyer, name: 'Shree Developers (sample)' }, siteLocation: 'Wakad, Pune' }, lines: phasedLines(), proposals: [] },
});
let state = fresh();
const page = (doc) => ({ document: doc.document, lines: doc.lines, company, items, templates: [], template: null, orgLogo: false, related: [], events: [], payments: [], links: [], bank: [],
  task: null, assignees: [], today: '2026-11-20', canWrite: true, approvalMode: 'none', proposals: doc.proposals, phases: [], packageParts: {}, rateCards: [], sendRequired: [], blocks: {},
  ...(doc === state.phased ? { items: phasedItems, phases: PHASES, packageParts: { [GROWTH.id]: PARTS } } : {}) });
const pp = (position, it, quantity, price, phase) => ({ position, itemId: it.id, label: it.name, quantity, unit: it.unit, price, itemPrice: it.price, itemName: it.name, itemDescription: '',
  sac: it.sac, itemUnit: it.unit, gstRate: 18, phase, phaseGroup: null, included: false });
const PARTS = [pp(0, STUDY, 1, R(4200), 'p1'), pp(1, VIDEO, 2, R(33505.5), 'p2'), pp(2, ADS, 4, R(7000), 'p3'), pp(3, SEATS, 20, R(1139.05), 'p4')];

// The issued quotation: 40 lines, so its PDF has two pages.
const ISSUED_LINES = Array.from({ length: 40 }, (_, i) => line(i % 2 ? INVERTER : BATTERY, 1, R(1000 + i * 10), { description: `Sample part ${i + 1}`, itemId: null }));
let pdfBytes = null;
async function issuedPdf() {
  if (pdfBytes) return pdfBytes;
  const doc = { docType: 'quotation', status: 'issued', number: 'QT/26-27/0042', issueDate: '2026-11-20', validUntil: '2026-12-20', seller: company, buyer, placeOfSupply: '27',
    lines: ISSUED_LINES, roundTotal: true };
  const fonts = { regular: new Uint8Array(await readFile(FONT_URLS.regular)), semibold: new Uint8Array(await readFile(FONT_URLS.semibold)) };
  pdfBytes = Buffer.from((await renderPdf(buildModel({}, doc), { fonts })).bytes);
  return pdfBytes;
}
const issuedDoc = () => ({ ...base('synthetic-builder-issued', 'quotation'), status: 'issued', number: 'QT/26-27/0042', fy: '2026-27', seller: company, issuedAt: '2026-11-20T06:00:00Z',
  issuedBy: 'Sample Admin', sentAt: null, taxable: ISSUED_LINES.reduce((n, l) => n + l.rate, 0), cgst: 0, sgst: 0, igst: 0, total: 0, paid: 0, credited: 0, cancelledAt: null,
  cancelReason: null, decision: null, sourceId: null, againstId: null, salespersonName: null });

/** [status, contentType, body] for this company's Billing calls, or null. */
export async function quoteBuilderAnswer(request, path) {
  const email = String(request.headers['cf-access-authenticated-user-email'] ?? '').toLowerCase();
  if (email !== QB_EMAIL || !path.startsWith('/api/v0/erp/')) return null;
  let body = {};
  if (request.method === 'POST') { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw || '{}'); }
  const json = (v, status = 200) => [status, 'application/json', JSON.stringify(v)];
  if (path === '/api/v0/erp/test-reset') { state = fresh(); return json({ ok: true }); }
  if (path === '/api/v0/erp/setup') return json({ pack: 'dealer', fields: {}, saved: {}, canWrite: true, catalogue: [], packs: [], inventoryEnabled: false });
  const at = /^\/api\/v0\/erp\/documents\/(synthetic-builder(?:-invoice|-issued|-phased)?)(\/.*)?$/.exec(path);
  if (!at) return null;
  const [, id, rest = ''] = at;
  if (id === 'synthetic-builder-issued') {
    if (rest === '/pdf') return [200, 'application/pdf', await issuedPdf()];
    if (rest !== '') return json({ ok: true });
    return json({ ...page({ document: issuedDoc(), lines: ISSUED_LINES, proposals: [] }), file: { sha256: 'a'.repeat(64), createdAt: '2026-11-20T06:00:00Z', size: 1 }, financeSyncedAt: null });
  }
  const doc = id === 'synthetic-builder' ? state.quote : id === 'synthetic-builder-phased' ? state.phased : state.invoice;
  if (rest === '' && request.method === 'POST') { doc.document = { ...doc.document, ...body, updatedAt: doc.document.updatedAt }; doc.lines = body.lines; return json({ ok: true, total: 0, mode: 'intra' }); }
  if (rest === '') return json(page(doc));
  if (rest === '/proposals') return json({ proposals: doc.proposals });
  const decide = /^\/proposals\/([^/]+)\/(apply|dismiss)$/.exec(rest);
  if (decide && request.method === 'POST') {
    const p = doc.proposals.find((x) => x.id === decide[1]);
    if (!p) return json({ error: 'Change card not found' }, 404);
    doc.proposals = doc.proposals.filter((x) => x !== p);
    if (decide[2] === 'apply') {
      doc.lines = doc.lines.map((l) => (l.itemId === INVERTER.id ? { ...l, rate: R(104500) } : l));
      doc.lines.push(charge('Transport to Hinjewadi', R(100), 'variable', { unit: 'km', qty: 65 }));
      doc.document = { ...doc.document, updatedAt: '2026-11-20T06:10:00Z' };
    }
    return json({ ok: true, status: decide[2] === 'apply' ? 'applied' : 'dismissed', total: p.after.total });
  }
  if (rest === '/pdf' || rest === '/docx') return [200, 'application/pdf', await issuedPdf()];
  return json({ ok: true });
}
