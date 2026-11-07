// Synthetic, company-scoped storage. Never routes to an EA database.
import { BILLING_FIELDS, BILLING_PACKS, effectiveFields } from '../../../apps/web/app/erp/settings/fields.ts';
const states = new Map();
const company = { legalName: 'Synthetic Billing Company', stateCode: '27', address: ['Synthetic address'] };
const item = { id: 'synthetic-review-item', kind: 'package', name: 'Synthetic Review Package', unit: 'month', price: 100000, gstRate: 18, cost: 20000, status: 'active', version: 1, source: {}, code: null, sac: null, description: '', setup: 'Synthetic setup', trackStock: false, reorderLevel: null, updatedAt: '2026-10-18T00:00:00Z' };
const addon = { ...item, id: 'synthetic-review-addon', name: 'Synthetic Review Add-on', kind: 'service' };
const part = { itemId: null, label: 'Synthetic Review Part', quantity: 1, unit: 'month', deliverables: ['Synthetic retained deliverable'], where: 'Synthetic folder', setup: 'Synthetic team', derives: 'Synthetic report', price: 100000, cost: 20000 };
const line = { itemId: item.id, description: item.name, details: '', sac: null, unit: 'month', qty: 1, rate: 100000, discount: 0, discountPercent: null, gstRate: 18 };
const base = { id: 'synthetic-review', docType: 'quotation', status: 'draft', number: null, issueDate: '2026-10-18', dueDate: null, validUntil: '2026-11-18', buyer: { name: 'Synthetic Buyer', address: [], stateCode: '27' }, placeOfSupply: '27', reference: { project: 'Synthetic project', milestone: 'Synthetic milestone', po: 'Synthetic PO' }, notes: '', terms: null, reverseCharge: false, zeroRated: false, roundTotal: false, updatedAt: '2026-10-18T00:00:00Z' };
const fresh = (second) => ({ inventoryEnabled: false, pack: second ? 'agency' : 'dealer', fields: effectiveFields(second ? 'agency' : 'dealer', {}), document: structuredClone(base), lines: [structuredClone(line)] });
export async function billingReviewAnswer(request, path) {
  const session = /^synthetic-billing-(one|two)$/.exec(String(request.headers['x-pulse-session'] ?? ''));
  const email = session ? `admin@billing-${session[1]}.example` : String(request.headers['cf-access-authenticated-user-email'] ?? '');
  const testCompany = /^admin@billing-(one|two)\.example$/.test(email);
  if (!testCompany) return path === '/api/v0/erp/setup' ? { pack: null, fields: effectiveFields(null), canWrite: true } : null;
  if (!path.startsWith('/api/v0/erp/')) return null;
  if (path.endsWith('/test-reset')) { states.set(email, fresh(email.includes('two'))); return { ok: true }; }
  if (!states.has(email)) states.set(email, fresh(email.includes('two')));
  const s = states.get(email), setup = () => ({ pack: s.pack, fields: s.fields, saved: s.fields, canWrite: true, catalogue: BILLING_FIELDS, packs: BILLING_PACKS, inventoryEnabled: s.inventoryEnabled });
  let body = {};
  if (request.method === 'POST') { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw || '{}'); }
  if (path === '/api/v0/erp/setup') { if (request.method === 'POST') { s.pack = body.pack; s.fields = effectiveFields(s.pack, body.fields); } return setup(); }
  if (path === '/api/v0/erp/settings') { if (request.method === 'POST') s.inventoryEnabled = body.inventoryEnabled; return { company, inventoryEnabled: s.inventoryEnabled, dueDays: 30, roundTotal: false, fy: '2026-27', today: base.issueDate, canWrite: true, series: [], mirror: { note: 'Synthetic books' }, esign: [] }; }
  if (path === '/api/v0/erp/items') return { items: [item], inventoryEnabled: false, canWrite: true };
  if (path === '/api/v0/erp/items/'+item.id) return { item, parts: [part], options: [], versions: [], engagements: [], usedIn: [], moves: [], inventoryEnabled: false, canWrite: true };
  if (path === '/api/v0/erp/templates') return { templates: [], company, orgLogo: false, sample: { ...base, seller: company, lines: [line] }, canWrite: true };
  if (/^\/api\/v0\/erp\/documents\/synthetic-review\/(pdf|docx)$/.test(path)) return { po: s.document.reference.po };
  // EST-1237: an approved quotation for the send and convert checks. Marks and made drafts are kept so the spec can
  // read what reached the server (GET .../synthetic-issued/test-log).
  const ISSUED = '/api/v0/erp/documents/synthetic-issued';
  if (path === ISSUED || path.startsWith(ISSUED + '/')) {
    s.issued ??= { status: 'issued', marks: [], made: 0 };
    const rest = path.slice(ISSUED.length);
    if (rest === '/pdf' || rest === '/docx') return { po: 'synthetic-issued' };
    if (rest === '/test-log') return { marks: s.issued.marks, made: s.issued.made, status: s.issued.status };
    if (rest === '/mark' && request.method === 'POST') { s.issued.marks.push(body.action); if (['sent', 'accepted', 'declined'].includes(body.action)) s.issued.status = body.action; return { ok: true }; }
    if (rest === '/link' && request.method === 'POST') return { url: 'https://pulse.example.com/accept/synthetic' };
    if (rest !== '') return null;
    const document = { ...base, id: 'synthetic-issued', status: s.issued.status, number: 'SYN-Q-0001', fy: '2026-27', seller: company, buyer: { ...base.buyer, phone: '+919999900001' },
      issuedAt: '2026-10-18T06:00:00Z', issuedBy: 'Synthetic Admin', sentAt: null, taxMode: 'intra', taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, total: 118000, paid: 0, credited: 0,
      cancelledAt: null, cancelReason: null, decision: null, sourceId: null, againstId: null, salespersonName: null, updatedAt: '2026-10-18T06:00:00Z' };
    return { document, lines: s.lines, company, items: [], templates: [], template: null, orgLogo: false, related: [], events: [], payments: [], links: [], bank: [], file: null, task: null,
      assignees: [], today: base.issueDate, canWrite: true, financeSyncedAt: null };
  }
  if (path === '/api/v0/erp/documents' && request.method === 'POST' && body.sourceId === 'synthetic-issued') {
    s.issued ??= { status: 'issued', marks: [], made: 0 };
    await new Promise((resolve) => setTimeout(resolve, 1500));  // slow enough for a second tap to land while it runs
    s.issued.made += 1;
    return { id: 'synthetic-review' };
  }
  if (path === '/api/v0/erp/documents/synthetic-review') {
    if (request.method === 'POST') { s.document = { ...s.document, ...body }; s.lines = body.lines; return { ok: true }; }
    return { document: s.document, lines: s.lines, company, items: [{ ...item, addOns: [{ itemId: addon.id, name: addon.name, price: addon.price }] }, addon], templates: [], template: null, orgLogo: false, related: [], events: [], payments: [], links: [], bank: [], task: null, assignees: [], today: base.issueDate, canWrite: true };
  }
  return null;
}
