import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { demoPayload } from '../../packages/companion/src/demo.js';

// ATT (21 Oct 2026): notifications that never bury what matters, and attendance that asks only when it must.
// Synthetic people and data only; the API is answered by page routes (the web server's own API is the mock one).
const shots = process.env.ATT_SHOT_DIR ?? 'test-results/att';
const at = (minutes = 0) => new Date(Date.now() - minutes * 60000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number, title: string, priority: string, family: string, extra: Record<string, unknown> = {}) => ({
  id: id(n), ids: [id(n)], kind: 'task', eventType: 'task.assigned', title, body: null, href: '/tasks', at: at(n), readAt: null, active: true, state: 'open',
  group: priority === 'fyi' ? 'update' : 'action', actions: [], open: { label: 'Open', href: '/tasks' }, priority, family, ...extra });

async function routes(page: Page, { notices, updates, companion, exceptions }: { notices?: unknown; updates?: () => unknown; companion?: () => unknown; exceptions?: () => unknown }) {
  const posts: { path: string; body: unknown }[] = [];
  await page.route('**/api/v0/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/api/v0/', '');
    if (req.method() === 'POST') posts.push({ path, body: req.postDataJSON() });
    let data: unknown;
    if (path === 'companion' && companion) data = companion();
    else if (path === 'companion/updates' && updates) data = updates();
    else if (path === 'companion/notification-settings') data = { settings: { dnd: false, quiet: false, start: '21:00', end: '08:00', timezone: 'Asia/Kolkata', types: {}, channels: {}, mute: {} }, webPushKey: null };
    else if (path === 'notices' && notices) data = notices;
    else if (path === 'notices/read' || path === 'notices/read-all') data = { ok: true };
    else if (path === 'hr/attendance/exceptions' && exceptions) data = exceptions();
    else if (path.startsWith('hr/attendance/exceptions/')) data = { ok: true, withdrawn: 2 };
    else if (path === 'attendance/answer') data = { ok: true, answer: (req.postDataJSON() as { answer: string }).answer };
    else { await route.continue(); return; }
    await route.fulfill({ json: data });
  });
  return posts;
}

test.beforeEach(async ({ page }) => {
  test.skip(Boolean(process.env.PULSE_REAL_SMOKE), 'Synthetic fixtures');
  await mkdir(shots, { recursive: true });
  await page.setExtraHTTPHeaders({ 'Cf-Access-Authenticated-User-Email': 'admin@estateautopilots.com' });
});

test('the bell: urgent, then what needs you pinned on top, then for your information; one kind folds into one line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = [
    card(1, 'Your bank account was changed: check it', 'urgent', 'pay', { eventType: 'people.bank', kind: 'update' }),
    card(2, 'Asha asks for leave · 24 Oct', 'needs_you', 'approvals', { eventType: 'approval.waiting', kind: 'approval' }),
    card(3, 'Assigned: Edit the Baner reel', 'needs_you', 'tasks_assigned', { stack: 'stack:t' }),
    card(4, 'Assigned: Caption the Wakad shoot', 'needs_you', 'tasks_assigned', { stack: 'stack:t' }),
    card(5, 'Assigned: Plan the Kharadi walkthrough', 'needs_you', 'tasks_assigned', { stack: 'stack:t' }),
    card(6, 'Acknowledged: Diwali messages', 'fyi', 'task_updates', { eventType: 'task.accepted' }),
    card(7, '9 pm brief · Deliveries: 4', 'fyi', 'company_updates', { eventType: 'update.self', kind: 'update' }),
  ];
  const stacks = [{ id: 'stack:t', title: '3 tasks for you', body: 'Assigned: Edit the Baner reel · Assigned: Caption the Wakad shoot · and 1 more', family: 'tasks_assigned', priority: 'needs_you',
    ids: [id(3), id(4), id(5)], cards: [id(3), id(4), id(5)], unread: 3, at: at(3), href: '/tasks' }];
  await routes(page, {
    notices: { rows, stacks, counts: { unread: 7, action: 4, mention: 0, update: 3, important: 5 }, dnd: false, today: { due: 1, overdue: 0 } },
    updates: () => ({ person: { id: id(99), name: 'Synthetic Admin' }, settings: { dnd: false, quiet: false, start: '21:00', end: '08:00', timezone: 'Asia/Kolkata', types: {} }, suppression: null,
      rows: [], counts: { chats: 0, nonChat: 7, inbox: 7, important: 5, total: 7 }, cursor: at(), hasMore: false, page: null }),
  });
  await page.goto('/me', { waitUntil: 'load' });
  const bell = page.getByRole('button', { name: 'Notifications, 5 need you' });
  await expect(bell, 'the number is what needs you, not all seven').toBeVisible();
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  const headings = panel.getByRole('heading', { level: 3 });
  await expect(headings).toHaveText([/^Urgent/, /^Needs your action/, /^For your information/]);
  const needs = panel.locator('section[data-priority="needs_you"]');
  await expect(needs.getByRole('button', { name: '3 tasks for you', exact: true })).toBeVisible();
  await expect(needs.getByText('Assigned: Caption the Wakad shoot', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${shots}/bell-1440.png` });
  await needs.getByRole('button', { name: '3 tasks for you', exact: true }).click();
  await expect(needs.getByRole('link', { name: 'Assigned: Caption the Wakad shoot' })).toBeVisible();
  await expect(panel.locator('section[data-priority="urgent"]')).toContainText('Your bank account was changed');
  await page.screenshot({ path: `${shots}/bell-stack-open-1440.png` });
});

test('toasts: only what needs you, one at a time; for-your-information never toasts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = [
    { id: id(11), title: 'Asha asks for leave · 24 Oct', href: '/me/approvals', kind: 'approval', readAt: null, at: at(), pingAllowed: true },
    { id: id(12), title: 'Acknowledged: Diwali messages', href: '/tasks', kind: 'task', readAt: null, at: at(), pingAllowed: false },
    { id: id(13), title: 'Assigned: Edit the Baner reel', href: '/tasks', kind: 'task', readAt: null, at: at(), pingAllowed: true },
    { id: id(14), title: '9 pm brief · Deliveries: 4', href: '/me', kind: 'update', readAt: null, at: at(), pingAllowed: false },
  ];
  let served = 0;
  await routes(page, {
    notices: { rows: [], stacks: [], counts: { unread: 4, action: 2, mention: 0, update: 2, important: 2 }, dnd: false },
    updates: () => ({ person: { id: id(99), name: 'Synthetic Admin' }, settings: { dnd: false, quiet: false, start: '21:00', end: '08:00', timezone: 'Asia/Kolkata', types: {} }, suppression: null,
      rows: served++ ? rows : [], counts: { chats: 0, nonChat: 4, inbox: 4, important: 2, total: 4 }, cursor: at(), hasMore: false, page: null }),
  });
  await page.goto('/me', { waitUntil: 'load' });
  const island = page.locator('[data-island]');
  await expect(island).toHaveCount(1);
  const seen = new Set<string>();
  for (let i = 0; i < 40 && seen.size < 2; i++) {
    const text = await island.innerText().catch(() => '');
    for (const r of rows) if (text.includes(r.title)) seen.add(r.title);
    expect(['Asha asks for leave', 'Assigned: Edit the Baner reel'].filter((t) => text.includes(t)).length, 'never two at once').toBeLessThanOrEqual(1);
    await page.waitForTimeout(500);
  }
  expect([...seen].sort()).toEqual(['Asha asks for leave · 24 Oct', 'Assigned: Edit the Baner reel']);
  await expect(island).not.toContainText('Acknowledged: Diwali messages');
  await expect(island).not.toContainText('9 pm brief');
});

test('the attendance question: asked only when the signals conflict, answered in one tap, never again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Mid-shift (14:00 in Kolkata, the demo zone) whatever the runner clock says: late in the IST evening the demo day
  // is hours past its 19:00 end and the control no longer reads as a working day (failed in CI at 23:50 IST).
  const now = Date.parse(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + 'T14:00:00+05:30');
  let question: unknown = null;
  const posts = await routes(page, {
    companion: () => {
      const p = demoPayload('in', now) as Record<string, unknown> & { entry: Record<string, unknown> };
      // The mock API's admin is "synthetic-admin": the control shows only the signed-in person's own day.
      return { ...p, person: { id: 'synthetic-admin', name: 'Synthetic Admin', firstName: 'Synthetic' }, entry: { ...p.entry, id: id(21), inVia: 'auto' }, presence: { ...(p.presence as object), autoCheckOut: true }, question };
    },
  });
  // The signals answer it (at the office, or automatic check-out on): no question, no "check out" push.
  await page.goto('/me?tab=attendance', { waitUntil: 'load' });
  const chip = page.locator('header').getByRole('button', { name: /worked today|Still working/ }).first();
  await expect(chip).toBeVisible();
  await expect(page.getByRole('button', { name: /Yes, I left at/ })).toHaveCount(0);
  // A conflict (gone from the office, the laptop busy elsewhere): one question with two answers.
  question = { entryId: id(21), kind: 'left', leftAt: new Date(now - 40 * 60000).toISOString(), askedAt: new Date(now - 5 * 60000).toISOString(), office: 'Synthetic Studio' };
  await page.goto('/me?ask=' + id(21), { waitUntil: 'load' });
  const yes = page.getByRole('button', { name: /^Yes, I left at \d\d:\d\d$/ });
  await expect(yes).toBeVisible();
  await expect(page.getByText(/You left Synthetic Studio at \d\d:\d\d\./).first()).toBeVisible();
  await page.screenshot({ path: `${shots}/question-1440.png` });
  question = null;
  await page.getByRole('button', { name: 'Still working', exact: true }).click();
  await expect.poll(() => posts.filter((p) => p.path === 'attendance/answer').length).toBe(1);
  expect(posts.find((p) => p.path === 'attendance/answer')?.body).toEqual({ entryId: id(21), answer: 'working' });
  await page.reload({ waitUntil: 'load' });
  await expect(page.getByRole('button', { name: /Yes, I left at/ })).toHaveCount(0);
});

test('HR sees only the days Pulse could not settle, with what it saw, and settles each in one tap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let open = [{ id: id(31), personId: id(41), name: 'Asha Synthetic', date: '2026-10-20', kind: 'missing_checkout', summary: 'No check-out; closed at the end of the shift',
    evidence: { reason: 'shift_end', signals: [] }, inClock: '10:05', outClock: '19:00', inVia: 'web', outVia: 'auto', timeline: [] },
    { id: id(32), personId: id(42), name: 'Ravi Synthetic', date: '2026-10-20', kind: 'unanswered', summary: 'Left the office but kept working elsewhere; no answer',
      evidence: { reason: 'left_unanswered', signals: ['laptop', 'wifi'] }, inClock: '09:52', outClock: '18:39', inVia: 'auto', outVia: 'auto',
      timeline: [{ kind: 'auto_check_in', at: '2026-10-20T04:22:00Z', clock: '09:52', signals: ['laptop', 'wifi'], detail: null }, { kind: 'asked', at: '2026-10-20T13:24:00Z', clock: '18:54', signals: [], detail: 'left' }] }];
  const stale = [{ id: id(51), personId: id(43), name: 'Kedab Synthetic', date: '2026-10-13', outTime: '11:29', inTime: '11:29' }, { id: id(52), personId: id(43), name: 'Kedab Synthetic', date: '2026-10-15', outTime: '13:25', inTime: '13:25' }];
  let withdrawn = false;
  const posts = await routes(page, { exceptions: () => ({ attendanceEnabled: true, open, stale: withdrawn ? [] : stale, counts: { open: open.length, settled: 41, corrections: 1 } }) });
  await page.goto('/hr?tab=attendance&view=check', { waitUntil: 'load' });
  await expect(page.getByText('41 days this week settled by themselves', { exact: false })).toBeVisible();
  await expect(page.getByText('2 check-out proposals Pulse made by mistake')).toBeVisible();
  await expect(page.getByText('Seen by laptop in use + office Wi-Fi')).toBeVisible();
  await expect(page.getByText('No device saw them at the office')).toBeVisible();
  await page.screenshot({ path: `${shots}/hr-to-check-1440.png` });
  open = open.slice(1);
  await page.getByRole('button', { name: 'Confirm 19:00' }).click();
  await expect.poll(() => posts.filter((p) => p.path === `hr/attendance/exceptions/${id(31)}`).map((p) => p.body)).toEqual([{ action: 'confirm' }]);
  await expect(page.getByText('Asha Synthetic')).toHaveCount(0);
  withdrawn = true;
  await page.getByRole('button', { name: 'Withdraw all 2' }).click();
  await expect.poll(() => posts.some((p) => p.path === 'hr/attendance/exceptions/stale')).toBe(true);
  await expect(page.getByText('check-out proposals Pulse made by mistake')).toHaveCount(0);
});
