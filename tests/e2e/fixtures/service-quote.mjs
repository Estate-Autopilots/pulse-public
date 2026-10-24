// Synthetic service-created quotation details for the staff document page only.
export function serviceQuoteDocument(path) {
  const match = /^\/api\/v0\/erp\/documents\/12500000-0000-4000-8000-00000000000([1234])$/.exec(path);
  if (!match) return null;
  const variant = Number(match[1]), approved = variant === 3;
  const company = { legalName: 'Synthetic Studio', stateCode: '27', address: [] };
  const line = { itemId: null, description: 'Synthetic design package', details: '', sac: null, unit: 'unit', qty: 2,
    rate: 123456, discount: 0, discountPercent: null, gstRate: 18, taxable: 246912, cgst: 22222, sgst: 22222, igst: 0, total: 291356 };
  return {
    document: { id: path.split('/').at(-1), docType: 'quotation', status: approved ? 'issued' : 'draft', number: approved ? 'Q-SYN-001' : null,
      issueDate: '2026-10-18', validUntil: '2026-11-17', dueDate: null, buyer: { name: 'Synthetic Client', stateCode: '27', address: [] }, seller: company,
      placeOfSupply: '27', reference: {}, notes: '', terms: '', reverseCharge: false, zeroRated: false, roundTotal: false, templateId: null,
      taxMode: 'intra', taxable: 246912, cgst: 22222, sgst: 22222, igst: 0, total: 291356, paid: 0, credited: 0,
      updatedAt: '2026-10-18T12:00:00Z', issuedAt: approved ? '2026-10-18T12:00:00Z' : null, taskId: null,
      fromServiceKey: variant !== 4, ownerApproval: variant === 1 ? 'needed' : approved ? 'approved' : null, salespersonName: 'Synthetic Salesperson' },
    lines: [line], payments: [], events: [], related: [], file: null, task: null, links: [], bank: [], items: [], templates: [], template: null,
    orgLogo: false, company, canWrite: true, today: '2026-10-18', assignees: [], financeSyncedAt: null,
  };
}
