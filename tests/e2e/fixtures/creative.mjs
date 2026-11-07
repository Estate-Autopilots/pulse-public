// EST-1902: synthetic Creative Strategy only. No tenant data or accepted server writes.
export const creativePeople = [{ id: 'synthetic-gs', name: 'Synthetic Growth' }, { id: 'synthetic-cs', name: 'Synthetic Creative' }];
export const creativeConfig = { packages: [{ key: 'core', label: 'Core' }, { key: 'plus', label: 'Plus' }, { key: 'complete', label: 'Complete' }], canStart: true };
export const creativeView = {
  sprint: { id: 'synthetic-sprint', projectId: 'synthetic-project', project: 'Synthetic Creative Campaign with a deliberately long project name for the header and retry action', package: 'core',
    dayOne: '2026-10-20', approver: 'Synthetic Approver', gsPersonId: 'synthetic-gs', gs: 'Synthetic Growth', csPersonId: 'synthetic-cs', cs: 'Synthetic Creative', status: 'active', editedAt: '' },
  inputs: [{ key: 'brochure', label: 'Brochure', ownerPersonId: 'synthetic-gs', owner: 'Synthetic Growth', receivedOn: null, note: null }],
  milestones: [{ key: 'research', label: 'Research meet', stage: 1, where: 'Research', dueDay: 1, day: 1, due: '2026-10-20', doneOn: null, state: 'upcoming', ownerPersonId: 'synthetic-cs', owner: 'Synthetic Creative', note: null }],
  approvalWorkingDays: 3, link: '/creative/sprints/synthetic-sprint', canReassign: true,
  clock: { dayOne: '2026-10-20', today: '2026-10-19', day: 0, shift: 0, lateInputs: 0, missingInputs: 1 },
};
const failedOnce = new Set();
export function creativeAnswer(url, method, identity) {
  const path = url.pathname.replace('/api/v0/creative/', '');
  if (!url.pathname.startsWith('/api/v0/creative/')) return null;
  if (method !== 'GET') return [503, { error: 'Synthetic write refused' }];
  const failing = identity.match(/^creative-(home|sprints|detail|config)-error@/)?.[1];
  if ((path === failing || failing === 'detail' && path === 'sprints/synthetic-sprint') && !failedOnce.has(identity)) {
    failedOnce.add(identity); return [503, { error: 'Synthetic outage' }];
  }
  if (path === 'config') return [200, creativeConfig];
  if (path === 'choices') return [200, { projects: [{ id: 'synthetic-project', name: 'Synthetic Campaign', client: null }], people: creativePeople, me: 'synthetic-gs' }];
  if (path === 'home') return [200, { person: creativePeople[0], rows: [], sprints: 0, canChoosePerson: true }];
  if (path === 'sprints') return [200, { sprints: [], canStart: true }];
  if (path === 'sprints/forbidden') return [403, { error: 'This sprint is not yours to open' }];
  if (path === 'sprints/synthetic-sprint') return [200, creativeView];
  return [404, { error: 'Sprint not found' }];
}
