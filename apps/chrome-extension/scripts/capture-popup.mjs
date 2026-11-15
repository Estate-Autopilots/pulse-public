// The toolbar popup in Chromium with a mocked chrome.runtime (the background answers with synthetic days):
// every state in light and dark, layout checks, screenshots. Layout receipts, not a real Chrome install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const out = process.env.PULSE_POPUP_SCREENSHOT_DIR ?? '/home/eadev/ea-research/companion/chrome';
await mkdir(out, { recursive: true });
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try { const p = new URL(req.url, 'http://x').pathname, file = resolve(root, '.' + (p === '/' ? '/popup.html' : p)); if (!file.startsWith(root + '/')) throw Error('scope'); res.setHeader('content-type', types[extname(file)] ?? 'text/plain'); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SCENES = [
  { name: 'signed-out', signedIn: false },
  { name: 'pairing', signedIn: false, pair: true },
  { name: 'morning', state: 'out', time: '09:48' },
  { name: 'checked-in', state: 'in', time: '15:20', options: { waiting: 2 } },
  { name: 'break', state: 'break', time: '13:30' },
  { name: 'done', state: 'done', time: '19:40' },
  {name:'inbox',state:'in',time:'12:00',click:/^Inbox/},
  {name:'chats',state:'in',time:'12:00',click:/^Chats/},
  {name:'quick-reply',state:'in',time:'12:00',click:/^Chats/,conversation:true},
  { name: 'settings', state: 'in', time: '12:00', click: 'Settings' },
];
const browser = await chromium.launch();
const results = [];
try {
  for (const theme of ['light', 'dark']) for (const scene of SCENES) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 600 }, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 2 });
    await ctx.addInitScript((scene) => {
      const at = Date.parse(`2026-10-08T${scene.time ?? '10:00'}:00+05:30`);
      const channel='11111111-1111-4111-8111-111111111111';
      const snapshot={person:{id:channel,name:'Synthetic teammate'},counts:{chats:2,inbox:1,total:3}};
      const messages=[{id:channel,name:'Synthetic colleague',body:'Can we review the plan today?',createdAt:new Date(at).toISOString(),attachments:[],replies:0}];
      window.chrome = { runtime: { lastError: null, getManifest: () => ({ version: '0.3.0' }), getURL: (p) => '/' + p, sendMessage: (msg, cb) => {
        import('/shared/demo.js').then(({ demoPayload }) => {
          const prefs = { checkIn: true, breakBack: true, checkOut: true, breakMinutes: 30, popAtStart: true, mascot: true, autoStart: false, autoCheckIn: false, presence: false };
          if(msg.op==='communicationState'){cb({ok:true,data:{snapshot}});return;}
          if(msg.op==='communication'){const data=msg.path==='chats'?{channels:[{id:channel,name:'Leadership',kind:'group',unread:2,lastAt:new Date(at).toISOString()}]}:msg.path==='companion/inbox'?{rows:[{id:channel,title:'Leave request approved',href:'/me?tab=requests',readAt:null,at:new Date(at).toISOString()}]}:msg.path.endsWith('/messages')?{messages,members:[]}:{};if(msg.body?.body)messages.push({...messages[0],body:msg.body.body,name:'You'});cb({ok:true,data});return;}
          if (msg.op === 'state') cb({ ok: true, data: scene.signedIn === false ? { signedIn: false, pair: scene.pair ? { code: 'KQ7M-4TXA', url: 'https://pulse.estateautopilots.com/connect?code=KQ7M-4TXA', status: 'pending' } : null, prefs, base: null }
            : { communications:snapshot,signedIn: true, demo: false, day: { payload: { ...demoPayload(scene.state, at, scene.options ?? {}), demo: false }, offset: at - Date.now() }, prefs, base: null } });
          else cb({ ok: true, data: {} });
        });
      } }, tabs: { create: () => {} } };
    }, scene);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
    await page.waitForSelector('.pc, .settings');
    if (scene.click) { await page.getByRole('button', { name: scene.click }).first().click(); await page.waitForTimeout(150); }
    await page.waitForTimeout(150);
    if(scene.conversation){await page.getByRole('button',{name:'Leadership · 2 unread'}).click();await page.getByRole('textbox',{name:'Quick reply'}).fill('Synthetic quick reply');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('log').getByText('Synthetic quick reply',{exact:true}).waitFor();}
    const g = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > innerWidth + 1, height: Math.ceil(document.body.getBoundingClientRect().height), text: document.body.innerText.slice(0, 300) }));
    assert.equal(g.overflowX, false, `${scene.name} overflows`);
    assert.ok(g.height <= 600, `${scene.name} is taller than a Chrome popup (${g.height})`);
    assert.deepEqual(errors, [], `${scene.name}: ${errors.join(', ')}`);
    if (scene.name === 'pairing') assert.match(g.text, /KQ7M-4TXA/);
    if (scene.name === 'checked-in') assert.match(g.text, /2 requests are waiting/);
    await page.screenshot({ path: `${out}/${theme}-${scene.name}.png`, fullPage: true });
    results.push({ theme, scene: scene.name, ...g, runtime: 'mocked' });
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(`chrome popup: ${results.length} states checked → ${out}`);
