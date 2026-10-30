// CHATS-2 in the browser: the real API and the built web app on a disposable synthetic agency
// (tests/core/test_chats_browser.py). E-mail is synthetic too: the reader's requests are answered with invented mail
// passed through the real sanitiser. Optional screenshots: PULSE_CHATS_SCREENSHOTS=<dir>.
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { sanitizeEmailHtml } from '../dist/email-model.js';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool); let browserChecks = 0;
const E = JSON.parse(process.env.TEST_IDS);
const emails = { member: process.env.TEST_MEMBER, head: process.env.TEST_HEAD, hr: 'hr@estateautopilots.com', admin: 'admin@estateautopilots.com' };
const shots = process.env.PULSE_CHATS_SCREENSHOTS;
const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const net = await import('node:net'); const probe = net.createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: '../../apps/web', env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'production', PULSE_PUBLIC_LOGIN_ENABLED: '0' }, stdio: 'ignore' });
let browser;
const check = (condition, msg) => { browserChecks++; assert.ok(condition, msg); };
const seen = async (locator, timeout = 20000) => { await expect(locator.first()).toBeVisible({ timeout }); browserChecks++; };
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const rows = (page) => page.locator('nav[aria-label="Conversations"] [data-chat-row]');
const row = (page, name) => rows(page).filter({ hasText: name });
const log = (page) => page.locator('[role="log"]');
const go = async (page, path) => { await page.goto(base + path, { waitUntil: 'load' }); await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 60000 }); await page.waitForTimeout(250); };
// A message by its own text: the bubble's paragraph, not a quote of it in a reply.
const message = (page, text) => log(page).locator('article').filter({ has: page.locator('p', { hasText: text }) }).last();
const hoverMessage = async (page, text) => {
  const m = message(page, text);
  // Keep the floating action menu inside the message viewport. Minimal scrolling can leave an already-visible
  // message at the edge, where its menu is clipped and Playwright's pointer click lands outside the item.
  await m.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await m.hover();
  return m;
};

// --------------------------------------------------------------------------------------------- synthetic e-mail
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const chart = png(160, 100, (x, y) => (y > 100 - ((x * 7) % 90) && x % 20 < 14 ? [91, 69, 214] : [246, 246, 250]));
const now = Date.now(), ago = (m) => new Date(now - m * 60000).toISOString();
const tracking = 'https://click.mailer.proptechweekly.example/ls/click?upn=u001.Qx7Xj-2BzYhW3k9-2FcV8aLqPZ-2Bq4kD0Hn5aL3dYp-2Fq9w8e7r6t5y4u3i2o1p&_ga=2.17';
const newsletter = sanitizeEmailHtml(`<html><head><style>.hero{font-size:22px;font-weight:700}.btn{background:#5b45d6;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none}</style><script>alert(1)</script></head>
<body><table width="100%" cellpadding="0"><tr><td><img src="https://cdn.proptechweekly.example/logo.png" width="140" alt="PropTech Weekly"></td></tr>
<tr><td class="hero">5 listing videos that sold out a project in a week</td></tr>
<tr><td><p>This week: why vertical walkthroughs beat drone-only edits, and the 9-second hook every developer ad now uses.</p>
<p><img src="https://cdn.proptechweekly.example/hero.jpg" width="520" alt=""></p>
<p>Read the full breakdown: <a href="${tracking}">${tracking}</a></p><p><a class="btn" href="${tracking}">Watch the reels</a></p>
<p style="color:#888;font-size:12px">You get this because you subscribed. <a href="https://click.mailer.proptechweekly.example/unsub?u=abc123def456ghi789jkl012mno345pqr678">https://click.mailer.proptechweekly.example/unsub?u=abc123def456ghi789jkl012mno345pqr678</a></p></td></tr></table></body></html>`);
const reply = sanitizeEmailHtml(`<div>Hi Kabir,</div><div><br></div><div>Monday 7 am works. The security desk will have your names; parking is on B2.</div><div><br></div><div>Thanks,<br>Priya</div>
<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Fri, 9 Oct 2026 at 18:04, Kabir Shah &lt;kabir@agency.example&gt; wrote:</div><blockquote class="gmail_quote"><div>Hi Priya, can we shoot the lobby on Monday at 7 am?</div></blockquote></div>`);
const mail = [
  { id: 'm1', threadId: 't1', from: 'Priya Menon <priya@northstar.example>', fromName: 'Priya Menon', fromEmail: 'priya@northstar.example', subject: 'Re: Site visit on Monday', at: ago(35), snippet: 'Monday 7 am works. The security desk will have your names; parking is on B2.', unread: true, hasAttachment: false, category: 'primary', labels: ['Clients/Northstar'], starred: true, important: true },
  { id: 'm2', threadId: 't2', from: 'Lakeview Homes <marketing@lakeview.example>', fromName: 'Lakeview Homes', fromEmail: 'marketing@lakeview.example', subject: 'Your October campaign report', at: ago(190), snippet: 'Leads are up 18% on September. The full report and the cost per lead chart are attached.', unread: true, hasAttachment: true, category: 'primary', labels: ['Clients/Lakeview'], starred: false, important: false },
  { id: 'm3', threadId: 't3', from: 'Sunrise Realty <ops@sunrise.example>', fromName: 'Sunrise Realty', fromEmail: 'ops@sunrise.example', subject: 'Brochure copy, final round', at: ago(60 * 26), snippet: 'Approved with two small changes on page 3.', unread: false, hasAttachment: false, category: 'primary', labels: [], starred: false, important: false },
  { id: 'm4', threadId: 't4', from: 'PropTech Weekly <news@mailer.proptechweekly.example>', fromName: 'PropTech Weekly', fromEmail: 'news@mailer.proptechweekly.example', subject: '5 listing videos that sold out a project in a week', at: ago(60 * 5), snippet: 'Why vertical walkthroughs beat drone-only edits, and the 9-second hook every developer ad now uses.', unread: true, hasAttachment: false, category: 'promotions', labels: [], starred: false, important: false },
  { id: 'm5', threadId: 't5', from: 'Google Calendar <calendar-notification@google.example>', fromName: 'Google Calendar', fromEmail: 'calendar-notification@google.example', subject: 'Reminder: Sunrise shoot · Mon 7 am', at: ago(60 * 7), snippet: 'Sunrise Towers, call time 6:30 am.', unread: false, hasAttachment: false, category: 'updates', labels: [], starred: false, important: false },
];
const thread = {
  t1: [{ ...mail[0], to: 'kabir@agency.example', cc: 'ahoro@agency.example', body: '', html: reply.html, remoteImages: reply.remoteImages, attachments: [] }],
  t2: [{ ...mail[1], to: 'kabir@agency.example', cc: '', html: null, remoteImages: 0, body: `Hi team,\n\nLeads are up 18% on September, and cost per lead fell to ₹412. The best ad was the 9:16 walkthrough (see https://ads.example.com/campaigns/october/report?utm_source=email&utm_medium=report&utm_campaign=oct-2026-lakeview-villas).\n\nThe full report and the chart are attached.\n\nRegards,\nLakeview marketing\n\nOn Tue, 6 Oct 2026 at 10:00, Kabir Shah <kabir@agency.example> wrote:\n> Could you send the October numbers when ready?\n> Thanks`,
    attachments: [{ name: 'October-report.pdf', mime: 'application/pdf', size: 482113, url: '/api/v0/inbox/attachment?message=m2&id=a1&name=October-report.pdf&mime=application%2Fpdf' }, { name: 'cost-per-lead.png', mime: 'image/png', size: chart.length, url: '/api/v0/inbox/attachment?message=m2&id=a2&name=cost-per-lead.png&mime=image%2Fpng' }] }],
  t4: [{ ...mail[3], to: 'kabir@agency.example', cc: '', body: '', html: newsletter.html, remoteImages: newsletter.remoteImages, attachments: [] }],
};
async function mockMail(ctx) {
  await ctx.route(/\/api\/v0\/inbox(\?|\/attachment)/, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/attachment')) return route.fulfill({ status: 200, contentType: u.searchParams.get('mime') === 'image/png' ? 'image/png' : 'application/pdf', body: u.searchParams.get('mime') === 'image/png' ? chart : Buffer.from('%PDF-1.4 synthetic') });
    const t = u.searchParams.get('thread');
    const base = { sendEnabled: false, account: 'kabir@agency.example', labels: ['Clients/Lakeview', 'Clients/Northstar'] };
    if (t) return route.fulfill({ json: { ...base, rows: [], thread: thread[t] ?? [{ ...mail.find((m) => m.threadId === t), to: 'kabir@agency.example', cc: '', body: 'Approved with two small changes on page 3.\n\nThanks', html: null, remoteImages: 0, attachments: [] }] } });
    const q = u.searchParams.get('q'), cat = u.searchParams.get('category') ?? 'primary';
    const list = mail.filter((m) => (q ? `${m.subject} ${m.snippet} ${m.fromName}`.toLowerCase().includes(q.toLowerCase()) : u.searchParams.get('starred') ? m.starred : m.category === cat) && (u.searchParams.get('unread') ? m.unread : true));
    return route.fulfill({ json: { ...base, rows: list, nextCursor: null } });
  });
}

try {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/login')).ok) break; } catch { /* starting */ } await delay(250); if (i === 199) throw Error('Chats browser web did not start'); }
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const phone = width < 500;
    const ctx = {}; for (const role of Object.keys(emails)) ctx[role] = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
    await mockMail(ctx.member);
    const k = await ctx.member.newPage(); const errors = []; k.on('pageerror', (e) => errors.push(e.message));
    // 1. The list: pinned first, unread badges, a mention, labelled groups, channels at the bottom.
    await go(k, '/chats'); await seen(rows(k));
    check((await rows(k).first().innerText()).includes('Sunrise shoot crew'), 'the pinned group is first');
    await seen(row(k, 'Meera Iyer').getByLabel('2 unread'));
    await seen(row(k, 'Pod 1').getByLabel('1 mention'));
    await seen(row(k, 'Creative').getByText('Department'));
    await k.getByRole('tab', { name: /Unread/ }).click();
    check((await rows(k).count()) === 2, 'Unread shows the two conversations with something new');
    await k.getByRole('button', { name: 'More filters' }).click(); await k.getByRole('menuitem', { name: 'People' }).click(); check(await row(k, 'Ahoro Rao').count() === 1 && await row(k, 'Pod 1').count() === 0, 'People shows direct chats only');
    await k.getByRole('tab', { name: 'All' }).click();
    check(await fits(k), `chat list fits at ${width}`);
    // 2. A conversation: the quote, the frame, the reaction, the live task card, its update line and read ticks.
    await row(k, 'Ahoro Rao').click();
    await seen(log(k).getByText('Looks great. Warm it up a touch on the windows?'));
    await seen(log(k).locator('img[alt="lobby-first-look.png"]'));
    await seen(log(k).getByRole('link', { name: 'Colour grade the teaser' }));
    await seen(log(k).getByText(/moved “Colour grade the teaser” to In progress/));
    await seen(log(k).getByLabel('Read', { exact: true }));
    await seen(k.getByText('📅 Client review till 4'));
    if (phone) check(!(await k.locator('aside[aria-label="Chats"]').isVisible()), 'on a phone the chat is full screen');
    // 3. An optimistic send: the bubble is on screen before the server answers, then settles with a tick.
    const box = k.getByRole('textbox', { name: 'Message Ahoro Rao' });
    const outgoing = `Sending the 30-second cut tonight (${width})`;
    await box.fill(outgoing);
    // Measure keydown -> visible DOM in Chromium, excluding Playwright command transport/polling. Hold the
    // request until the assertion passes: a fast server reply cannot masquerade as an optimistic bubble.
    await box.evaluate((el, text) => {
      const state = el.__sendProbe = { started: null, shown: null };
      el.addEventListener('keydown', () => { state.started = performance.now(); }, { once: true, capture: true });
      const observer = new MutationObserver(() => {
        const p = [...document.querySelectorAll('[role="log"] article p')].find((p) => p.textContent === text);
        if (state.started !== null && p && p.getBoundingClientRect().height > 0 && getComputedStyle(p).visibility !== 'hidden') {
          state.shown = performance.now() - state.started; observer.disconnect();
        }
      });
      observer.observe(document.querySelector('[role="log"]'), { childList: true, subtree: true, characterData: true });
      state.observer = observer;
    }, outgoing);
    let releaseSend, sendAttempts = 0;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const sendPath = /\/api\/v0\/chats\/[^/]+\/messages$/;
    const holdSend = async (route) => {
      if (route.request().method() === 'POST') { sendAttempts++; await sendGate; }
      await route.continue();
    };
    await k.route(sendPath, holdSend);
    try {
      await box.press('Enter');
      await seen(log(k).getByText(outgoing), 3000);
      const shown = await box.evaluate((el) => el.__sendProbe.shown);
      check(Number.isFinite(shown) && shown < 1500, `the bubble shows at once (${shown} ms)`);
      await expect.poll(() => sendAttempts).toBe(1); browserChecks++;
    } finally {
      // Drain the paused handler before removing interception, so Playwright cannot resume its route twice.
      releaseSend(); await k.unrouteAll({ behavior: 'wait' });
      await box.evaluate((el) => { el.__sendProbe.observer.disconnect(); delete el.__sendProbe; });
    }
    await seen(log(k).locator('article').filter({ hasText: `cut tonight (${width})` }).locator('[aria-label="Sent"], [aria-label="Delivered"], [aria-label="Read"]'));
    if (!phone) {
      // 4. Reply with a quote, react, edit within the window, delete for everyone.
      await (await hoverMessage(k, 'client wants a 30-second cut')).getByRole('button', { name: 'Reply', exact: true }).click();
      await seen(k.getByText('Replying to Ahoro Rao'));
      await box.fill('Will do, Friday it is'); await box.press('Enter');
      await seen(log(k).locator('article').filter({ hasText: 'Will do, Friday it is' }).locator('button').filter({ hasText: 'client wants a 30-second cut' }));
      await (await hoverMessage(k, 'Will do, Friday it is')).getByRole('button', { name: 'React', exact: true }).click(); await k.getByRole('button', { name: 'React 😂' }).click();
      await seen(log(k).locator('article').filter({ hasText: 'Will do, Friday it is' }).getByRole('button', { name: /😂 1/ }));
      await (await hoverMessage(k, 'Will do, Friday it is')).getByRole('button', { name: 'More actions' }).click(); await k.getByRole('menuitem', { name: 'Edit' }).click();
      await seen(k.getByText('Editing', { exact: true }));
      const edit = k.getByRole('textbox', { name: 'Edit your message' }); await edit.fill('Will do, Friday morning it is'); await edit.press('Enter');
      await seen(log(k).locator('article').filter({ hasText: 'Friday morning it is' }).getByText('edited'));
      await (await hoverMessage(k, `cut tonight (${width})`)).getByRole('button', { name: 'More actions' }).click(); await k.getByRole('menuitem', { name: 'Delete for everyone' }).click();
      await k.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await seen(log(k).getByText('This message was deleted'));
      // 5. Make a task from a message: the assignee is the author, the message is quoted, updates can follow.
      await (await hoverMessage(k, 'Warm it up a touch')).getByRole('button', { name: 'More actions' }).click(); await k.getByRole('menuitem', { name: 'Make a task' }).click();
      const dialog = k.getByRole('dialog', { name: 'New task' }); await seen(dialog);
      check((await dialog.getByRole('textbox', { name: 'What needs doing' }).innerText()).startsWith('Looks great. Warm it up'), 'the title comes from the message');
      await seen(dialog.getByText('From Ahoro in your chat'));
      check((await dialog.getByRole('button', { name: /^Who does it:/ }).innerText()).includes('Ahoro'), 'the assignee is the person who wrote it');
      await dialog.getByRole('textbox', { name: 'What needs doing' }).fill('Warm up the window highlights');
      await dialog.getByLabel(/Post this task’s updates in the chat/).check();
      const made = k.waitForResponse((r) => r.url().endsWith('/api/v0/work/tasks') && r.request().method() === 'POST');
      await dialog.locator('footer button').click(); check((await made).ok(), 'the task is created from the chat');
      await seen(log(k).getByRole('link', { name: 'Warm up the window highlights' }));
      await seen(log(k).locator('article').filter({ hasText: 'Warm up the window highlights' }).getByRole('button', { name: 'Updates post here' }));
      // 6. # finds a task and sends a live card; /task opens Make a task.
      await box.fill('Permit status: #Drone');
      await seen(k.getByRole('listbox', { name: 'Tasks' }).getByText('Drone permit for Sunrise'));
      await box.press('Enter'); await seen(k.getByText('Task: Drone permit for Sunrise'));
      await box.press('Enter'); await seen(log(k).locator('article').filter({ hasText: 'Permit status' }).getByRole('link', { name: 'Drone permit for Sunrise' }));
      await box.fill('/ta'); await seen(k.getByRole('listbox', { name: 'Commands' }));
      await box.fill('/task Book the drone pilot'); await box.press('Enter');
      // UX-SIMPLE (efb05d35): /task shows its card above the box first; nothing is made until Confirm, and More details
      // opens Make a task with the title carried over.
      const card = k.locator('[data-command-card]').filter({ hasText: 'New task' }); await seen(card);
      check((await card.locator('dd').first().innerText()).trim() === 'Book the drone pilot', '/task card carries the title');
      await card.getByRole('button', { name: 'More details' }).click();
      const slash = k.getByRole('dialog', { name: 'New task' }).filter({ has: k.getByRole('textbox', { name: 'What needs doing' }) }); await seen(slash);
      check((await slash.getByRole('textbox', { name: 'What needs doing' }).innerText()).trim() === 'Book the drone pilot', '/task carries the title');
      await k.keyboard.press('Escape');
      // 7. Search across conversations.
      await k.getByRole('textbox', { name: 'Search chats and people' }).fill('drone'); await k.getByRole('button', { name: /Search messages for/ }).click();
      await seen(k.getByRole('region', { name: 'Messages' })); await k.getByRole('button', { name: 'Clear search' }).click();
    }
    // 8. Group info: members by department with presence, admin controls only for the group's admin. CHAT-SHELL v2
    // (4534be04): the header's name opens the details ("<name>: details and members"); the Details button is gone.
    await go(k, `/chats?channel=${E.crew}`); await k.getByRole('button', { name: /: details and members$/ }).click();
    const info = k.getByRole('complementary', { name: 'Group info' }); await seen(info.getByText('Production'));
    await seen(info.getByRole('img', { name: 'On a shoot' }));
    check(await info.getByRole('button', { name: 'Add people' }).count() === 0, 'a member does not get admin controls');
    const h = await ctx.head.newPage(); await go(h, `/chats?channel=${E.crew}`); await h.getByRole('button', { name: /: details and members$/ }).click();
    await seen(h.getByRole('complementary', { name: 'Group info' }).getByRole('button', { name: 'Add people' }));
    // 9. New chat in one button; a new group with members and a name.
    await go(k, '/chats'); await k.getByRole('button', { name: 'New chat' }).first().click();
    await k.getByRole('textbox', { name: 'Search people' }).fill('ish'); await seen(k.getByText('Performance · Pod 2'));
    await k.getByRole('button', { name: /Ishaan Vivim/ }).click(); await seen(log(k).getByText('Say hello to Ishaan'));
    if (!phone) {
      await go(k, '/chats'); await k.getByRole('button', { name: 'More', exact: true }).click(); await k.getByRole('menuitem', { name: 'New group' }).click();
      for (const name of ['Dev Panab', 'Sana Khan']) await k.getByRole('button', { name: new RegExp(name) }).click();
      await k.getByRole('button', { name: 'Next' }).click(); await k.getByPlaceholder('e.g. Launch crew').fill('Teaser review');
      await k.getByRole('button', { name: 'Create group' }).click();
      await seen(log(k).getByText('created the group “Teaser review”'));
      await seen(row(k, 'Teaser review').getByText('Group'));
      // 10. Your status and do-not-disturb.
      await k.getByRole('button', { name: 'Set your status' }).click(); const status = k.getByRole('dialog', { name: 'Your status' });
      await status.getByRole('button', { name: /Focusing/ }).click(); await status.getByRole('radio', { name: '1 hour' }).last().click(); await status.getByRole('button', { name: 'Save' }).click();
      await seen(k.getByRole('button', { name: /Do not disturb/ }));
      await k.getByRole('button', { name: /Do not disturb/ }).click(); await k.getByRole('dialog', { name: 'Your status' }).getByRole('button', { name: 'Clear status' }).click();
    } else {
      // On a phone: list, chat full screen, back.
      await go(k, '/chats'); await row(k, 'Meera Iyer').click(); await seen(log(k).getByText('Need it for the ads team by 3.'));
      await k.getByRole('button', { name: 'Back to chats' }).click(); await seen(row(k, 'Pod 1'));
    }
    // 11. E-mail: tabs, a sanitised newsletter with images on request and tracking links as domains, a plain-text mail
    //     with its quote folded, attachments, Make a task, and the send scope explained.
    await go(k, '/chats?source=email'); await seen(k.locator('[data-chat-row]').filter({ hasText: 'Priya Menon' }));
    await k.getByRole('tab', { name: 'Promotions' }).click(); await k.locator('[data-chat-row]').filter({ hasText: 'PropTech Weekly' }).click();
    const frame = k.frameLocator('iframe[title="E-mail message"]');
    await seen(frame.getByText('5 listing videos that sold out a project in a week'));
    await seen(frame.getByRole('link', { name: 'mailer.proptechweekly.example' }));
    check(!(await frame.locator('script').count()), 'no script reaches the mail frame');
    await seen(k.getByText(/2 images from the sender are hidden/)); await k.getByRole('button', { name: 'Show images' }).click();
    check(await k.getByText(/images from the sender are hidden/).count() === 0, 'images load only on request');
    if (phone) await k.getByRole('button', { name: 'Back to email' }).click();
    await k.getByRole('tab', { name: 'Primary' }).click(); await k.locator('[data-chat-row]').filter({ hasText: 'Lakeview Homes' }).click();
    await seen(k.getByRole('link', { name: /ads\.example\.com/ })); await seen(k.locator('details summary').filter({ hasText: '•••' }));
    await seen(k.getByRole('link', { name: /October-report\.pdf/ }));
    await k.getByRole('button', { name: 'Make a task' }).click(); const mailTask = k.getByRole('dialog', { name: 'New task' });
    check((await mailTask.getByRole('textbox', { name: 'What needs doing' }).innerText()).trim() === 'Your October campaign report', 'a task from an e-mail takes its subject');
    await k.keyboard.press('Escape');
    if (!phone) { await k.getByRole('button', { name: /Compose/ }).click(); await seen(k.getByText('Sending from Pulse isn’t switched on yet')); }
    // 12. Telegram and WhatsApp Business in the same list; presence on People, HR's roster and the team dashboard.
    await go(k, '/chats?source=whatsapp'); await seen(k.getByRole('region', { name: 'Conversation' }).getByText('Pending approval'));
    const a = await ctx.admin.newPage(); await go(a, '/people'); await seen(a.getByRole('img', { name: 'On a shoot' }));
    const hr = await ctx.hr.newPage(); await go(hr, '/hr'); await seen(hr.getByRole('img', { name: /In the office|On a break/ }));
    check(!errors.length, `no page errors: ${errors.join(' | ')}`);
    for (const c of Object.values(ctx)) await c.close();
  }
  if (shots) {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const phone = width < 500;
      const make = async (role) => { const c = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, extraHTTPHeaders: { 'cf-access-authenticated-user-email': emails[role] } });
        await c.addInitScript((t) => { try { localStorage.setItem('pulse.theme', t); localStorage.setItem('theme', t); } catch { /* private mode */ } }, theme); return c; };
      const member = await make('member'), admin = await make('admin'), hrc = await make('hr'); await mockMail(member);
      const p = await member.newPage(), ap = await admin.newPage(), hp = await hrc.newPage();
      const shot = async (pg, name) => { await pg.waitForTimeout(350); await pg.screenshot({ path: `${shots}/${name}-${width}-${theme}.png` }); };
      await go(p, '/chats'); await shot(p, '01-chat-list');
      await go(p, `/chats?channel=${E.ahoroDm}`); await shot(p, '02-conversation');
      const target = message(p, 'Warm it up a touch');
      if (phone) await target.dispatchEvent('contextmenu'); else { await target.hover(); await target.getByRole('button', { name: 'More actions' }).click(); }
      await shot(p, '03-message-actions');
      await (phone ? p.getByRole('dialog', { name: 'Message actions' }).getByRole('button', { name: 'Make a task' }) : p.getByRole('menuitem', { name: 'Make a task' })).click();
      await p.getByRole('dialog', { name: 'New task' }).waitFor(); await shot(p, '04-make-a-task'); await p.keyboard.press('Escape');
      await go(p, `/chats?channel=${E.ahoroDm}`); const box = p.getByRole('textbox', { name: 'Message Ahoro Rao' }); await box.fill('Permit status: #Dro'); await p.getByRole('listbox', { name: 'Tasks' }).waitFor(); await shot(p, '05-task-mention');
      await box.fill('');
      await go(p, `/chats?channel=${E.pod1}`); await shot(p, '06-pod-with-mention');
      await go(p, `/chats?channel=${E.crew}`); await p.getByRole('button', { name: /: details and members$/ }).click(); await p.getByRole('complementary', { name: 'Group info' }).getByText('Production').waitFor(); await shot(p, '07-group-info');
      await go(p, '/chats'); await p.getByRole('button', { name: 'New chat' }).first().click(); await shot(p, '08-new-chat');
      await p.getByRole('button', { name: /New group/ }).first().click(); for (const name of ['Dev Panab', 'Sana Khan']) await p.getByRole('button', { name: new RegExp(name) }).click(); await shot(p, '09-new-group-members');
      await p.getByRole('button', { name: 'Next' }).click(); await p.getByPlaceholder('e.g. Launch crew').fill('Teaser review'); await shot(p, '10-new-group-name');
      await go(p, '/chats'); await p.getByRole('button', { name: 'Set your status' }).click(); await shot(p, '11-your-status'); await p.keyboard.press('Escape');
      await go(p, '/chats?source=email'); await p.locator('[data-chat-row]').first().waitFor(); await shot(p, '12-email-inbox');
      await p.getByRole('tab', { name: 'Promotions' }).click(); await p.locator('[data-chat-row]').filter({ hasText: 'PropTech Weekly' }).click();
      await p.frameLocator('iframe[title="E-mail message"]').getByText('5 listing videos').waitFor(); await shot(p, '13-email-newsletter-images-hidden');
      if (phone) await p.getByRole('button', { name: 'Back to email' }).click();
      await p.getByRole('tab', { name: 'Primary' }).click(); await p.locator('[data-chat-row]').filter({ hasText: 'Lakeview Homes' }).click(); await p.getByRole('link', { name: /October-report/ }).waitFor(); await shot(p, '14-email-report-quote-attachments');
      if (!phone) { await p.getByRole('button', { name: /Compose/ }).click(); await shot(p, '15-email-compose-pending'); }
      await go(p, '/chats?source=whatsapp'); await shot(p, '16-whatsapp-pending');
      await go(ap, '/people'); await shot(ap, '17-people-presence');
      await go(hp, '/hr'); await shot(hp, '18-hr-who-is-in');
      await go(ap, '/tasks?view=team'); await shot(ap, '19-team-dashboard-presence');
      for (const c of [member, admin, hrc]) await c.close();
    }
  }
  const receipt = JSON.stringify({ browserChecks });
  await writeFile(process.env.PULSE_CHATS_REPORT, receipt); console.log(receipt);
} catch (e) {
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) { console.error('PAGE', p.url().replace(base, ''), (await p.locator('main').innerText().catch(() => '')).slice(0, 900)); if (shots) await p.screenshot({ path: `${shots}/failure-${Date.now()}.png` }).catch(() => {}); }
  throw e;
} finally { await browser?.close(); server.kill(); await app.close(); await pool.end(); }
