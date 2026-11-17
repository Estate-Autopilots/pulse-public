// KAZUK-REST (A19): a lead's stage in plain words on the salesperson's desk. Sales X-Ray sends its own label when it has
// one; Pulse's stages and the usual ones read as below; anything else is shown as sent, first letter capitalised.
const STAGES = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', negotiation: 'Negotiating', won: 'Won', lost: 'Lost',
  site_visit: 'Site visit', follow_up: 'Follow-up' };

export function deskStageLabel(stage, label) {
  if (typeof label === 'string' && label.trim()) return label.trim();
  const key = String(stage ?? '').trim().toLowerCase();
  if (!key) return 'New';
  if (STAGES[key]) return STAGES[key];
  const words = key.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
