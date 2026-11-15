// DOCS-DRIVE (owner, 8 Nov 2026: "make the UX like how we handle Drive … much nicer for folders, folders under folders,
// documents and so on"): the Drive-style Docs end to end on a disposable synthetic company (tests/core/test_docs_drive_walk.py).
// Always (the API): nested folders, a move that would open a private folder's doc to everyone is asked about first and
// made only with allowWider, a folder never goes inside itself, bulk tag / archive / restore try each item on its own
// (a colleague's refused item never stops theirs), stars are your own, and the details panel answers only for docs you see.
// With PULSE_AUTH_BROWSER=1 a confused office user's walk in a real browser at 1920 (light) and 363 (dark): My Docs, the
// tree, a folder, New folder in place, rename in place, list view and sorting, picking two docs and the bulk bar, the
// details panel, search with highlights, the drawer on a phone, no sideways scroll. Screenshots go to DOCS_DRIVE_SHOTS.
// Nothing leaves this machine; every name is synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';

const pool = new pg.Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool), ADMIN = process.env.TEST_ADMIN_EMAIL, MEMBER = process.env.TEST_MEMBER_EMAIL;
const shots = process.env.DOCS_DRIVE_SHOTS || join(tmpdir(), 'docs-drive-shots');
const WEB_DIR = process.env.DOCS_DRIVE_WEB || '../../apps/web', BEFORE = process.env.DOCS_DRIVE_BEFORE === '1';
let apiChecks = 0, browserChecks = 0;

const as = (who) => ({ 'cf-access-authenticated-user-email': who });
const call = async (path, who, method = 'GET', body, expected = 200) => {
  apiChecks++;
  const r = await app.inject({ url: '/api/v0/' + path, method, headers: as(who), ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r.json();
};
const folder = async (who, name, parentId = null, extra = {}) => (await call('docs/folders', who, 'POST', { name, parentId, ...extra })).id;
const doc = async (who, title, folderId, extra = {}) => (await call('docs', who, 'POST', { title, folderId, access: 'company', markdown: `# ${title}\n\nSynthetic words about the offer, the price band and the next step.`, ...extra })).doc.id;

let browser, web;
try {
  // ---- API --------------------------------------------------------------------------------------------------------
  const company = await folder(ADMIN, 'Company (synthetic)');
  const offer = await folder(ADMIN, 'Offer', company);
  const stage1 = await folder(ADMIN, 'Stage 1', offer);
  await folder(ADMIN, 'Stage 2', offer);
  const sops = await folder(ADMIN, 'SOPs');
  const legal = await folder(ADMIN, 'Legal', null, { access: 'people', people: [] });
  const pricing = await doc(ADMIN, 'Pricing notes', offer, { tags: ['offer', 'sales'], category: 'Offer' });
  const call1 = await doc(ADMIN, 'Discovery call', offer, { template: 'meeting', markdown: undefined, title: 'Discovery call' });
  await doc(ADMIN, 'Client onboarding', sops, { template: 'sop', markdown: undefined, title: 'Client onboarding' });
  const lease = await doc(ADMIN, 'Lease draft', legal, { category: 'Legal' });
  const mine = await doc(MEMBER, 'My offer ideas', offer, { tags: ['idea'] });
  // A template brings its type.
  assert.equal((await call(`docs/${call1}/details`, ADMIN)).doc.category, 'Meeting notes');
  // Folders under folders: the page lists Offer's folders and docs.
  const inOffer = await call(`docs?folder=${offer}`, ADMIN);
  assert.ok(inOffer.folders.some((f) => f.id === stage1 && f.parentId === offer), 'Stage 1 sits in Offer');
  assert.deepEqual(new Set(inOffer.docs.map((d) => d.id)), new Set([pricing, call1, mine]));
  // Leaving a private folder is asked about first; nothing moves until allowWider.
  const ask = await call('docs/move', ADMIN, 'POST', { items: [{ kind: 'doc', id: lease }], to: company });
  assert.ok(ask.needsConfirm && /Legal/.test(ask.needsConfirm.message) && /everyone in the company/.test(ask.needsConfirm.message), JSON.stringify(ask));
  assert.equal(ask.moved.length, 0);
  assert.equal((await call(`docs/${lease}/details`, ADMIN)).doc.folderId, legal, 'still in Legal');
  await call(`docs/${lease}/details`, MEMBER, 'GET', undefined, 404);
  const moved = await call('docs/move', ADMIN, 'POST', { items: [{ kind: 'doc', id: lease }], to: company, allowWider: true });
  assert.deepEqual(moved.moved, [{ kind: 'doc', id: lease }]);
  assert.equal((await call(`docs/${lease}/details`, MEMBER)).doc.title, 'Lease draft', 'everyone sees it now, as the question said');
  // Into a private folder: fewer people see it, so no question; then it is hidden from the member again.
  const back = await call('docs/move', ADMIN, 'POST', { items: [{ kind: 'doc', id: lease }], to: legal });
  assert.equal(back.needsConfirm, null); assert.equal(back.to.private, true);
  await call(`docs/${lease}/details`, MEMBER, 'GET', undefined, 404);
  // A folder never goes inside itself; another folder moves with everything in it.
  const loop = await call('docs/move', ADMIN, 'POST', { items: [{ kind: 'folder', id: company }], to: stage1 });
  assert.equal(loop.moved.length, 0); assert.match(loop.failed[0].why, /inside itself/);
  const nest = await call('docs/move', ADMIN, 'POST', { folderIds: [sops], to: company });
  assert.deepEqual(nest.moved, [{ kind: 'folder', id: sops }]);
  // The member cannot move the admin's folder (folders are changed by their maker, leadership and admins).
  const refused = await call('docs/move', MEMBER, 'POST', { items: [{ kind: 'folder', id: stage1 }, { kind: 'doc', id: mine }], to: sops });
  assert.deepEqual(refused.moved, [{ kind: 'doc', id: mine }], 'their own doc moves'); assert.equal(refused.failed.length, 1, 'the folder is refused, not the whole move');
  // Bulk: tags on many docs; archive tries each (the member archives only their own), Restore brings them back.
  const tagged = await call('docs/bulk', ADMIN, 'POST', { docIds: [pricing, call1], action: 'addTags', tags: ['stage 2'] });
  assert.equal(tagged.done.length, 2);
  assert.ok((await call('docs?tag=stage%202', MEMBER)).docs.some((d) => d.id === pricing), 'the tag finds them');
  const arch = await call('docs/bulk', MEMBER, 'POST', { docIds: [mine, pricing], action: 'archive' });
  assert.deepEqual(arch.done, [{ kind: 'doc', id: mine }]); assert.match(arch.failed[0].why, /owner/);
  assert.ok((await call('docs?archived=1', MEMBER)).docs.some((d) => d.id === mine));
  assert.equal((await call('docs/bulk', MEMBER, 'POST', { docIds: [mine], action: 'restore' })).done.length, 1);
  // Share with a chosen person who may only view: they read it, and cannot comment.
  const memberId = (await call('docs?folder=root', MEMBER)).me;
  const priv = await doc(ADMIN, 'Board notes', null, { access: 'private' });
  await call(`docs/${priv}/details`, MEMBER, 'GET', undefined, 404);
  const shared = await call('docs/bulk', ADMIN, 'POST', { docIds: [priv], action: 'share', people: [{ personId: memberId, role: 'view' }] });
  assert.equal(shared.done.length, 1);
  const seen = await call(`docs/${priv}/details`, MEMBER);
  assert.equal(seen.doc.canEdit, false);
  await call(`docs/${priv}/comments`, MEMBER, 'POST', { body: 'Synthetic comment' }, 403);
  assert.ok((await call('docs?view=shared', MEMBER)).docs.some((d) => d.id === priv), 'Shared with me lists it');
  // Stars and Recent are your own.
  await call('docs/star', MEMBER, 'POST', { kind: 'doc', id: pricing, on: true });
  await call('docs/star', MEMBER, 'POST', { kind: 'folder', id: offer, on: true });
  assert.deepEqual((await call('docs?view=starred', MEMBER)).docs.map((d) => d.id), [pricing]);
  assert.deepEqual((await call('docs?view=starred', ADMIN)).docs, [], 'the admin does not see the member\'s stars');
  await call(`docs/${call1}`, MEMBER);
  assert.equal((await call('docs?view=recent', MEMBER)).docs[0]?.id, call1, 'the doc just opened is first in Recent');
  // Search with filters: type, and anywhere under a folder.
  const found = await call(`docs?q=price&category=Offer&folder=${company}`, MEMBER);
  assert.deepEqual(found.docs.map((d) => d.id), [pricing]); assert.match(found.docs[0].snippet ?? '', /«price»/);

  // ---- Browser ----------------------------------------------------------------------------------------------------
  if (process.env.PULSE_AUTH_BROWSER === '1') {
    mkdirSync(shots, { recursive: true });
    const { chromium, expect } = await import('../../../tests/e2e/node_modules/@playwright/test/index.mjs');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const probe = createServer(); await new Promise((d) => probe.listen(0, '127.0.0.1', d)); const port = probe.address().port; await new Promise((d) => probe.close(d));
    const base = `http://127.0.0.1:${port}`;
    // DOCS_DRIVE_WEB: serve another checkout's web (dev/live before this lane) against the same data, for the "before" shots.
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: WEB_DIR, detached: true, stdio: 'ignore',
      env: { ...process.env, PULSE_API_URL: origin, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-docs-drive', PULSE_PUBLIC_LOGIN_ENABLED: '', PULSE_TELEMETRY: '0' } });
    for (let i = 0; i < 480; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* starting */ } await delay(250); if (i === 479) throw Error('web did not start'); }
    browser = await chromium.launch({ headless: true });
    const prefix = process.env.DOCS_DRIVE_PREFIX || '';
    const shot = async (page, name) => { await delay(450); await page.screenshot({ path: join(shots, `${prefix}${name}`), fullPage: false }); };
    for (const [width, theme] of [[1920, 'light'], [363, 'dark']]) {
      const tag = `${width}-${theme}`, phone = width < 600;
      if (BEFORE) {
        // The page as it was: Docs home and the Offer folder, nothing clicked (its New folder opens a browser prompt).
        const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 1080 }, colorScheme: theme, extraHTTPHeaders: as(ADMIN) });
        await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); }, theme);
        const page = await c.newPage();
        await page.goto(`${base}/docs`, { timeout: 240000 });
        await expect(page.getByRole('heading', { level: 1, name: 'Docs' })).toBeVisible({ timeout: 180000 }); browserChecks++;
        await shot(page, `01-my-docs-${tag}.png`);
        await page.goto(`${base}/docs?folder=${offer}`);
        await expect(page.getByRole('heading', { name: 'Offer' }).first()).toBeVisible({ timeout: 120000 }); browserChecks++;
        await shot(page, `03-folder-${tag}.png`);
        await c.close();
        continue;
      }
      const c = await browser.newContext({ viewport: { width, height: phone ? 800 : 1080 }, colorScheme: theme, extraHTTPHeaders: as(ADMIN), reducedMotion: phone ? 'reduce' : 'no-preference' });
      await c.addInitScript((t) => { localStorage.setItem('pulse.theme', t); }, theme);
      const page = await c.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => { errors.push(`a browser dialog opened: ${d.message()}`); void d.dismiss(); });
      const wide = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no sideways scroll`);
      // 1. My Docs: the places, the tree, the top folders.
      await page.goto(`${base}/docs`, { timeout: 240000 });
      await expect(page.getByRole('heading', { level: 1, name: 'My Docs' })).toBeVisible({ timeout: 180000 }); browserChecks++;
      if (!phone) { await expect(page.getByRole('tree', { name: 'Folder tree' }).getByRole('link', { name: 'Company (synthetic)' })).toBeVisible(); browserChecks++; }
      await wide(); browserChecks++;
      await shot(page, `01-my-docs-${tag}.png`);
      // 2. Phone: the tree is a drawer.
      if (phone) {
        await page.getByRole('button', { name: 'Open folders' }).click();
        await expect(page.getByRole('tree', { name: 'Folder tree' })).toBeVisible(); browserChecks++;
        await shot(page, `02-drawer-${tag}.png`);
        await page.getByRole('navigation', { name: 'Folders' }).getByRole('button', { name: 'Close folders' }).click();
      }
      // 3. A folder with folders and docs: tiles with what they hold, cards with their type.
      await page.goto(`${base}/docs?folder=${offer}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Offer' })).toBeVisible({ timeout: 120000 }); browserChecks++;
      await expect(page.getByRole('listitem', { name: /Folder Stage 1/ })).toBeVisible(); browserChecks++;
      await expect(page.getByText('Meeting notes').first()).toBeVisible(); browserChecks++;
      await wide(); browserChecks++;
      await shot(page, `03-folder-${tag}.png`);
      // 4. New folder in place: the name field is focused, no browser prompt.
      // FIX-DOCS-WORK: on a phone Docs' create button says "New doc" (the bottom bar's + New makes a task).
      await page.getByRole('button', { name: /^New( doc)?$/ }).click();
      await expect(page.getByRole('menu', { name: 'New' })).toBeVisible(); browserChecks++;
      await shot(page, `04-new-menu-${tag}.png`);
      await page.getByRole('menuitem', { name: 'Folder', exact: true }).click();
      const field = page.getByRole('textbox', { name: 'New folder name' });
      await expect(field).toBeFocused(); browserChecks++;
      await shot(page, `05-new-folder-${tag}.png`);
      await field.fill(`Stage 3 ${phone ? 'phone' : 'desk'}`); await field.press('Enter');
      await expect(page.getByRole('listitem', { name: new RegExp(`Folder Stage 3 ${phone ? 'phone' : 'desk'}`) })).toBeVisible({ timeout: 30000 }); browserChecks++;
      if (!phone) {
        // 5. Rename in place with F2, then Undo is offered (the island shows it).
        // FIX-DOCS-WORK (owner, 10 Nov 2026): one click opens a tile, so the keyboard reaches it by focus, not a click.
        const tile = page.getByRole('listitem', { name: /Folder Stage 3 desk/ });
        await tile.focus(); await tile.press('F2');
        const rn = page.getByRole('textbox', { name: 'Folder name' });
        await expect(rn).toBeFocused(); browserChecks++;
        await rn.fill('Stage 3 (renamed)'); await rn.press('Enter');
        await expect(page.getByRole('listitem', { name: /Folder Stage 3 \(renamed\)/ })).toBeVisible({ timeout: 30000 }); browserChecks++;
        // 6. Pick two docs with Ctrl: the bulk bar.
        // (a plain click opens a doc now; Ctrl-click, or the checkbox, picks)
        await page.getByRole('listitem', { name: /^Pricing notes/ }).click({ modifiers: ['Control'] });
        await page.getByRole('listitem', { name: /^Discovery call/ }).click({ modifiers: ['Control'] });
        await expect(page.getByRole('toolbar', { name: '2 chosen' })).toBeVisible(); browserChecks++;
        await shot(page, `06-bulk-bar-${tag}.png`);
        // 7. Details for one doc: let go of the two, put the focus on one, and open Details.
        await page.getByRole('toolbar', { name: '2 chosen' }).getByRole('button', { name: 'Unselect' }).click();
        await page.getByRole('listitem', { name: /^Pricing notes/ }).focus();
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        await expect(page.getByRole('complementary', { name: 'Details of Pricing notes' }).getByRole('button', { name: 'Ask AI about this doc' })).toBeVisible({ timeout: 30000 }); browserChecks++;
        await shot(page, `07-details-${tag}.png`);
        // 8. List view, sorted by name.
        await page.getByRole('button', { name: 'List' }).click();
        await page.getByRole('columnheader', { name: /Name/ }).getByRole('button').click();
        await expect(page.getByRole('columnheader', { name: /Who can see/ })).toBeVisible(); browserChecks++;
        await shot(page, `08-list-${tag}.png`);
        await page.getByRole('button', { name: 'Grid' }).click();
        await page.getByRole('button', { name: 'Details', exact: true }).click();
      }
      // 9. Search: ⌘K focuses it, the words are highlighted, the filters show.
      await page.keyboard.press(phone ? 'Escape' : 'Control+k');
      const search = page.getByRole('searchbox', { name: 'Search docs' });
      if (!phone) { await expect(search).toBeFocused(); browserChecks++; }
      await search.fill('price'); await search.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Results for “price”' })).toBeVisible({ timeout: 60000 }); browserChecks++;
      await expect(page.locator('mark').first()).toBeVisible(); browserChecks++;
      await wide(); browserChecks++;
      await shot(page, `09-search-${tag}.png`);
      // 10. An empty place has one clear next step.
      await page.goto(`${base}/docs?view=starred`);
      await expect(page.getByRole('heading', { level: 2, name: 'No stars yet' })).toBeVisible({ timeout: 60000 }); browserChecks++;
      await shot(page, `10-empty-starred-${tag}.png`);
      assert.deepEqual(errors, [], `${tag}: no page errors or browser dialogs`); browserChecks++;
      await c.close();
    }
  }
  writeFileSync(process.env.DOCS_DRIVE_REPORT || join(tmpdir(), 'docs-drive.json'), JSON.stringify({ apiChecks, browserChecks }));
  console.log(`docs-drive: ${apiChecks} API checks, ${browserChecks} browser checks pass`);
} finally {
  await browser?.close().catch(() => undefined);
  if (web) { try { process.kill(-web.pid, 'SIGTERM'); } catch { /* gone */ } }
  // next dev rewrites these two files; put them back as the AGENT-UI walk does.
  if (web) { try { execFileSync('git', ['checkout', '--', 'tsconfig.json', 'next-env.d.ts'], { cwd: WEB_DIR, stdio: 'ignore' }); } catch { /* not a checkout */ } }
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
