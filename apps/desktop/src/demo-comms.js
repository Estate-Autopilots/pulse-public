// Synthetic inbox and chats for "Try it without signing in" and runner screenshots (--demo). Fictional people only;
// nothing is sent anywhere.
const minutes = (n) => new Date(Date.now() - n * 60000).toISOString();
const ME = 'd0000000-0000-4000-8000-000000000001';
const people = [
  { id: ME, name: 'You (demo)', team: 'Creative', pod: 'Pod 2' },
  { id: 'd0000000-0000-4000-8000-000000000002', name: 'Mira Kapoor', team: 'Leadership', pod: 'Leadership' },
  { id: 'd0000000-0000-4000-8000-000000000003', name: 'Ahoro Mifos', team: 'Creative', pod: 'Pod 2' },
  { id: 'd0000000-0000-4000-8000-000000000004', name: 'Nisha Rao', team: 'Operations', pod: 'Pod 1' },
];
const channels = [
  { id: 'c0000000-0000-4000-8000-000000000001', name: 'Leadership', kind: 'pod', members: 4, unread: 3, lastAt: minutes(4), preview: 'Can we lock the Friday review slot?', previewAuthor: 'Mira Kapoor' },
  { id: 'c0000000-0000-4000-8000-000000000002', name: 'Ahoro Mifos', kind: 'direct', members: 2, unread: 1, lastAt: minutes(26), preview: 'Uploaded the 3D walkthrough, take a look', previewAuthor: 'Ahoro Mifos' },
  { id: 'c0000000-0000-4000-8000-000000000003', name: 'Pod 2', kind: 'pod', members: 6, unread: 0, lastAt: minutes(95), preview: 'Thanks all, great week!', previewAuthor: 'Nisha Rao' },
  { id: 'c0000000-0000-4000-8000-000000000004', name: 'Creative', kind: 'team', members: 7, unread: 0, lastAt: minutes(60 * 26), preview: 'New brand kit is in the shared folder', previewAuthor: 'Ahoro Mifos' },
];
const messages = {
  'c0000000-0000-4000-8000-000000000001': [
    { id: 'm1', authorId: people[1].id, name: 'Mira Kapoor', body: 'Morning! Client call moved to 3 pm.', createdAt: minutes(60 * 20) },
    { id: 'm2', authorId: ME, name: 'You (demo)', body: 'Noted, I will update the deck.', createdAt: minutes(60 * 20 - 3) },
    { id: 'm3', authorId: people[3].id, name: 'Nisha Rao', body: 'Leave requests for next week are all approved.', createdAt: minutes(38) },
    { id: 'm4', authorId: people[1].id, name: 'Mira Kapoor', body: 'Great. Can we lock the Friday review slot?', createdAt: minutes(5) },
    { id: 'm5', authorId: people[1].id, name: 'Mira Kapoor', body: '11 am works best for me.', createdAt: minutes(4), attachments: [], replies: 2 },
  ],
};
const inbox = [
  { id: 'n1', title: 'Ahoro Mifos asked for one day of leave on Monday', href: '/me?tab=requests', kind: 'approval', readAt: null, at: minutes(12) },
  { id: 'n2', title: 'Mira Kapoor mentioned you in Leadership', href: '/chats?channel=c0000000-0000-4000-8000-000000000001', kind: 'mention', readAt: null, at: minutes(4), channelId: 'c0000000-0000-4000-8000-000000000001' },
  { id: 'n3', title: 'Your comp-off for Saturday was approved', href: '/me?tab=requests', kind: 'decision', readAt: minutes(50), at: minutes(70) },
  { id: 'n4', title: 'Holiday on Friday: Dussehra', href: '/me', kind: 'holiday', readAt: minutes(60 * 5), at: minutes(60 * 6) },
];

export function demoSnapshot() {
  return { person: { id: ME, name: 'You (demo)' }, counts: { inbox: inbox.filter((r) => !r.readAt).length, chats: channels.reduce((n, c) => n + c.unread, 0), total: 6 }, rows: [] };
}
const wallet = {
  wallet: { balances: [{ key: 'casual', label: 'Casual', available: 4.5, pending: 0 }, { key: 'sick', label: 'Sick', available: 6, pending: 0 }, { key: 'comp_off', label: 'Comp-off', available: 1, pending: 0 }],
    nextHoliday: { day: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10), name: 'Dussehra' }, month: { present: 7, late: 1, extraMinutes: 200 } },
  day: { checkedInAt: minutes(60 * 3 + 5), checkedOutAt: null, workedMinutes: 165, breakMinutes: 20, office: 'EA Studio', deliveries: 2, focus: [{ tool: 'Premiere', minutes: 95 }], manager: { id: people[1].id, name: 'Mira Kapoor' } },
  late: { minutes: 7, checkedInAt: minutes(60 * 3 + 5), arrivedAt: minutes(60 * 3 + 18), office: 'EA Studio', device: 'laptop', disputable: true, pending: false },
};
export async function demoCall(path, body) {
  if (path === 'companion/wallet') return wallet;
  if (path === 'companion/late-dispute') { wallet.late.pending = true; wallet.late.disputable = false; return { status: 'pending' }; }
  if (path === 'chats') return { channels, people, viewer: ME };
  if (path === 'companion/inbox') return { rows: inbox };
  if (path === 'companion/read') { const row = inbox.find((r) => r.id === body?.id); if (row) row.readAt = new Date().toISOString(); return { ok: true }; }
  if (path === 'chats/direct') return { id: channels[1].id };
  const read = path.match(/^chats\/([0-9a-f-]+)\/read$/);
  if (read) { const ch = channels.find((c) => c.id === read[1]); if (ch) ch.unread = 0; return { ok: true }; }
  const thread = path.match(/^chats\/([0-9a-f-]+)\/messages$/);
  if (thread) {
    const list = (messages[thread[1]] ??= []);
    if (body?.body) { list.push({ id: crypto.randomUUID(), authorId: ME, name: 'You (demo)', body: body.body, createdAt: new Date().toISOString() }); return { id: thread[1] }; }
    return { messages: list, members: [] };
  }
  return { ok: true };
}
export const DEMO_CONVERSATION = channels[0].id;
