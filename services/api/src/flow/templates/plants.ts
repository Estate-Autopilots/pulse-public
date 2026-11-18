/** ONBOARD-SMOOTH (owner, 15 Nov 2026: "onboarding … must be butter smooth"; first real case a company that builds sewage
 *  and other water-treatment plants): the plant project, from the enquiry to the handover and the AMC offer. Built from
 *  the primitives like every starter (templates/starters.ts): the site survey with GPS photos, the bill of materials as
 *  records, the quotation and its follow-up, a QA call with each customer after the sale (its script is the checklist),
 *  2–3 vendor quotes for every item, then civil, pumps and plumbing, the electric panel, testing, commissioning, the
 *  certificates and the final bill. The work checklists hold 77 items (PLANT_CHECKS), the QA call script 11 lines.
 *  Data only: nothing here is special-cased anywhere in the code. */
import { build, days, type Starter } from './starters.js';

/** The QA call each sale gets: the customer care person reads it line by line and ticks each one. */
export const QA_CALL_SCRIPT = [
  'Greet the customer, say your name, and say you are calling to check their order',
  'Confirm the customer’s name, the site address and the contact person at the site',
  'Read back the plant: its type, capacity (KLD) and technology',
  'Read back the price, the GST, what is included and what is not',
  'Confirm the payment terms: the advance received, the next payments and when',
  'Confirm the dates promised: civil start, material delivery and commissioning',
  'Ask what the customer must give: the space, power, water and any approvals',
  'Ask: was anything promised that is not in the quotation?',
  'Ask how our sales person treated them, from 1 to 5',
  'Tell them who their site engineer is and how to reach us',
  'Write down every gap and tell the owner the same day',
];

/** The work checklists, by step (ids as in the definition below). */
export const PLANT_CHECKS: Record<string, string[]> = {
  survey: [
    'Photo of the plant area with location and time',
    'Space measured: length, width and depth',
    'Daily water use (KLD) and where it comes from',
    'Where the treated water goes: garden, flushing or drain',
    'Power supply and where the electric panel will sit',
    'Room for a crane or tractor to reach the site',
  ],
  quotes: [
    'Electric panel: 3 vendor quotes',
    'Pumps (raw sewage, filter feed, sludge): 3 vendor quotes',
    'Air blowers and diffusers: 2–3 vendor quotes',
    'Pipes, valves and fittings: 2–3 vendor quotes',
    'Tanks and fabrication (FRP or MS): 2–3 vendor quotes',
    'Media and chemicals (MBBR media, chlorine, PAC): 2 vendor quotes',
    'Filters (pressure sand, activated carbon): 2 vendor quotes',
    'Instruments (flow meter, level switches): 2 vendor quotes',
  ],
  pick: [
    'Compare the price, delivery days and warranty of each quote',
    'Pick one vendor per item and write down why',
    'Purchase orders sent to the chosen vendors',
  ],
  material: [
    'Delivery date fixed with each vendor',
    'Material checked against the purchase order',
    'Damage or shortage written down, with photos',
    'Test certificates and warranty cards collected',
    'Stock at the site counted and kept safe',
  ],
  civil: [
    'Layout marked as per the drawing',
    'Digging done to the right depth',
    'PCC base laid',
    'Tank walls and slab cast',
    'Waterproofing done',
    'Tanks filled with water for 24 hours: no leak',
    'Covers, manholes and ladders fitted',
    'Site photos at each stage',
  ],
  plumbing: [
    'Raw sewage pumps fixed and aligned',
    'Filter feed pumps fixed',
    'Sludge pump fixed',
    'Air blowers on their base with anti-vibration pads',
    'Diffusers laid level across the tank',
    'MBBR media filled to the design level',
    'Pipes laid as per the drawing, with the right slope',
    'Valves, non-return valves and unions fitted',
    'Pressure sand filter and carbon filter fitted',
    'Chlorine dosing set fitted',
  ],
  serials: [
    'Photo of every pump and blower name plate',
    'Serial numbers written down',
    'Warranty dates written down',
    'Photos of the whole plant',
  ],
  electric: [
    'Electric panel fixed and earthed',
    'Panel wiring checked against the drawing',
    'Cables laid in trays or pipes',
    'Each motor connected and its turning direction checked',
    'Overload and phase-failure relays set',
    'Level switches and float switches wired',
    'Timers set for the blowers and pumps',
    'Earthing resistance measured and written down',
    'Labels and the wiring diagram fixed inside the panel door',
  ],
  testing: [
    'Dry run of every motor, without load',
    'Wet run with clean water',
    'No leaks at joints or tanks',
    'Air comes out of every diffuser',
    'Pump flow and pressure checked',
    'Filters backwashed once',
    'Auto mode runs on its timers and level switches',
    'Alarms and trips tested',
  ],
  commission: [
    'Bacteria culture added to the tank',
    'Sludge level (MLSS) checked every day',
    'Plant run until the outlet water is steady',
    'Outlet water clear, with no smell',
    'Site operator trained: start, stop, backwash and dosing',
    'Log book and daily check sheet handed over',
    'Operation and maintenance manual handed over',
  ],
  lab: [
    'Inlet water sample taken',
    'Outlet water sample taken once the plant is steady',
    'BOD, COD and TSS within the limits',
    'pH and leftover chlorine within the limits',
    'Lab report uploaded here',
  ],
  papers: [
    'Pollution Control Board papers, where the site needs them',
    'Equipment warranty cards',
    'As-built drawings',
    'Commissioning certificate signed',
  ],
};

/** Why a plant project is late (the pack's Delay record offers these). */
export const PLANT_DELAY_REASONS = [
  'Site not ready', 'Customer payment pending', 'Material late from the vendor', 'Labour not available', 'Design changed',
  'Approval or permission pending', 'No power or water at the site', 'Rain or weather', 'Other',
];

export const PLANT_PROJECT: Starter = {
  key: 'plant_project', name: 'Plant project',
  summary: 'An enquiry, the site survey with GPS photos, the bill of materials, the quotation and its follow-up, a QA call with the customer, 2–3 vendor quotes for every item, civil work, pumps and plumbing, the electric panel, testing, commissioning, the lab report and certificates, then the final bill and the AMC offer.',
  definition: build({
    fields: [
      { key: 'plant_type', label: 'Plant type', type: 'choice', options: [{ value: 'stp', label: 'STP (sewage)' }, { value: 'atp', label: 'ATP' }, { value: 'etp', label: 'ETP (effluent)' }, { value: 'wtp', label: 'WTP (water)' }] },
      { key: 'capacity_kld', label: 'Capacity (KLD)', type: 'number' },
      { key: 'pcb', label: 'Needs Pollution Control Board papers', type: 'boolean', variant: true, help: 'The site needs consent papers from the Pollution Control Board' },
    ],
    roles: [{ key: 'sales', label: 'Sales executive' }, { key: 'engineer', label: 'Design engineer' }, { key: 'qa', label: 'Customer care' }, { key: 'purchase', label: 'Purchase' },
      { key: 'site', label: 'Site engineer' }, { key: 'accounts', label: 'Accounts' }, { key: 'owner', label: 'Owner' }],
    stages: [{ key: 'sale', label: 'Sale' }, { key: 'buy', label: 'Purchase' }, { key: 'build', label: 'Build' }, { key: 'test', label: 'Testing' },
      { key: 'handover', label: 'Commissioning' }, { key: 'billing', label: 'Billing' }],
    steps: [
      ['p1', 'sale', 'start', 'lead_capture', 'New enquiry', 'sales'],
      ['p2', 'sale', 'collect', 'site_visit', 'Site survey · GPS photos of the plant area', 'engineer', { ...days(3), checklist: PLANT_CHECKS.survey }],
      ['p3', 'sale', 'write', 'records', 'Bill of materials: every item the plant needs', 'engineer', { ...days(2, 'step:p2'), settings: { recordType: 'bom_item' } }],
      ['p4', 'sale', 'app', 'quotation', 'Quotation to the customer', 'sales', days(2, 'step:p3')],
      ['p5', 'sale', 'task', 'follow_up', 'Follow up until the customer answers', 'sales'],
      ['p6', 'sale', 'review', 'approval', 'Order confirmed, advance received', 'sales'],
      ['p7', 'sale', 'meet', 'meeting', 'QA call with the customer', 'qa', { ...days(1, 'step:p6'), checklist: QA_CALL_SCRIPT,
        note: 'Call within a day of the order. Read each line of the script and tick it. Any gap goes to the owner the same day.' }],
      ['p8', 'buy', 'write', 'records', 'Vendor quotes: 2–3 for every item', 'purchase', { ...days(4, 'step:p6'), settings: { recordType: 'vendor_quote' }, checklist: PLANT_CHECKS.quotes }],
      ['p9', 'buy', 'review', 'approval', 'Owner picks the vendor for each item', 'owner', { checklist: PLANT_CHECKS.pick }],
      ['p10', 'buy', 'task', 'checklist', 'Material reaches the site', 'purchase', { ...days(10, 'step:p9'), checklist: PLANT_CHECKS.material }],
      ['p11', 'build', 'task', 'checklist', 'Civil work', 'site', { ...days(15, 'step:p6'), checklist: PLANT_CHECKS.civil }],
      ['p12', 'build', 'task', 'checklist', 'Pumps, blowers and plumbing', 'site', { ...days(7, 'step:p11'), checklist: PLANT_CHECKS.plumbing }],
      ['p13', 'build', 'collect', 'data_capture', 'Name plates and serial numbers', 'site', { checklist: PLANT_CHECKS.serials }],
      ['p14', 'build', 'task', 'checklist', 'Electric panel and wiring', 'site', { ...days(5, 'step:p12'), checklist: PLANT_CHECKS.electric }],
      ['p15', 'test', 'task', 'checklist', 'Testing: dry run and wet run', 'site', { ...days(3, 'step:p14'), checklist: PLANT_CHECKS.testing }],
      ['p16', 'handover', 'task', 'checklist', 'Commissioning', 'site', { ...days(21, 'step:p15'), checklist: PLANT_CHECKS.commission }],
      ['p17', 'handover', 'collect', 'upload', 'Water test report from a lab', 'site', { checklist: PLANT_CHECKS.lab }],
      ['p18', 'handover', 'collect', 'upload', 'Certificates and papers', 'site', { checklist: PLANT_CHECKS.papers }],
      ['p19', 'handover', 'collect', 'consent', 'The customer signs the handover', 'site'],
      ['p20', 'billing', 'app', 'tax_invoice', 'Final invoice', 'accounts', days(2, 'step:p19')],
      ['p21', 'billing', 'task', 'follow_up', 'Collect the balance payment', 'accounts'],
      ['p22', 'billing', 'message', 'message', 'AMC offer to the customer', 'sales', { settings: { channel: 'whatsapp',
        text: 'Hello {client}, your plant is running. We can look after it every month (AMC): operator visits, water tests and spare parts. Reply here and we will send the plan.' } }],
      ['p23', 'billing', 'end', 'end', 'Plant handed over', 'owner'],
    ],
    after: [['p1', 'p2'], ['p2', 'p3'], ['p3', 'p4'], ['p4', 'p5'], ['p5', 'p6'], ['p6', 'p7'], ['p6', 'p8'], ['p8', 'p9'], ['p9', 'p10'], ['p6', 'p11'],
      ['p10', 'p12'], ['p11', 'p12'], ['p12', 'p13'], ['p12', 'p14'], ['p14', 'p15'], ['p13', 'p15'], ['p15', 'p16'], ['p16', 'p17'], ['p16', 'p18'], ['p17', 'p19'], ['p18', 'p19'],
      ['p19', 'p20'], ['p20', 'p21'], ['p21', 'p22'], ['p7', 'p23'], ['p22', 'p23']],
    rules: [
      { key: 'quote_late', name: 'Quotation not sent', when: 'not-done-by-due', steps: ['p4'], notify: ['sales', 'owner'] },
      { key: 'qa_late', name: 'QA call not made', when: 'not-done-by-due', steps: ['p7'], notify: ['qa', 'owner'] },
      { key: 'vendor_late', name: 'Vendor quotes late', when: 'not-done-by-due', steps: ['p8'], notify: ['purchase', 'owner'] },
      { key: 'civil_late', name: 'Civil work late', when: 'not-done-by-due', steps: ['p11'], notify: ['site', 'owner'] },
      { key: 'commission_late', name: 'Commissioning late', when: 'not-done-by-due', steps: ['p16'], notify: ['site', 'owner'] },
      { key: 'invoice_late', name: 'Final invoice not made after the handover', when: 'value-missing-after', after: 'p19', missing: 'p20', waitDays: 2, notify: ['accounts', 'owner'] },
    ],
    scorecard: [{ key: 'qa_on_time', label: 'QA calls within a day', kind: 'on-time', steps: ['p7'] }, { key: 'civil_on_time', label: 'Civil work on time', kind: 'on-time', steps: ['p11'] },
      { key: 'commission_on_time', label: 'Commissioned on time', kind: 'on-time', steps: ['p16'] }],
    terms: { run: 'Plant project', runs: 'Plant projects' },
  }),
};
