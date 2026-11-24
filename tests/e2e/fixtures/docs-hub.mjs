// DOCS-HUB (owner, 21 Nov 2026: "I can't find specific documents"): a synthetic company for
// tests/e2e/docs-hub-search.spec.ts: Billing → Documents with a dozen invented documents, and the search's answers as the
// API gives them (services/api/src/doc-find.ts; its real behaviour is tested in tests/core/test_docs_hub_search.py):
// the owner's own ask, a misspelt name (the closest names) and an item. Invented names and figures only.
export const HUB_EMAIL = 'admin@docs-hub.example';
const R = (rupees) => rupees * 100;
const TODAY = '2026-11-20';
const doc = (id, docType, status, number, buyer, issueDate, total, extra = {}) => ({ id, docType, status, number, fy: number ? '2026-27' : null, issueDate, dueDate: null, validUntil: null,
  buyer: { name: buyer, stateCode: '27' }, reference: {}, project: null, revision: 0, total: R(total), taxable: Math.round(R(total) / 1.18), paid: 0, credited: 0, salespersonName: null,
  dealStatus: null, ownerApproval: null, approvalAskedBy: null, approvalToName: null, sentAt: status === 'sent' ? `${issueDate}T10:00:00Z` : null, createdAt: `${issueDate}T09:00:00Z`, ...extra });
const WISE = 'Willow Lane Solar (sample)', MAJESTIC = 'Majestic Infra (sample)', DESH = 'Dorugohum Residency (sample)';
const DOCS = [
  doc('hub-a', 'invoice', 'sent', 'INV/26-27/0141', WISE, '2026-10-06', 150000, { dueDate: '2026-10-21' }),
  doc('hub-b', 'invoice', 'paid', 'INV/26-27/0139', WISE, '2026-10-02', 48500, { dueDate: '2026-10-17', paid: R(48500) }),
  doc('hub-c', 'invoice', 'part_paid', 'INV/26-27/0144', MAJESTIC, '2026-10-14', 300000, { dueDate: '2026-12-14', paid: R(100000) }),
  doc('hub-d', 'invoice', 'issued', 'INV/26-27/0152', WISE, '2026-11-18', 200000, { dueDate: '2026-12-03' }),
  doc('hub-e', 'quotation', 'issued', 'QT/26-27/0207', MAJESTIC, '2026-11-19', 472000, { dealStatus: 'to_send' }),
  doc('hub-f', 'quotation', 'draft', null, DESH, '2026-11-20', 23600),
  doc('hub-g', 'proforma', 'sent', 'PI/26-27/0031', WISE, '2026-11-17', 118000),
  doc('hub-h', 'quotation', 'sent', 'QT/26-27/0198', 'Sunrise Apartments (sample)', '2026-11-12', 236000, { dealStatus: 'sent', salespersonName: 'Adunor (sample)' }),
  doc('hub-i', 'credit_note', 'issued', 'CN/26-27/0004', MAJESTIC, '2026-11-02', 11800),
  doc('hub-j', 'quotation', 'accepted', 'QT/26-27/0180', 'Greenfield School (sample)', '2026-10-28', 590000, { dealStatus: 'accepted' }),
];
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const found = (id, why, whyText = null) => ({ ...DOCS.find((d) => d.id === id), why, whyText, score: 85 });

/** [status, body] for the documents list and its search, or null for anything else. */
export function docsHubAnswer(request, url) {
  const email = String(request.headers['cf-access-authenticated-user-email'] ?? '').toLowerCase();
  if (email !== HUB_EMAIL || !url.pathname.startsWith('/api/v0/erp')) return null;
  if (url.pathname === '/api/v0/erp/test-reset') return [200, { ok: true }];
  if (url.pathname === '/api/v0/erp/documents' && request.method === 'GET') return [200, { documents: DOCS, today: TODAY, canWrite: true, ownOnly: false, approvalMode: 'approver' }];
  if (url.pathname !== '/api/v0/erp/documents/search') return null;
  const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (/lakh/.test(q)) return [200, { documents: [found('hub-a', 'client')], closer: false, today: TODAY,
    understood: ['Invoices', 'Last month: 1–31 Oct 2026', 'Over ₹1 lakh', 'Matching “willow lane”'] }];
  if (/lyfe/.test(q)) return [200, { documents: ['hub-d', 'hub-g', 'hub-a', 'hub-b'].map((id) => found(id, 'closer', WISE)), closer: true, today: TODAY, understood: [`Matching “${q}”`] }];
  if (/purepower/.test(q)) return [200, { documents: [found('hub-e', 'item', 'PurePower 5.0 kW solar system')], closer: false, today: TODAY, understood: [`Matching “${q}”`] }];
  const hits = DOCS.filter((d) => squash(d.buyer.name).includes(squash(q)) || squash(d.number).includes(squash(q))).map((d) => ({ ...d, why: 'client', whyText: null, score: 85 }));
  return [200, { documents: hits, closer: false, today: TODAY, understood: [`Matching “${q}”`] }];
}
