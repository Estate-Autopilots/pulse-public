/** FLOW-A: "Solar install" (Willow Lane Enterprises' way of working): a lead, a Sales X-Ray call, a site visit with GPS
 *  photos, the quotation with its follow-up beside it, the customer's approval, install photos and serial numbers, the
 *  tax invoice. Same engine, its own words: nothing of the agency template leaks into it. */
import type { FlowDef, FlowStep, FlowWire } from '../types.js';

const role = (r: string) => ({ by: 'role' as const, role: r });
const step = (id: string, stage: string, module: string, title: string, who: string, x: number, y: number, more: Partial<FlowStep> = {}): FlowStep =>
  ({ id, stage, module, title, who: role(who), settings: {}, pos: { x, y }, checklist: [], qualityTest: [], inputs: [], when: [], due: null, hours: null, note: null, sop: null, ...more });
const w = (from: string, fp: string, to: string, tp: string, notify?: string[]): FlowWire => ({ from: { step: from, port: fp }, to: { step: to, port: tp }, ...(notify ? { notify } : {}) });

export const SOLAR: { key: string; name: string; summary: string; definition: FlowDef } = {
  key: 'solar_install', name: 'Solar install',
  summary: 'From a new lead to the tax invoice: the sales call, a site visit with GPS photos, the quotation and its follow-up, approval, the install with photos and serial numbers, then billing.',
  definition: {
    version: 2,
    fields: [
      { key: 'system_kw', label: 'System size (kW)', type: 'number' },
      { key: 'roof', label: 'Roof', type: 'choice', options: [{ value: 'rcc', label: 'RCC' }, { value: 'tin', label: 'Tin shed' }, { value: 'ground', label: 'Ground mount' }] },
      { key: 'subsidy', label: 'Subsidy and net metering', type: 'boolean', variant: true, help: 'The customer applies for the subsidy and a net meter' },
    ],
    roles: [{ key: 'sales', label: 'Sales executive' }, { key: 'surveyor', label: 'Site surveyor' }, { key: 'installer', label: 'Install team lead' }, { key: 'accounts', label: 'Accounts' }, { key: 'owner', label: 'Owner' }],
    stages: [{ key: 'lead', label: 'Lead' }, { key: 'survey', label: 'Site visit' }, { key: 'quote', label: 'Quote' }, { key: 'install', label: 'Install' }, { key: 'billing', label: 'Billing' }],
    steps: [
      step('s1', 'lead', 'lead_capture', 'New lead', 'sales', 40, 120),
      step('s2', 'lead', 'sales_xray', 'Sales X-Ray call', 'sales', 40, 300, { due: { from: 'start', days: 1, workdays: true } }),
      step('s3', 'survey', 'site_visit', 'Site visit · GPS photos of the roof, meter and shading', 'surveyor', 380, 120, { due: { from: 'start', days: 3, workdays: true },
        checklist: ['Roof photo with location and time', 'Meter and DB photo', 'Shading at noon', 'Roof measurements'] }),
      step('s4', 'quote', 'quotation', 'Quotation', 'sales', 720, 120, { due: { from: 'step:s3', days: 2, workdays: true } }),
      step('s5', 'quote', 'follow_up', 'Follow-up until the customer answers', 'sales', 720, 300),
      step('s6', 'quote', 'approval', 'Customer approves the quote', 'sales', 1060, 120),
      step('s7', 'install', 'data_capture', 'Install: photos and panel / inverter serial numbers', 'installer', 1400, 120, { checklist: ['Photo of every array', 'Panel serial numbers', 'Inverter serial number', 'Customer signs the handover'] }),
      step('s8', 'install', 'checklist', 'Subsidy and net-metering papers', 'accounts', 1400, 300, { when: [{ field: 'subsidy', op: 'eq', value: 'true' }],
        checklist: ['Subsidy application filed', 'Net-meter application filed', 'Inspection booked'] }),
      step('s9', 'billing', 'tax_invoice', 'Tax invoice', 'accounts', 1740, 120, { due: { from: 'step:s7', days: 2, workdays: true } }),
      step('s10', 'billing', 'end', 'Job done', 'owner', 2080, 120),
    ],
    wires: [w('s1', 'lead', 's2', 'lead'), w('s1', 'lead', 's3', 'lead', ['surveyor']), w('s1', 'lead', 's4', 'lead'), w('s2', 'items', 's4', 'items'), w('s3', 'photos', 's4', 'survey', ['sales']),
      w('s4', 'quote', 's5', 'quote'), w('s4', 'quote', 's6', 'in'), w('s6', 'verdict', 's7', 'in', ['installer']), w('s6', 'verdict', 's8', 'in', ['accounts']),
      w('s4', 'quote', 's9', 'quote'), w('s7', 'answers', 's9', 'record', ['accounts']), w('s9', 'invoice', 's10', 'in')],
    rules: [
      { key: 'visit_late', name: 'Site visit late', when: 'not-done-by-due', steps: ['s3'], notify: ['surveyor', 'owner'] },
      { key: 'quote_late', name: 'Quote not sent', when: 'not-done-by-due', steps: ['s4'], notify: ['sales', 'owner'] },
      { key: 'invoice_late', name: 'Invoice not made after the install', when: 'value-missing-after', after: 's7', missing: 's9', waitDays: 2, notify: ['accounts', 'owner'] },
    ],
    scorecard: [{ key: 'quote_on_time', label: 'Quotes on time', kind: 'on-time', steps: ['s4'] }, { key: 'invoice_on_time', label: 'Invoices on time', kind: 'on-time', steps: ['s9'] }],
    clock: { from: 'start' }, terms: { run: 'Job', runs: 'Jobs' },
  },
};

/** FLOW-D: the installer's own blocks, saved from this template's steps. */
export const SOLAR_BLOCKS = ([['s2', 'Sales call (Sales X-Ray)'], ['s3', 'Roof survey (GPS photos)'], ['s4', 'Quotation'], ['s5', 'Quote follow-up'],
  ['s7', 'Install record (photos + serial numbers)'], ['s8', 'Subsidy and net-metering papers'], ['s9', 'Tax invoice']] as const).map(([id, name]) => {
  const s = SOLAR.definition.steps.find((x) => x.id === id)!;
  return { key: `solar-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, name, summary: s.title, step: { ...s, when: [] } };
});
