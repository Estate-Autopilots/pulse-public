// Renders the companion panel in Chromium at the real window width with a mocked Tauri bridge, for every state in
// light and dark, checks layout (no overflow, every control inside the window, no page errors) and saves screenshots.
// These are layout receipts with mocked IPC, not physical install receipts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const require = createRequire(new URL('../../../tests/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = resolve('dist'), out = process.env.PULSE_PANEL_SCREENSHOT_DIR ?? (process.env.PULSE_DESKTOP_SCREENSHOT_DIR ? resolve(process.env.PULSE_DESKTOP_SCREENSHOT_DIR, 'panel') : '/home/eadev/ea-research/companion/desktop');
await mkdir(out, { recursive: true });
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname, file = resolve(root, path === '/' ? 'index.html' : '.' + path);
    if (!file.startsWith(root + sep)) throw Error('scope'); // sep: \ on the Windows runner
    res.setHeader('content-type', types[extname(file)] ?? 'text/plain'); res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// state: payload state; time: IST clock; options: demoPayload options; signedIn; click: button to press first.
const NOT_PULSE = 'That address answered, but it isn’t Pulse, or its front door doesn’t let apps in yet. Check the address with your admin.';
const SCENES = [
  { name: 'address', signedIn: false, noAddress: true },
  { name: 'address-not-pulse', signedIn: false, noAddress: true, address: 'https://example.com', notPulse: NOT_PULSE },
  { name: 'connect', signedIn: false },
  { name: 'join-company', signedIn: false, company: 'Northwind Studio', text: 'Join Northwind Studio’s Pulse?' },
  { name: 'connect-code', signedIn: false, company: 'Northwind Studio', click: 'Sign in with your Pulse account', text: 'Your browser opened Northwind Studio’s Pulse.' },
  { name: 'admin-wait', signedIn: false, company: 'Northwind Studio', awaiting: true, text: 'Your admin approves new computers for Northwind Studio’s Pulse.' },
  { name: 'admin-denied', signedIn: false, company: 'Northwind Studio', awaiting: true, deny: true, text: 'Your admin did not approve this computer. Nothing was signed in.' },
  { name: 'connect-gate', signedIn: false, gate: true, click: 'Sign in with your Pulse account' },
  { name: 'secure-store-wait', restoring: true, signedIn: false },
  { name: 'secure-store-restored', restoring: 'finish', state: 'in', time: '13:05' },
  { name: 'morning', state: 'out', time: '09:46' },
  { name: 'late', state: 'out', time: '10:42' },
  { name: 'offline-restored', state: 'in', time: '13:05', offline: true, recovery: true },
  { name: 'connection-retry', state: 'in', time: '13:05', offline: true },
  { name: 'checked-in', state: 'in', time: '13:05' },
  { name: 'celebrate', state: 'out', time: '09:58', options: { first: true }, click: 'Check in', after: 'in' },
  { name: 'break', state: 'break', time: '13:40' },
  { name: 'done', state: 'done', time: '19:20' },
  { name: 'night', state: 'done', time: '23:10' },
  { name: 'manager', state: 'in', time: '11:30', options: { waiting: 3 } },
  { name: 'holiday', state: 'holiday', time: '11:00' },
  { name: 'inbox', state: 'in', time: '12:00', tab: 'Inbox' },
  { name: 'inbox-empty', state: 'in', time: '12:00', tab: 'Inbox', emptyInbox: true },
  { name: 'chats', state: 'in', time: '12:00', tab: 'Chats' },
  { name: 'quick-reply', state: 'in', time: '12:00', tab: 'Chats', conversation: true },
  { name: 'ping-blocked', state: 'in', time: '12:00', pingIssue: 'Pings are turned off for Pulse in Windows. Press Fix, then turn Pulse on in Notifications.' },
];
const browser = await chromium.launch();
const results = [];
try {
  for (const theme of ['light', 'dark']) for (const scene of SCENES) {
    const ctx = await browser.newContext({ viewport: { width: 380, height: 720 }, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 2 });
    await ctx.addInitScript((scene) => {
      const calls = [];
      let after = null;
      let restored = false;
      window.__releaseSecureStore = () => { restored = true; };
      window.__calls = calls;
      const at = Date.parse(`2026-10-08T${scene.time ?? '10:00'}:00+05:30`);
      const channel='11111111-1111-4111-8111-111111111111';
      const me='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333';
      const snapshot={person:{id:me,name:'Synthetic Teammate'},counts:{chats:3,inbox:2,total:5}};
      const iso=(m)=>new Date(Date.now()-m*60000).toISOString();
      const channels=[{id:channel,name:'Leadership',kind:'pod',members:4,unread:2,lastAt:iso(4),preview:'Can we review the plan today?',previewAuthor:'Synthetic Colleague'},
        {id:other,name:'Synthetic Colleague',kind:'direct',members:2,unread:1,lastAt:iso(30),preview:'Sent the files',previewAuthor:'Synthetic Colleague'},
        {id:'44444444-4444-4444-8444-444444444444',name:'Creative',kind:'team',members:7,unread:0,lastAt:iso(60*26),preview:'New brand kit is in the folder',previewAuthor:'Synthetic Designer'},
        {id:'55555555-5555-4555-8555-555555555555',name:'Leadership',kind:'team',members:4,unread:0,lastAt:null,duplicateOf:channel}];
      const people=[{id:me,name:'Synthetic Teammate'},{id:other,name:'Synthetic Colleague',team:'Creative'}];
      const rows=scene.emptyInbox?[]:[{id:channel,title:'Synthetic Colleague asked for one day of leave',href:'/me?tab=requests',kind:'approval',readAt:null,at:iso(12)},
        {id:other,title:'Synthetic Colleague mentioned you in Leadership',href:`/chats?channel=${channel}`,kind:'mention',readAt:null,at:iso(5)},
        {id:'66666666-6666-4666-8666-666666666666',title:'Your comp-off was approved',href:'/me?tab=requests',kind:'decision',readAt:iso(40),at:iso(60)}];
      const messages=[{id:channel,authorId:other,name:'Synthetic Colleague',body:'Morning! Client call moved to 3 pm.',createdAt:iso(60*20),attachments:[],replies:0},
        {id:'m2',authorId:me,name:'Synthetic Teammate',body:'Noted, I will update the deck.',createdAt:iso(60*20-3),attachments:[],replies:0},
        {id:'m3',authorId:other,name:'Synthetic Colleague',body:'Can we review the plan today?',createdAt:iso(4),attachments:[],replies:1}];
      const err = (o) => JSON.stringify(o);
      const base = scene.noAddress ? null : 'https://pulse.example.com/api/native/v0';
      window.__TAURI__ = { core: { invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        const demo = await import('/companion/demo.js');
        switch (cmd) {
          case 'app_info': return { version: '1.0.0', platform: 'windows', shortcut: 'Ctrl+Alt+P', launch: {} };
          case 'autostart_get': return false;
          case 'companion_session': if(scene.recovery)localStorage.setItem('pulse.attendanceRecovery',JSON.stringify({owner:'https://pulse.example.com/api/native/v0|d',payload:demo.demoPayload('in',at),queue:[],confirmedAt:Date.now()-60000}));if(scene.restoring&&!restored)return {signedIn:false,restoring:true,base};return scene.signedIn === false ? { signedIn: false, base, company: null, awaitingAdmin: scene.awaiting && !scene.denied ? { code: 'KQ7M-4TXA', interval: 2, until: Date.now() + 864e5 } : null } : { signedIn: true, base, personName: 'Pip Demo', deviceId: 'd' };
          case 'companion_about': return { signedIn: false, base, company: scene.company ?? null };
          case 'companion_address_set': throw err({ status: 0, message: scene.notPulse });
          case 'companion_ping_state': return {snapshot,pingIssue:scene.pingIssue??null};
          case 'companion_request': {
            if(args.path==='chats')return {channels,people,viewer:me};
            if(args.path==='companion/inbox')return {rows};
            if(args.path.endsWith('/messages')){if(args.body){messages.push({...messages[0],id:'m'+messages.length,authorId:me,body:args.body.body,name:'Synthetic Teammate',createdAt:new Date().toISOString(),replies:0});return {id:channel};}return {messages,members:[]};}
            if (args.path === 'companion' && scene.offline) throw err({offline:true,message:'Offline; reconnect and retry.'});
            if (args.path === 'companion') return demo.demoPayload(after ?? scene.state ?? 'out', at, scene.options ?? {});
            after = scene.after ?? after; return { ok: true };
          }
          case 'companion_pair_start': if (scene.gate) throw err({ gate: true, message: 'Pulse’s front door is not open for apps yet. Your admin needs to allow app access; until then use Pulse in the browser.' }); return { code: 'KQ7M-4TXA', verifyUrl: 'https://pulse.example.com/connect?code=KQ7M-4TXA', expiresIn: 600, interval: 3 };
          case 'companion_pair_poll': if (scene.deny) { scene.denied = true; return { status: 'denied' }; } return scene.awaiting ? { status: 'awaiting_admin', until: Date.now() + 864e5 } : { status: 'pending' };
          default: return null;
        }
      } } };
    }, scene);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector('.pc').catch(error=>{throw Error(`${theme} ${scene.name}: ${error.message}; page errors: ${errors.join('; ')}`);});
    if(scene.restoring){
      await page.getByRole('heading',{name:'Opening your saved sign-in…'}).waitFor();
      const before=await page.evaluate(()=>window.__calls);
      assert.ok(before.some(([cmd])=>cmd==='update_healthy'),'real WebView acknowledges health while the OS permission is pending');
      assert.ok(!before.some(([cmd,args])=>cmd==='companion_request'||cmd==='update_prepare'||cmd==='companion_pair_start'),'no account requests, downloads or pairing while the secure store is pending');
      assert.equal(await page.getByRole('button',{name:'Sign in with your Pulse account'}).count(),0,'no competing sign-in while restoring the old account');
      if(scene.restoring==='finish'){await page.evaluate(()=>window.__releaseSecureStore());await page.getByRole('button',{name:'Break',exact:true}).waitFor();}
    }
    if(scene.offline){await page.getByRole('button',{name:'Retry',exact:true}).waitFor();await page.getByText(/Connection interrupted/).waitFor();if(scene.recovery)await page.getByRole('button',{name:'Break',exact:true}).waitFor();}
    if (scene.address) { await page.getByRole('textbox', { name: 'Pulse address' }).fill(scene.address); await page.getByRole('button', { name: 'Continue' }).click(); await page.getByRole('alert').getByText(scene.notPulse).waitFor(); }
    if (scene.noAddress) assert.equal(await page.getByRole('button', { name: 'Sign in with your Pulse account' }).count(), 0, 'no sign-in before the address passes the probe');
    if (scene.click) { await page.getByRole('button', { name: scene.click }).first().click(); await page.waitForTimeout(250); }
    if (scene.tab) { await page.getByRole('button', { name: new RegExp(`^${scene.tab}`) }).click(); await page.waitForTimeout(250); }
    if (scene.text) await page.getByText(scene.text).first().waitFor();
    if (scene.pingIssue) await page.getByRole('button', { name: 'Fix', exact: true }).waitFor();
    if (scene.name === 'chats') assert.equal(await page.getByRole('button', { name: /^Leadership/ }).count(), 1, 'an empty mirror of the same group is shown once');
    if(scene.conversation){
      await page.getByRole('button',{name:'Leadership · 2 unread'}).click();
      await page.getByRole('textbox',{name:'Quick reply'}).fill('Synthetic quick reply');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await page.getByRole('log').getByText('Synthetic quick reply',{exact:true}).waitFor();
    }
    await page.waitForTimeout(150);
    const g = await page.evaluate(() => {
      const app = document.getElementById('app'), box = app.getBoundingClientRect();
      const fit = window.__calls.filter(([c]) => c === 'panel_fit').at(-1)?.[1]?.height ?? null;
      return { width: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 1, height: Math.ceil(box.height), fit,
        controls: [...app.querySelectorAll('button,input,select')].filter((e) => e.getClientRects().length).map((e) => ({ name: (e.getAttribute('aria-label') ?? e.textContent).trim().slice(0, 40), left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right })),
        text: app.innerText.slice(0, 400),
        clutter: /Notification preferences|Enable laptop pings|Only groups you belong to can ping you|Could not check Windows notification settings/.test(app.innerText),
        banner: !!document.querySelector('.pc-banner:not([hidden])'),
        visibleScrollbar: [...app.querySelectorAll('*')].some((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== 'visible' && getComputedStyle(e).scrollbarWidth !== 'none') };
    });
    assert.equal(g.overflowX, false, `${scene.name} overflows`);
    assert.ok(g.controls.every((c) => c.left >= 0 && c.right <= 380), `${scene.name} control outside: ${JSON.stringify(g.controls)}`);
    assert.ok(g.height <= 680, `${scene.name} taller than the panel limit (${g.height})`);
    assert.deepEqual(errors, [], `${scene.name} page errors`);
    assert.equal(g.clutter, false, `${scene.name}: no permanent notification links or grey warnings`);
    assert.equal(g.banner, !!scene.pingIssue, `${scene.name}: the ping banner appears only when a ping cannot arrive`);
    assert.equal(g.visibleScrollbar, false, `${scene.name}: no visible scrollbars`);
    if (scene.name === 'celebrate') assert.match(g.text, /first check-in/i);
    if (scene.name === 'connect-code') assert.match(g.text, /KQ7M-4TXA/);
    if (scene.name === 'connect-gate') assert.match(g.text, /front door/);
    if (scene.name === 'manager') assert.match(g.text, /3 requests are waiting/);
    await page.locator('#app').screenshot({ path: `${out}/${theme}-${scene.name}.png` });
    results.push({ theme, scene: scene.name, ...g, ipc: 'mocked' });
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
}
console.log(`desktop panel: ${results.length} states checked → ${out}`);
