// The toolbar popup: the same companion panel as the desktop app and the web widget. It only renders; every Pulse
// call goes through the background worker (companion-worker.js).
import { applyLocal, deriveView, prefsWith } from './shared/index.js';
import { UpdateController, parseManifest, newer } from './shared/updates.js';
import { updateCard } from './shared/update-card.js';
import { mountCommunications } from './shared/communications.js';
import { icon, mountPanel, renderConnect } from './shared/panel.js';

const root = document.getElementById('app');
const ask = (msg) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ companion: true, ...msg }, (r) => {
  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
  else if (!r?.ok) reject(Object.assign(new Error(r?.error?.message ?? 'Pulse did not answer'), r?.error ?? {}));
  else resolve(r.data);
}));
const state = { s: null, screen: 'day', busy: false, status: null, celebrate: false, mode: localStorage.getItem('pulse.mode'), connect: { phase: 'start' } };
const communications=mountCommunications(root,{
  call:(path,body)=>ask({op:'communication',path,body}),
  onOpen:(href)=>void chrome.tabs.create({url:new URL(href,new URL(state.s?.base??'https://pulse.estateautopilots.com').origin).href}),
  onSwitch:()=>void ask({op:'signOut'}).then(load),platform:'chrome',
});
const panel = mountPanel(communications.todayHost, {
  onAction: (id) => void act(id),
  onMode: (m) => { state.mode = m; localStorage.setItem('pulse.mode', m); render(); },
  onOpen: (href) => void chrome.tabs.create({ url: new URL(href, new URL(state.s?.base ?? 'https://pulse.estateautopilots.com').origin).href }),
  onTool: (t) => { if (t === 'settings') { state.screen = 'settings'; render(); } else window.close(); },
});
const now = () => Date.now() + (state.s?.day?.offset ?? 0);

const updateContext = () => ({ signedIn: !!state.s?.signedIn, demo: !!state.s?.demo, busy: state.busy, pending: !!state.s?.day?.queued, payload: state.s?.day?.payload });
const updates = new UpdateController({ check: async () => {
  const found = await ask({ op: 'updates' });
  return found && newer(found.version, chrome.runtime.getManifest().version) ? parseManifest(found) : null;
}, clock: () => now(), changed: () => showUpdate() });
updates.laterUntil = Number(localStorage.getItem('pulse.updateLater') || 0);
function showUpdate() {
  root.querySelector('.pc-update')?.remove();
  const status = root.querySelector('[data-update-status]'); if (status) status.textContent = updates.status || 'Test channel · checks every four hours';
  const check = root.querySelector('[data-update-check]'); if (check) check.disabled = updates.running || !!state.s?.demo;
  const update = updates.offer(updateContext());
  const zip = update?.files.find(f => f.platform === 'chrome' && f.kind === 'zip');
  if (zip) updateCard(state.screen === 'settings' ? root.firstElementChild : root, { update, showPip: state.s?.prefs?.mascot !== false, installLabel: 'Download update', hint: 'This is an unpacked extension. Unzip the download into your Pulse folder, then click Reload in chrome://extensions. Automatic installation starts after a Web Store listing is available.', onInstall: () => { if (updates.offer(updateContext())) void chrome.tabs.create({ url: zip.url }); }, onLater: () => { updates.later(); localStorage.setItem('pulse.updateLater', String(updates.laterUntil)); } });
}

function footer(text, button, onClick) {
  const f = document.createElement('div'); f.className = 'extra';
  f.append(Object.assign(document.createElement('span'), { textContent: text }));
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: button });
  b.addEventListener('click', onClick); f.append(b);
  root.append(f);
}
function render() {
  const s = state.s;
  const prefs = s?.prefs ?? prefsWith({});
  if (!s || state.screen === 'settings') { if (s) { renderSettings(prefs); showUpdate(); } return; }
  if (!s.signedIn) {
    const pair = s.pair && s.pair.status === 'pending' ? s.pair : null;
    const model = pair ? { phase: 'code', code: pair.code, message: 'Waiting for your approval… you can close this popup.' }
      : s.pair?.status && s.pair.status !== 'pending' ? { phase: 'error', message: s.pair.status === 'denied' ? 'Not approved. Nothing was signed in.' : s.pair.message ?? 'The code expired. Start again when you’re ready.' }
        : state.connect;
    renderConnect(root, { ...model, still: !prefs.mascot }, {
      onPair: () => void pair_(),
      onOpenUrl: () => { if (s.pair?.url) void chrome.tabs.create({ url: s.pair.url }); },
      onCancel: () => void ask({ op: 'cancelPair' }).then(load),
      onDemo: () => void ask({ op: 'demo', on: true }).then(load),
    });
    footer('Work-context features stay off unless you turn them on.', 'Optional', () => void chrome.tabs.create({ url: chrome.runtime.getURL('context.html') }));
    return;
  }
  const p = s.day?.payload ?? null;
  communications.attach();
  if(s.communications)communications.snapshot(s.communications);
  if(s.pingError)communications.status(s.pingError);
  panel.reset();
  panel.render(deriveView(p, now(), { celebrate: state.celebrate }), {
    busy: state.busy, status: state.status?.text ?? (s.demo ? 'Demo · nothing is saved' : s.error ? s.error.message : undefined), statusTone: state.status?.tone ?? (s.error ? 'warning' : undefined),
    mode: state.mode ?? p?.shift?.mode ?? 'office', showPip: prefs.mascot,
    tools: [{ id: 'settings', label: 'Settings', icon: 'settings' }, { id: 'close', label: 'Close', icon: 'close' }],
  });
  showUpdate();
}
function renderSettings(prefs) {
  const wrap = document.createElement('section'); wrap.className = 'settings'; wrap.setAttribute('aria-label', 'Pulse settings');
  const head = document.createElement('header');
  head.append(Object.assign(document.createElement('h2'), { textContent: 'Settings' }));
  const back = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-tool' }); back.setAttribute('aria-label', 'Back'); back.innerHTML = icon('close');
  back.addEventListener('click', () => { state.screen = 'day'; render(); });
  head.append(back); wrap.append(head);
  const h = (t) => wrap.append(Object.assign(document.createElement('h3'), { textContent: t }));
  const toggle = (label, key) => {
    const row = document.createElement('label'); row.className = 'row';
    row.append(Object.assign(document.createElement('span'), { textContent: label }));
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!prefs[key] });
    input.addEventListener('change', () => { prefs = prefsWith({ ...prefs, [key]: input.checked }); state.s.prefs = prefs; void ask({ op: 'prefs', prefs }); });
    row.append(input); wrap.append(row);
  };
  h('Updates');
  const check = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Check for updates', disabled: updates.running || !!state.s?.demo });
  check.dataset.updateCheck = '';
  check.addEventListener('click', () => void updates.poll(updateContext(), true));
  const updateStatus = Object.assign(document.createElement('p'), { className: 'muted', textContent: updates.status }); updateStatus.dataset.updateStatus = '';
  wrap.append(check, updateStatus);
  h('Reminders');
  toggle('Check in when my shift starts', 'checkIn');
  toggle(`Back from a break (after ${prefs.breakMinutes} min)`, 'breakBack');
  toggle('Check out when my shift ends', 'checkOut');
  h('Look');
  toggle('Show Pip, the Pulse bot', 'mascot');
  h('Work context (optional)');
  wrap.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Counting time on company-mapped work sites is off unless you connect it and accept the published notice. It never reads page contents.' }));
  const ctx = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-link', textContent: 'Open work-context settings ↗' });
  ctx.addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('context.html') }));
  wrap.append(ctx);
  h('Account');
  if (state.s?.signedIn && !state.s.demo) {
    wrap.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'This browser is signed in as one Pulse device. Sign it out here, in Settings → Devices or in Account / Security.' }));
    const out = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-btn', textContent: 'Sign out of this browser' });
    out.addEventListener('click', () => void ask({ op: 'signOut' }).then(() => { state.screen = 'day'; return load(); }));
    wrap.append(out);
  } else if (state.s?.demo) {
    const leave = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-btn', textContent: 'Leave the demo' });
    leave.addEventListener('click', () => void ask({ op: 'demo', on: false }).then(() => { state.screen = 'day'; return load(); }));
    wrap.append(leave);
  }
  if (state.developer && !state.s?.signedIn) {
    const label = Object.assign(document.createElement('label'), {className:'pc-field', textContent:'Developer server'});
    const input = Object.assign(document.createElement('input'), {type:'url', value:state.s?.base || 'https://pulse.estateautopilots.com/api/native/v0'});
    input.addEventListener('change', async () => { const origin = new URL(input.value).origin; if (await chrome.permissions.request({origins:[origin+'/*']})) { await ask({op:'base',base:input.value}); await load(); } });
    label.append(input); wrap.append(label);
  }
  const version = Object.assign(document.createElement('p'), { className: 'muted', textContent: `Pulse for Chrome ${chrome.runtime.getManifest().version}` });
  let taps=0; version.addEventListener('click', () => { if (++taps===7) { state.developer=true; renderSettings(prefs); } });
  wrap.append(version);
  root.replaceChildren(wrap);
}

async function load(force = false) {
  const before = !!state.s?.signedIn; const beforeDemo = !!state.s?.demo;
  try { state.s = await ask({ op: 'state', force }); } catch (e) { state.s = { signedIn: false, prefs: prefsWith({}) }; state.connect = { phase: 'error', message: e.message }; }
  if (before !== !!state.s?.signedIn || beforeDemo !== !!state.s?.demo) updates.reset();
  render();
  void updates.poll(updateContext());
}
async function pair_() {
  state.connect = { phase: 'start', busy: true, message: 'Opening Pulse in a new tab…' }; render();
  try { await ask({ op: 'pair' }); await load(); }
  catch (e) { state.connect = { phase: e.gate ? 'gate' : 'error', message: e.message }; render(); }
}
async function act(id) {
  const s = state.s; if (state.busy || !s?.day) return;
  const before = s.day.payload, extra = id === 'check-in' ? { mode: state.mode ?? before.shift?.mode ?? 'office' } : {};
  state.busy = true; state.status = null;
  s.day = { ...s.day, payload: { ...applyLocal(before, id, now(), extra), pending: false } }; render();
  try {
    const r = await ask({ op: 'act', action: id, extra });
    s.day = r.day;
    const first = id === 'check-in' && r.day?.payload?.streak?.firstCheckIn;
    state.status = first ? null : { text: id === 'check-in' ? 'Checked in. Have a good day!' : id === 'break-start' ? 'Enjoy your break' : id === 'break-end' ? 'Welcome back' : 'Checked out. See you tomorrow!', tone: 'success' };
    if (id === 'check-in') { state.celebrate = true; setTimeout(() => { state.celebrate = false; render(); }, 3200); }
  } catch (e) { s.day = { ...s.day, payload: before }; state.status = { text: e.message, tone: 'warning' }; }
  finally { state.busy = false; render(); }
}

setInterval(() => { if (state.screen === 'day' && state.s?.day) panel.tick(deriveView(state.s.day.payload, now(), { celebrate: state.celebrate })); }, 1000);
setInterval(() => { if (state.s && !state.s.signedIn && state.s.pair) void load(); }, 3000);
void load(true);

setInterval(() => { void updates.poll(updateContext()); showUpdate(); }, 60000);

setInterval(async()=>{if(state.s?.signedIn&&!state.s.demo){try{const s=await ask({op:"communicationState"});if(s.snapshot)communications.snapshot(s.snapshot);if(s.error)communications.status(s.error);}catch{}}},2500);
