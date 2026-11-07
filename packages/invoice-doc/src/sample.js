// ERP-INVOICE: a synthetic document for template previews and tests. Invented buyer, GSTIN (valid shape and check
// character, not a real registration), project and figures; the seller is whatever company profile is passed in.

export const SAMPLE_BUYERS = Object.freeze({
  intra: { name: 'Northstar Homes LLP', gstin: '27AABCS5678K1ZS', stateCode: '27', address: ['Office 4, Riverside Plaza, Baner Road', 'Pune 411045, Maharashtra'], contactName: 'Asha Kireteso', email: 'accounts@northstar.example', phone: '+91 90000 00001' },
  inter: { name: 'Lakeview Developers Pvt Ltd', gstin: '29AAACN1234F1ZT', stateCode: '29', address: ['12 Lake Road, Indiranagar', 'Bengaluru 560038, Karnataka'], contactName: 'Ravi Menon', email: 'finance@lakeview.example', phone: '+91 90000 00002' },
});

/** A complete draft of `docType` for the given seller; `inter` bills a buyer in another state (IGST). */
export function sampleDocument(seller, { docType = 'invoice', inter = false, number = null, issueDate = '2026-10-12' } = {}) {
  const buyer = inter ? SAMPLE_BUYERS.inter : SAMPLE_BUYERS.intra;
  return {
    docType, status: number ? 'issued' : 'draft', number, issueDate, dueDate: '2026-10-27', validUntil: '2026-11-11',
    seller: seller ?? { legalName: 'Your Company LLP', gstin: '27AAXFV2138F1ZR', stateCode: '27', address: ['Your address'] },
    buyer, placeOfSupply: buyer.stateCode,
    reference: { project: 'Riverside Residences launch', milestone: 'Milestone 2 of 4: month 2 delivery', po: 'NS/PO/0112' },
    against: docType === 'credit_note' ? { number: 'EA/26-27/014', date: '2026-09-30' } : null,
    lines: [
      { description: 'Real-estate marketing package: month 2', details: 'Model-led brand film (1), voice-over videos (2), carousel ads (2), single-image ads (4)', sac: '998361', qty: 1, unit: 'month', rate: 6000000, gstRate: 18 },
      { description: 'Meta ads management', details: 'Campaign set-up, daily optimisation and the weekly lead report', sac: '998361', qty: 1, unit: 'month', rate: 1200000, gstRate: 18 },
      { description: 'Site-visit shoot (extra day)', sac: '998382', qty: 1.5, unit: 'day', rate: 850000, gstRate: 18 },
    ],
    notes: 'Thank you for your business. Please quote the invoice number with your payment.',
    roundTotal: true,
  };
}
