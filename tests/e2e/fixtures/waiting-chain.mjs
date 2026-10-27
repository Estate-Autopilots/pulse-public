// Invented people, companies and tasks only; shared by row tests and browser evidence.
export const now = Date.parse('2026-10-27T12:00:00Z');
export const chain = {
  task: { id: 'tp-task', title: 'Synthetic launch', status: 'blocked' },
  steps: ['Approve the synthetic brief', 'Prepare the synthetic artwork', 'A private synthetic task'].map((title, i) => ({
    linkId: `synthetic-link-${i}`, depth: i + 1, fromId: i ? `synthetic-blocker-${i - 1}` : 'tp-task',
    blocker: { id: `synthetic-blocker-${i}`, title: i === 2 ? null : title, hidden: i === 2, status: 'open' },
    actor: i === 2 ? null : { id: `synthetic-owner-${i}`, name: i ? 'Studio Helper' : 'Avery Example', ai: i === 1, photoAt: null },
    company: { name: i ? 'Example Partner Studio' : 'Northwind Studio', address: null },
    since: '2026-10-24T12:00:00Z', answer: null, answeredAt: null, nudgedAt: null, nextNudgeAt: null, next: 'nudge',
  })), more: 2, declared: [{ kind: 'client', since: '2026-10-25T12:00:00Z' }],
};
