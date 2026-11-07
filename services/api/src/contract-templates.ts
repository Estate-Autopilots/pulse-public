// CONNECTORS-CONTRACTS (owner, 6 Nov 2026): the starting terms for a new contract (docs/spec/CONTRACTS.md §5). Product
// code, the same for every company; every field can be changed before the contract is sent. Amounts are in paise.
export type RateLine = { label: string; amountMinor: number; unit: 'month' | 'hour' | 'deliverable' | 'one_off' | 'percent' };
export type Template = { key: 'retainer' | 'services' | 'employment' | 'revenue_share'; kind: 'retainer' | 'services' | 'employment' | 'revenue_share';
  name: string; summary: string; title: string; scope: string; deliverables: string[]; rates: RateLine[];
  schedule: 'monthly' | 'quarterly' | 'milestones' | 'on_delivery' | 'one_off'; noticeDays: number; roles: [string, string] };

export const TEMPLATES: readonly Template[] = [
  { key: 'retainer', kind: 'retainer', name: 'Monthly retainer', summary: 'A monthly fee for ongoing work, invoiced each month',
    title: 'Monthly retainer', scope: 'Ongoing work each month, as agreed in the monthly plan. Work beyond the plan is quoted separately.',
    deliverables: ['Monthly plan agreed by the 5th', 'Work delivered through the month', 'Monthly report'],
    rates: [{ label: 'Monthly retainer', amountMinor: 10000000, unit: 'month' }], schedule: 'monthly', noticeDays: 30, roles: ['provider', 'client'] },
  { key: 'services', kind: 'services', name: 'Services (fixed scope)', summary: 'Named deliverables, each with its price, invoiced on delivery',
    title: 'Services agreement', scope: 'The deliverables listed below. Changes to the scope are agreed in writing and may change the price.',
    deliverables: ['First deliverable', 'Second deliverable'],
    rates: [{ label: 'First deliverable', amountMinor: 5000000, unit: 'deliverable' }, { label: 'Second deliverable', amountMinor: 5000000, unit: 'deliverable' }],
    schedule: 'on_delivery', noticeDays: 15, roles: ['provider', 'client'] },
  { key: 'employment', kind: 'employment', name: 'Employment', summary: 'A role, monthly pay, probation and notice',
    title: 'Employment', scope: 'The role, its duties and working hours as described here. Probation of three months.',
    deliverables: ['Duties of the role', 'Working hours and place of work'],
    rates: [{ label: 'Monthly pay (gross)', amountMinor: 5000000, unit: 'month' }], schedule: 'monthly', noticeDays: 30, roles: ['employer', 'employee'] },
  { key: 'revenue_share', kind: 'revenue_share', name: 'Revenue share', summary: 'A share of revenue, with a monthly statement',
    title: 'Revenue share', scope: 'A share of the revenue from the work described here, paid monthly against a statement.',
    deliverables: ['Monthly revenue statement', 'Payment of the share by the 10th'],
    rates: [{ label: 'Share of revenue', amountMinor: 1000, unit: 'percent' }], schedule: 'monthly', noticeDays: 60, roles: ['partner', 'partner'] },
];

export const templateOf = (key: unknown) => TEMPLATES.find((t) => t.key === key) ?? null;
