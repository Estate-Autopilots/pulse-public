// Settings: one sheet with a short list — General, Notifications, Check-in & presence, Privacy & permissions,
// Account, Updates & about. Plain toggles with one-line explanations; every permission names what it gives you.
import { prefsWith, pipSvg } from './companion/index.js';
import { PING_TYPES, glyph, initials } from './companion/communications.js';
import { applyTheme, store } from './prefs.js';
import { EXAMPLE, addressHost, saveAddress } from './address.js';
import { learnCompany } from './pairing.js';

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const emit = (name, payload) => { try { return window.__TAURI__.event?.emit(name, payload)?.catch?.(() => {}); } catch { return null; } };
const failure = (e) => { try { return JSON.parse(String(e?.message ?? e)); } catch { return { message: String(e?.message ?? e ?? 'Something went wrong') }; } };
const request = (path, body) => invoke('companion_request', { path, body: body ?? null }).catch((e) => { throw failure(e); });
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; };
const SECTIONS = [
  ['general', 'General', 'settings'], ['notifications', 'Notifications', 'update'], ['presence', 'Check-in & presence', 'location'],
  ['privacy', 'Privacy & permissions', 'shield'], ['account', 'Account', 'person'], ['updates', 'Updates & about', 'info'],
];
const state = { section: 'general', info: { version: '', platform: 'windows', shortcut: 'Ctrl+Alt+P' }, session: null, prefs: prefsWith(store.get('prefs', {})), feedbackImage: null };
applyTheme();

// ------------------------------------------------------------------------------------------------ building blocks
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = el('div', 'toast', text); t.setAttribute('role', 'status'); document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}
let uid = 0;
function row(label, hint, control, { disabled = false } = {}) {
  const r = el('div', `row${disabled ? ' disabled' : ''}`), text = el('div', 'text'), id = `r${++uid}`;
  const l = el('span', 'label', label); l.id = `${id}-l`; text.append(l);
  if (hint) { const h = el('span', 'hint', hint); h.id = `${id}-h`; text.append(h); }
  if (control) {
    if (control.getAttribute('role') === 'switch' || control.tagName === 'SELECT' || control.tagName === 'INPUT') {
      control.setAttribute('aria-labelledby', l.id); if (hint) control.setAttribute('aria-describedby', `${id}-h`);
    }
    r.append(text, control);
  } else r.append(text);
  return r;
}
function toggle(checked, onChange, { disabled = false } = {}) {
  const b = el('button', 'switch'); b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!checked)); b.disabled = disabled;
  b.addEventListener('click', async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(next)); b.disabled = true;
    try { const kept = await onChange(next); if (kept === false) b.setAttribute('aria-checked', String(!next)); }
    catch (e) { b.setAttribute('aria-checked', String(!next)); toast(failure(e).message); }
    finally { b.disabled = disabled; }
  });
  return b;
}
function segmented(options, value, onChange, label) {
  const g = el('div', 'segmented'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const b = el('button', '', text); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(v === value));
    b.addEventListener('click', () => { for (const x of g.children) x.setAttribute('aria-checked', String(x === b)); onChange(v); });
    g.append(b);
  }
  return g;
}
/** An in-page confirmation (system dialogs differ between WebView2 and WebKit). Resolves true on confirm. */
function ask(title, text, confirmLabel) {
  return new Promise((resolve) => {
    const back = el('div', 'modal-back'), box = el('div', 'modal'), before = document.activeElement;
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'modal-title');
    const h = el('h3', '', title); h.id = 'modal-title';
    const actions = el('div', 'modal-actions');
    const done = (value) => { back.remove(); before?.focus?.(); resolve(value); };
    const cancel = button('Cancel', () => done(false)), ok = button(confirmLabel, () => done(true), 'btn primary');
    actions.append(cancel, ok); box.append(h, el('p', '', text), actions); back.append(box); document.body.append(back);
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === ok ? cancel : ok).focus(); } });
    ok.focus();
  });
}
function button(text, onClick, cls = 'btn') { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; }
function group(title, ...rows) { const g = el('div', 'group'); if (title) g.append(el('h3', '', title)); const c = el('div', 'card'); c.append(...rows.filter(Boolean)); g.append(c); return g; }
function status(text, tone) { const s = el('span', 'status'); if (tone) s.dataset.tone = tone; s.append(el('i'), el('span', '', text)); return s; }
function setPref(key, value) { state.prefs = prefsWith({ ...state.prefs, [key]: value }); store.set('prefs', state.prefs); void invoke('prefs_changed'); }
function page(title, lead) { const s = el('section'); s.setAttribute('aria-labelledby', 'page-title'); const h = el('h2', '', title); h.id = 'page-title'; s.append(h); if (lead) s.append(el('p', 'lead', lead)); return s; }
const mac = () => state.info.platform === 'macos';

// ------------------------------------------------------------------------------------------------ General
async function general() {
  const s = page('General', 'How Pulse looks and opens on this computer.');
  let autostart = false; try { autostart = await invoke('autostart_get'); } catch { /* unsupported */ }
  s.append(group('Appearance',
    row('Theme', 'Follow your computer, or keep Pulse light or dark.', segmented([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], store.get('theme', 'system'), (v) => { store.set('theme', v); applyTheme(); void invoke('prefs_changed'); }, 'Theme')),
    row('Show Pip, the Pulse bot', 'Pip waves, takes tea breaks and celebrates with you. Still poses when your computer asks for less motion.', toggle(state.prefs.mascot, (v) => setPref('mascot', v))),
  ));
  s.append(group('Opening Pulse',
    row(`Open Pulse when I sign in to this ${mac() ? 'Mac' : 'computer'}`, `Pulse waits quietly in the ${mac() ? 'menu bar' : 'tray'} so checking in is one click.`, toggle(autostart, async (v) => { const on = await invoke('autostart_set', { enabled: v }); return on === v; })),
    row('Show the quick panel when my workday starts', 'It slides up at your shift start so you can check in straight away.', toggle(state.prefs.popAtStart, (v) => setPref('popAtStart', v))),
  ));
  const keys = el('div', 'card');
  keys.append(row('Quick panel', 'Check in, inbox and chats from anywhere.', el('kbd', 'status', state.info.shortcut)), row('Search in the Pulse window', 'Find people, projects and pages.', el('kbd', 'status', mac() ? '⌘K' : 'Ctrl+K')), row('Settings', null, el('kbd', 'status', mac() ? '⌘,' : 'Ctrl+,')));
  const g = el('div', 'group'); g.append(el('h3', '', 'Keyboard'), keys); s.append(g);
  return s;
}

// ------------------------------------------------------------------------------------------------ Notifications
async function notifications() {
  const s = page('Notifications', 'Pings for messages, approvals and updates. Lock screens never show message text.');
  const ping = await invoke('companion_ping_state').catch(() => ({}));
  const fix = button('Turn on', async () => { const r = await invoke('companion_ping_fix').catch((e) => ({ ok: false, message: failure(e).message })); toast(r.ok ? 'Pings are on.' : r.message ?? 'Opened your notification settings.'); void go('notifications'); }, 'btn primary');
  s.append(group(null, row(`Pings on this ${mac() ? 'Mac' : 'computer'}`, ping.pingIssue ?? 'New messages and approvals appear as notifications, even when the panel is closed.', ping.pingIssue ? fix : status('On', 'good'))));
  if (!state.session?.signedIn) { s.append(el('p', 'note', 'Sign in to choose which pings you get.')); return s; }
  let settings;
  try { settings = (await request('companion/notification-settings')).settings; } catch (e) { s.append(el('p', 'note', failure(e).message)); return s; }
  const save = async () => { settings = (await request('companion/notification-settings', settings)).settings; };
  const zone = el('input', 'field'); zone.value = settings.timezone; zone.setAttribute('aria-label', 'Quiet hours time zone'); zone.addEventListener('change', async () => { settings.timezone = zone.value.trim(); try { await save(); } catch (e) { toast(failure(e).message); } });
  const time = (key, label) => { const i = el('input', 'field'); i.type = 'time'; i.value = settings[key]; i.setAttribute('aria-label', label); i.addEventListener('change', async () => { settings[key] = i.value; try { await save(); } catch (e) { toast(failure(e).message); } }); return i; };
  const hours = el('div', 'stepper'); hours.append(time('start', 'Quiet from'), el('span', 'status', 'to'), time('end', 'Quiet until'));
  s.append(group('Focus',
    row('Do not disturb', 'Pause every ping. Unread counts still update.', toggle(settings.dnd, async (v) => { settings.dnd = v; await save(); })),
    row('Quiet hours', 'No pings overnight or outside work. Off unless you turn it on.', toggle(settings.quiet, async (v) => { settings.quiet = v; await save(); })),
    row('Quiet between', null, hours), row('Time zone', 'For example Asia/Kolkata.', zone),
  ));
  s.append(group('Ping me about', ...Object.entries(PING_TYPES).map(([key, [label, hint]]) => row(label, hint, toggle(settings.types?.[key] !== false, async (v) => { settings.types = { ...(settings.types ?? {}), [key]: v }; await save(); })))));
  const minutes = el('output', '', `${state.prefs.breakMinutes} min`);
  const step = (d) => { setPref('breakMinutes', state.prefs.breakMinutes + d); minutes.textContent = `${state.prefs.breakMinutes} min`; };
  const stepper = el('div', 'stepper'); stepper.append(button('−', () => step(-5)), minutes, button('+', () => step(5)));
  stepper.firstElementChild.setAttribute('aria-label', 'Five minutes less'); stepper.lastElementChild.setAttribute('aria-label', 'Five minutes more');
  s.append(group('Reminders',
    row('Check in when my shift starts', 'A gentle nudge if you have not checked in yet.', toggle(state.prefs.checkIn, (v) => setPref('checkIn', v))),
    row('Back from a break', 'A reminder when a break runs long.', toggle(state.prefs.breakBack, (v) => setPref('breakBack', v))),
    row('Remind me after', null, stepper),
    row('Check out when my shift ends', 'So your day is recorded correctly.', toggle(state.prefs.checkOut, (v) => setPref('checkOut', v))),
  ));
  return s;
}

// ------------------------------------------------------------------------------------------------ Check-in & presence
async function presence() {
  const s = page('Check-in & presence', 'Let this laptop confirm you are at the office, so a check-in is never missed and you are never marked late by mistake.');
  if (!state.session?.signedIn) { s.append(el('p', 'note', 'Sign in to set up office check-in.')); return s; }
  const [p, payload] = await Promise.all([invoke('presence_status').catch(() => ({})), request('companion').catch(() => null)]);
  const policy = payload?.presence ?? {};
  const autoAllowed = !!policy.autoCheckIn;
  const offices = policy.offices ?? [];
  const consent = toggle(p.consent, async (v) => { await invoke('presence_check', { consent: v, autoConsent: v ? p.autoConsent : false }); void go('presence'); });
  const auto = toggle(p.autoConsent && autoAllowed, async (v) => { await invoke('presence_check', { consent: true, autoConsent: v }); void go('presence'); }, { disabled: !p.consent || !autoAllowed });
  s.append(group(null,
    row('Office presence', 'This laptop tells Pulse when it is on the office Wi-Fi or office network. Nothing is sent while this is off.', consent),
    row('Check me in automatically', autoAllowed ? `After about ${policy.dwellMinutes ?? 3} minutes at the office, Pulse checks you in and tells you.` : 'Your company has not turned on automatic check-in yet.', auto, { disabled: !p.consent || !autoAllowed }),
  ));
  const wifi = p.wifi ?? {};
  const officeName = offices.find((o) => o.id === p.server?.officeId)?.name;
  const rows = [];
  if (wifi.needsLocation) {
    rows.push(row('Wi-Fi name is hidden', mac() ? 'macOS shows Wi-Fi names only to apps with Location Services. The office network still works without it.' : 'Windows shows Wi-Fi names only to apps with location access. The office network still works without it.',
      button('Open settings', () => openOs(mac() ? 'location' : 'location'))));
  } else rows.push(row('Wi-Fi', wifi.connected ? `Connected to ${wifi.ssid}${wifi.accessPoint ? '' : ' (access point unknown)'}` : 'Not connected to Wi-Fi', status(wifi.connected ? 'Seen' : 'Off', wifi.connected ? 'good' : null)));
  if (p.consent) {
    rows.push(row('Pulse sees you', p.error ? p.error : officeName ? `At ${officeName}${p.server?.score ? ` · ${p.server.score}% sure` : ''}` : 'Not at a registered office right now', status(officeName ? 'At the office' : 'Away', officeName ? 'good' : null)));
    rows.push(row('Check again now', 'Pulse checks every minute or two, and whenever your Wi-Fi changes.', button('Check now', async () => { await invoke('presence_check', {}); void go('presence'); })));
  }
  s.append(group('Right now', ...rows));
  s.append(el('p', 'note', `Offices and Wi-Fi are set by HR (${offices.length || 'none'} registered). Pulse never records where you are outside an office, and keeps no location history.`));
  return s;
}
function openOs(page) { void invoke('open_os_settings', { page }).catch((e) => toast(failure(e).message)); }

// ------------------------------------------------------------------------------------------------ Privacy & permissions
async function privacy() {
  const s = page('Privacy & permissions', 'What Pulse may use on this computer, and what it gives you in return. You can change any of this at any time.');
  const [ping, p, tracker, autostart] = await Promise.all([invoke('companion_ping_state').catch(() => ({})), invoke('presence_status').catch(() => ({})), invoke('tracker_status').catch(() => null), invoke('autostart_get').catch(() => false)]);
  let notice = null;
  if (state.session?.signedIn) { try { notice = (await request('devices/policy')).notices?.[0] ?? null; } catch { /* unavailable */ } }
  const activityOn = !!tracker?.purposes?.includes('activity_context');
  const activity = toggle(activityOn, async (v) => {
    if (v && !await ask('Share focus and idle totals?', `${notice?.body?.summary ?? 'Pulse adds up which allowed work app was in front and how long you were idle, during work hours. Never window titles, keystrokes, screenshots or browsing.'} You can turn this off at any time.`, 'Turn on')) return false;
    await invoke('activity_set', { enabled: v }); toast(v ? 'Work activity is on for today’s work window.' : 'Work activity is off. Nothing more is collected.'); void go('privacy'); return true;
  }, { disabled: !state.session?.signedIn || !notice });
  const activityHint = !state.session?.signedIn ? 'Sign in first.' : !notice ? 'Your company has not published a work-activity notice, so this stays off.'
    : activityOn && tracker?.paused ? 'Paused after a break or check-out. Turn it off and on to resume for this work window.'
      : 'Gives you an automatic summary of your day and evidence if a timesheet is ever questioned. Totals only, during work hours.';
  s.append(group('Permissions',
    row('Notifications', ping.pingIssue ? 'Off · pings for messages and approvals cannot arrive.' : 'On · new messages and approvals reach you even when Pulse is closed.', ping.pingIssue ? button('Turn on', async () => { await invoke('companion_ping_fix'); void go('privacy'); }, 'btn primary') : status('Allowed', 'good')),
    row('Office presence', p.consent ? 'On · this laptop confirms when you are at the office.' : 'Off · turn it on in Check-in & presence to never miss a check-in.', button(p.consent ? 'Manage' : 'Set up', () => void go('presence'))),
    row('Work activity', activityHint, activity, { disabled: !notice }),
    row(`Start with this ${mac() ? 'Mac' : 'computer'}`, autostart ? 'On · Pulse opens quietly when you sign in.' : 'Off · open Pulse yourself when you need it.', button('Change', () => void go('general'))),
  ));
  const never = el('ul', 'never');
  for (const text of ['No screenshots, screen recording, camera or microphone.', 'No keystrokes, window titles, documents or browsing history.', 'No GPS on this laptop, and no location history anywhere.', 'Your manager sees totals and attendance, never raw activity.']) { const li = el('li'); li.insertAdjacentHTML('beforeend', glyph('decision', 14)); li.append(el('span', '', text)); never.append(li); }
  const g = el('div', 'group'); g.append(el('h3', '', 'What Pulse never does')); const c = el('div', 'card'); c.append(never); g.append(c); s.append(g);
  if (tracker?.seen?.length) {
    const list = el('ul', 'sent');
    for (const e of tracker.seen.slice(-30).reverse()) list.append(el('li', '', `${new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${e.kind === 'usage' ? `${e.data?.tool ?? 'Work app'}: ${Math.round((e.data?.activeSeconds ?? 0) / 60)} min active, ${Math.round((e.data?.idleSeconds ?? 0) / 60)} min idle` : e.kind}`));
    const sg = el('div', 'group'); sg.append(el('h3', '', 'Sent from this computer today')); const sc = el('div', 'card'); sc.append(list); sg.append(sc); s.append(sg);
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ Account
async function account() {
  const s = page('Account');
  const signedIn = !!state.session?.signedIn, host = addressHost(state.session?.site), company = state.session?.company;
  void learnCompany(invoke, state.session).then((name) => { if (name && state.section === 'account') void go('account'); });
  const who = el('div', 'account');
  const avatar = el('div', 'avatar', initials(state.session?.personName || 'Pulse'));
  const text = el('div'); text.append(el('strong', '', signedIn ? state.session.personName || 'Your Pulse account' : 'Not signed in'), el('span', '', signedIn ? `Signed in on this ${mac() ? 'Mac' : 'computer'} · ${company || host}` : 'Sign in with your Pulse account; you approve it in your browser.'));
  who.append(avatar, text);
  const c = el('div', 'card'); c.append(who); const g = el('div', 'group'); g.append(c); s.append(g);
  if (signedIn) {
    s.append(group(null, addressRow(signedIn, host, company),
      row('Your devices', 'Every computer and phone signed in to Pulse. Remove any you no longer use.', button('Open', () => void invoke('open_app', { path: '/settings?tab=devices' }))),
      row('Password and two-step sign-in', 'Change your password and see where you are signed in.', button('Open', () => void invoke('open_app', { path: '/account' }))),
      row(`Sign out of this ${mac() ? 'Mac' : 'computer'}`, 'Removes this computer’s access. Your work and history stay in Pulse.', button('Sign out', async () => { if (!await ask('Sign out of this computer?', 'Pulse stops checking you in and pinging you here until you sign in again. Your work and history stay in Pulse.', 'Sign out')) return; state.session = await invoke('companion_sign_out'); toast('Signed out of this computer.'); void go('account'); }, 'btn danger')),
    ));
  } else s.append(group(null, addressRow(signedIn, host, company), row('Sign in', 'Opens the Pulse window to connect this computer.', button('Sign in', () => void invoke('open_app', { path: null }), 'btn primary'))));
  return s;
}

/** The company's Pulse address. Changing it while signed in asks first: a different server signs this computer out. */
function addressRow(signedIn, host, company) {
  const r = row('Pulse address', host ? [company, host].filter(Boolean).join(' · ') : 'Not set yet. Pulse asks for it before you sign in.', button('Change', async () => {
    if (signedIn && !await ask('Change the Pulse address?', `Saving a different address signs this ${mac() ? 'Mac' : 'computer'} out of ${host}. Check-ins and activity not yet sent there are dropped; your work and history stay in Pulse.`, 'Continue')) return;
    r.replaceWith(addressForm(host));
  }));
  r.dataset.address = '';
  return r;
}
function addressForm(host) {
  const form = el('form', 'row address-form'), text = el('div', 'text'), label = el('label', 'label', 'Pulse address'), input = el('input'), hint = el('span', 'hint', `The address your company uses for Pulse, like ${EXAMPLE}`);
  Object.assign(input, { id: 'pulse-address', name: 'address', type: 'text', inputMode: 'url', autocomplete: 'url', spellcheck: false, placeholder: EXAMPLE, value: host ? `https://${host}` : '' });
  label.htmlFor = input.id; hint.id = 'pulse-address-hint'; input.setAttribute('aria-describedby', hint.id); input.setAttribute('autocapitalize', 'off');
  text.append(label, input, hint);
  const save = el('button', 'btn primary', 'Save'); save.type = 'submit';
  const controls = el('div', 'address-actions'); controls.append(save, button('Cancel', () => void go('account')));
  form.append(text, controls);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); save.disabled = true; hint.textContent = 'Checking that this is your Pulse…'; hint.removeAttribute('role'); delete hint.dataset.tone;
    try { state.session = await saveAddress(invoke, input.value); toast(`Pulse address saved: ${addressHost(state.session?.site)}`); void go('account'); }
    catch (err) { hint.textContent = err.message; hint.setAttribute('role', 'alert'); hint.dataset.tone = 'warn'; input.setAttribute('aria-invalid', 'true'); save.disabled = false; input.focus(); }
  });
  requestAnimationFrame(() => input.focus());
  return form;
}

// ------------------------------------------------------------------------------------------------ Updates & about
async function updates() {
  const s = page('Updates & about', 'Pulse updates itself safely: your sign-in, settings and saved work stay put.');
  const channel = store.get('updateChannel', 'test');
  const result = el('span', 'hint'); result.dataset.updateStatus = '';
  const check = button('Check now', () => void emit('pulse:check-updates'), 'btn'); check.dataset.updateCheck = '';
  const install = button('Install and restart', () => { void emit('pulse:install-update'); void invoke('panel_show'); }, 'btn primary'); install.dataset.updateInstall = '';
  const controls = el('div', 'update-controls'); controls.append(check, install);
  const refreshStatus = (snapshot = store.get('updateState', {})) => {
    if (snapshot.channel !== store.get('updateChannel', 'test')) snapshot = {};
    result.textContent = snapshot.status || 'Pulse checks on launch and every four hours.';
    check.disabled = !!snapshot.running;
    install.hidden = !snapshot.version || snapshot.running;
  };
  refreshStatus();
  void emit('pulse:request-update-state');
  const versionRow = row('Pulse', null, controls); versionRow.querySelector('.text').append(result);
  s.append(group(null, versionRow,
    row('Update channel', 'Test updates arrive first; Stable waits until they are proven.', segmented([['test', 'Test'], ['stable', 'Stable']], channel, (v) => { store.set('updateChannel', v); void emit('pulse:check-updates'); }, 'Update channel')),
  ));
  s.append(feedback());
  const about = el('p', 'note', `Pulse ${state.info.version} for ${mac() ? 'macOS' : 'Windows'} · © 2026 Estate Autopilots`);
  let taps = 0; about.addEventListener('click', () => { if (++taps === 7) toast('Developer options are in the quick panel sign-in screen.'); });
  s.append(about);
  return s;
}
function feedback() {
  const g = el('div', 'group feedback'); g.id = 'feedback';
  g.append(el('h3', '', 'Send feedback'));
  const c = el('div', 'card');
  const box = el('textarea'); box.placeholder = 'What worked, what didn’t, what would make Pulse better? Paste a screenshot here too.'; box.maxLength = 4000; box.setAttribute('aria-label', 'Your feedback');
  const attach = el('div', 'attach'), preview = el('img'), label = el('span', '', 'Optional screenshot: paste one, or choose a file.'), file = el('input'); preview.hidden = true; preview.alt = 'Attached screenshot';
  file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.hidden = true;
  const choose = button('Choose…', () => file.click()), remove = button('Remove', () => setImage(null)); remove.hidden = true;
  const send = button('Send feedback', async () => {
    const text = box.value.trim(); if (!text) { box.focus(); return; }
    send.disabled = true;
    try { await request('feedback', { text, screenshot: state.feedbackImage, platform: state.info.platform, appVersion: state.info.version, page: 'desktop-settings' }); box.value = ''; setImage(null); toast('Thank you! The Pulse team will read it.'); }
    catch (e) { toast(failure(e).message); } finally { send.disabled = false; }
  }, 'btn primary');
  function setImage(dataUrl) { state.feedbackImage = dataUrl; preview.hidden = !dataUrl; remove.hidden = !dataUrl; if (dataUrl) preview.src = dataUrl; else preview.removeAttribute('src'); label.textContent = dataUrl ? 'Screenshot attached.' : 'Optional screenshot: paste one, or choose a file.'; }
  const read = (blob) => { if (!blob || blob.size > 4 * 1024 * 1024) { toast('Choose an image under 4 MB.'); return; } const r = new FileReader(); r.onload = () => setImage(String(r.result)); r.readAsDataURL(blob); };
  file.addEventListener('change', () => read(file.files?.[0]));
  box.addEventListener('paste', (e) => { const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/')); if (item) { e.preventDefault(); read(item.getAsFile()); } });
  attach.append(preview, label, choose, remove, file, send);
  c.append(box, attach); g.append(c);
  return g;
}

// ------------------------------------------------------------------------------------------------ shell
const PAGES = { general, notifications, presence, privacy, account, updates };
const main = el('main', 'main'); main.id = 'settings-main'; main.tabIndex = -1;
const nav = el('nav'); nav.setAttribute('aria-label', 'Settings sections');
async function go(section, focus = false) {
  const target = section === 'feedback' ? 'updates' : PAGES[section] ? section : 'general';
  state.section = target;
  for (const b of nav.children) b.setAttribute('aria-current', b.dataset.section === target ? 'page' : 'false');
  history.replaceState(null, '', `#${section}`);
  try { state.session = await invoke('companion_session'); } catch { /* keep the last one */ }
  const content = await PAGES[target]().catch((e) => { const s = page('Something went wrong'); s.append(el('p', 'note', failure(e).message)); return s; });
  if (state.section !== target) return;
  main.replaceChildren(content); main.scrollTop = 0;
  if (section === 'feedback') document.querySelector('#feedback textarea')?.focus();
  else if (focus) main.focus({ preventScroll: true });
}
window.pulseSettings = { go: (s) => void go(s, true) };
async function boot() {
  await window.__TAURI__.event?.listen('pulse:update-state', ({ payload }) => {
    const result = main.querySelector('[data-update-status]');
    if (!result || payload.channel !== store.get('updateChannel', 'test')) return;
    result.textContent = payload.status || 'Pulse checks on launch and every four hours.';
    main.querySelector('[data-update-check]').disabled = !!payload.running;
    main.querySelector('[data-update-install]').hidden = !payload.version || payload.running;
  });
  try { state.info = await invoke('app_info'); } catch { /* defaults */ }
  document.documentElement.dataset.platform = state.info.platform;
  if (state.info.launch?.theme) document.documentElement.dataset.theme = state.info.launch.theme;
  const side = el('aside', 'side'), sheet = el('div', 'sheet');
  side.append(el('h1', '', 'Settings'), nav);
  for (const [id, label, icon] of SECTIONS) {
    const b = el('button'); b.type = 'button'; b.dataset.section = id; b.insertAdjacentHTML('beforeend', glyph(icon, 16)); b.append(el('span', '', label));
    b.addEventListener('click', () => void go(id, true));
    b.addEventListener('keydown', (e) => { const list = [...nav.children], i = list.indexOf(b); const next = e.key === 'ArrowDown' ? list[(i + 1) % list.length] : e.key === 'ArrowUp' ? list[(i - 1 + list.length) % list.length] : null; if (next) { e.preventDefault(); next.focus(); next.click(); } });
    nav.append(b);
  }
  const foot = el('div', 'side-foot'); const pip = el('span'); pip.innerHTML = pipSvg({ mood: 'idle', size: 28, still: true, uid: 'settings' }); foot.append(pip, el('span', '', `Pulse ${state.info.version}`)); side.append(foot);
  sheet.append(side, main); document.getElementById('settings').replaceChildren(sheet);
  try { window.__TAURI__.event?.listen('pulse:prefs', () => { state.prefs = prefsWith(store.get('prefs', {})); applyTheme(); })?.catch?.(() => {}); } catch { /* events unavailable */ }
  await go(location.hash.slice(1) || 'general');
}
void boot();
