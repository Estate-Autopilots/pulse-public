// CHAT-SHELL journeys (TOP-JOURNEYS J1, J2, J3, J5, J12: the shell's parts) in a real browser on a running Pulse
// (pulse-dev by default), at 1440 px (desktop, the priority) and 390 px (phone), light and dark. Nothing is sent to
// anyone: messages are typed but never sent, and a nudge stops at the filled-in message box. One video per journey
// and size and theme, plus a screenshot at its end, in PULSE_JOURNEY_DIR.
//   PULSE_BASE=http://127.0.0.1:3200 PULSE_AS=user-668d21b6@estateautopilots.com PULSE_JOURNEY_DIR=~/ea-research/ux/journeys/chat-shell \
//   PLAYWRIGHT=<path to playwright/index.js> node services/api/test/chat-shell-journeys.mjs [J1,J2,...] [1440,390] [light,dark]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.env.PULSE_BASE ?? 'http://127.0.0.1:3200', as = process.env.PULSE_AS ?? 'user-668d21b6@estateautopilots.com';
const dir = process.env.PULSE_JOURNEY_DIR ?? join(tmpdir(), 'chat-shell'); await mkdir(dir, { recursive: true });
const [onlyJ, onlyW, onlyT] = process.argv.slice(2).map((a) => a?.split(','));
const headers = { 'cf-access-authenticated-user-email': as };
const api = async (path) => { const r = await fetch(`${base}/api/v0/${path}`, { headers }); return r.ok ? r.json() : {}; };

// A work project to talk about, and one that is late or blocked (the leader's glance).
const projects = (await api('work/projects')).rows ?? [];
const project = projects.find((p) => p.name && p.name.split(' ').length >= 2 && !/[()]/.test(p.name)) ?? projects[0];
assert.ok(project, 'a work project exists on this Pulse');

const panel = (page) => page.locator('aside[aria-label="Side panel"]');
const framed = (page) => page.frameLocator('aside[aria-label="Side panel"] section:not([hidden]) iframe');
async function home(page) {
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForURL(/\/chats/, { timeout: 60000 });
  await page.getByRole('textbox', { name: /Message someone, or ask for a place/ }).waitFor({ timeout: 90000 });
  await page.waitForTimeout(600);
}
async function chats(page) {
  await page.goto(`${base}/chats`, { waitUntil: 'load', timeout: 180000 });
  await page.locator('[data-chat-row]').first().waitFor({ timeout: 90000 });
}
async function openFirstChat(page) {
  await page.locator('[data-chat-row]').first().click();
  await page.locator('[data-chat-composer] textarea').waitFor({ timeout: 30000 });
}
async function composerCommand(page, line) {
  const box = page.locator('[data-chat-composer] textarea');
  await box.click(); await box.fill(line); await page.waitForTimeout(300);
  // Esc closes the command list; Send runs the command (on a phone Enter is a new line).
  await box.press('Escape'); // (a JS click: on a phone the floating Pip can sit over Send; reported to FLOAT / DEVICE-QA)
  await page.locator('[data-chat-composer] button[aria-label="Send"]').evaluate((b) => b.click());
}

const JOURNEYS = {
  // J1 Start the day: Pulse opens on the chat home; Needs you lists my tasks (and steps, mentions); one opens beside the chat.
  J1: { desktop: async (page, step) => {
    await home(page); step('opens on the chat home');
    const needs = page.locator('section[aria-label="Needs you"]'); await needs.waitFor();
    await page.waitForFunction(() => !document.querySelector('section[aria-label="Needs you"] [class*="needSk"]'), null, { timeout: 60000 });
    step('Needs you is filled in');
    const task = needs.locator('section[aria-label="Tasks given to you"] button[class*="needMain"]').first();
    if (await task.count()) {
      const title = (await task.locator('b').innerText()).trim();
      await task.click(); await panel(page).waitFor();
      await framed(page).locator('main').first().waitFor({ timeout: 90000 });
      step(`a task opens beside the chat: ${title.slice(0, 40)}`);
      assert.ok(await needs.locator('button[aria-label^="Mark"]').count(), 'each task has its one-tap Done');
      step('Done is one tap on each task (with Undo); not pressed here, so nobody is told');
    } else step('no task waits for this person (the clear state shows)');
  }, phone: async (page, step) => {
    await chats(page); step('Chats on the phone');
    await openFirstChat(page); step('a conversation opens full screen');
    await composerCommand(page, '/open my steps');
    await panel(page).waitFor({ timeout: 30000 }); await framed(page).locator('main').first().waitFor({ timeout: 90000 });
    step('/open my steps opens My steps in the sheet');
  } },
  // J2 (shell part): the project a line names opens in the panel and Pip points at where to add the tasks.
  J2: { desktop: async (page, step) => {
    await home(page);
    const box = page.getByRole('textbox', { name: /Message someone, or ask for a place/ });
    await box.fill(`add tasks to the ${project.name} project`); await page.waitForTimeout(500);
    await page.locator('[role="listbox"][aria-label="What this does"] [role="option"]').first().waitFor();
    step(`the box names the project “${project.name}”`);
    await box.press('Enter');
    await panel(page).waitFor(); await framed(page).getByRole('button', { name: /Add task/ }).first().waitFor({ timeout: 90000 });
    step('the project opens beside the chat');
    await panel(page).locator('[role="note"]').waitFor({ timeout: 30000 });
    step('Pip points at Add task');
  }, phone: async (page, step) => {
    await chats(page); await openFirstChat(page);
    await composerCommand(page, `/open ${project.name}`);
    await panel(page).waitFor({ timeout: 30000 }); await framed(page).locator('main').first().waitFor({ timeout: 90000 });
    step(`/open ${project.name} opens the project in the sheet`);
  } },
  // J3 (shell part): a tab from the panel (or a Drive link) dropped on a conversation is attached to the message.
  J3: { desktop: async (page, step) => {
    await chats(page); await openFirstChat(page);
    await page.locator('[data-panel-toggle]').first().click(); await panel(page).waitFor();
    step('the side panel opens with its launcher');
    await page.evaluate(() => {
      const dt = new DataTransfer(); const url = 'https://drive.google.com/file/d/1JourneyBrochureFile/view';
      dt.setData('application/x-pulse-ref', JSON.stringify({ name: 'Brochure (Drive)', url })); dt.setData('text/uri-list', url);
      const chat = document.querySelector('[data-chat-composer]').parentElement;
      for (const type of ['dragenter', 'dragover', 'drop']) chat.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.locator('[data-chat-composer]').getByText('Brochure (Drive)').waitFor({ timeout: 10000 });
    step('the dropped Drive file waits in the message box as an attachment (not sent)');
    await page.locator('[data-chat-composer] button[aria-label="Remove Brochure (Drive)"]').click();
  } },
  // J5 (shell part): a project opens beside the chat; its own Add task works inside the panel.
  J5: { desktop: async (page, step) => {
    await chats(page); await openFirstChat(page);
    await composerCommand(page, `/open ${project.name}`);
    await panel(page).waitFor(); const add = framed(page).getByRole('button', { name: /Add task/ }).first(); await add.waitFor({ timeout: 90000 });
    step('the project opens beside the conversation');
    await add.click(); await framed(page).getByRole('dialog').first().waitFor({ timeout: 20000 });
    step('Add task opens its form inside the panel');
    await framed(page).locator('body').press('Escape');
  }, phone: async (page, step) => {
    await chats(page); await openFirstChat(page);
    await composerCommand(page, `/open ${project.name}`);
    await panel(page).waitFor({ timeout: 30000 }); await framed(page).getByRole('button', { name: /Add task/ }).first().waitFor({ timeout: 90000 });
    step('the project opens in the sheet with Add task');
  } },
  // J12 (shell part): a leader sees what is late or blocked and nudges the owner in one tap (the message is filled in, not sent).
  J12: { desktop: async (page, step) => {
    await home(page);
    const late = page.locator('section[aria-label="Projects late or blocked"]');
    await late.waitFor({ timeout: 60000 }); await page.waitForFunction(() => !document.querySelector('section[aria-label="Projects late or blocked"] [class*="needSk"]'), null, { timeout: 60000 });
    step('Late or blocked lists the projects');
    const nudge = late.getByRole('button', { name: 'Nudge' }).first();
    if (await nudge.count()) {
      await nudge.click(); const box = page.locator('[data-chat-composer] textarea'); await box.waitFor({ timeout: 30000 });
      await page.waitForFunction(() => /take a look/.test(document.querySelector('[data-chat-composer] textarea')?.value ?? ''), null, { timeout: 15000 });
      step('Nudge opens the owner’s chat with the message written (not sent)');
      await box.fill('');
    } else step('no late project has an owner to nudge');
  } },
};

const results = [];
const browser = await chromium.launch();
for (const [id, j] of Object.entries(JOURNEYS)) {
  if (onlyJ && !onlyJ.includes(id)) continue;
  for (const width of [1440, 390]) {
    if (onlyW && !onlyW.includes(String(width))) continue;
    const run = width === 390 ? j.phone : j.desktop; if (!run) { results.push(`${id} ${width}: desktop only (the phone opens on the dashboard and has no drag)`); continue; }
    for (const theme of ['light', 'dark']) {
      if (onlyT && !onlyT.includes(theme)) continue;
      const name = `${id}-${width}-${theme}`, tmp = join(dir, `tmp-${name}`); await rm(tmp, { recursive: true, force: true });
      const phone = width === 390, size = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
      const ctx = await browser.newContext({ viewport: size, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1, extraHTTPHeaders: headers, recordVideo: { dir: tmp, size } });
      const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
      const steps = []; const step = (s) => { steps.push(s); console.log(`  ✓ ${name}: ${s}`); };
      let ok = true;
      try { await run(page, step); await page.waitForTimeout(800); await page.screenshot({ path: join(dir, `${name}.png`) }); }
      catch (e) { ok = false; steps.push(`FAILED: ${e.message.split('\n')[0].slice(0, 200)}`); await page.screenshot({ path: join(dir, `${name}-failed.png`) }).catch(() => {}); }
      await ctx.close();
      const video = (await readdir(tmp).catch(() => [])).find((f) => f.endsWith('.webm'));
      if (video) await rename(join(tmp, video), join(dir, `${name}.webm`)); await rm(tmp, { recursive: true, force: true });
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${steps.join(' → ')}${errors.length ? ` (page errors: ${errors.join(' | ')})` : ''}`);
      console.log(results.at(-1));
    }
  }
}
await browser.close();
await writeFile(join(dir, 'results.txt'), `${new Date().toISOString()} ${base} as ${as}\n${results.join('\n')}\n`);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
