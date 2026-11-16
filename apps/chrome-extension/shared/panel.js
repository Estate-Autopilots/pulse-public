// The companion panel as plain DOM: the desktop pop-up, the Chrome toolbar popup and the web widget all mount this,
// so the three look and behave the same. Text is always set with textContent; Pip is static markup from pip.js.
import { pipSvg } from './pip.js';
import { MODES } from './view.js';

const ICONS = {
  'check-in': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  'check-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  'break-start': '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
  'break-end': '<path d="m6 3 14 9-14 9z"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  minimize: '<path d="M5 12h14"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
};

export function icon(name, size = 16) {
  return `<svg class="pc-icon" aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function button(label, cls, iconName, attrs = {}) {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.insertAdjacentHTML('beforeend', icon(iconName));
  b.append(el('span', '', label));
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  return b;
}

/**
 * Mount the day view. Handlers: onAction(id), onMode(mode), onOpen(href), onTool(id).
 * Returns { render(view, ui), tick(view) }: render on every new view; tick only refreshes the running clock.
 * ui: { busy, status, statusTone, mode, showPip, still, tools: [{ id, label, icon }], openLabel, compact }
 */
export function mountPanel(root, handlers = {}) {
  let shape = '';
  let clock = null;

  function render(view, ui = {}) {
    const key = JSON.stringify([view.state, view.mood, view.title, view.subtitle, view.greeting, view.chip, view.actions, view.showModes, view.footer, view.next, view.waiting, view.timer?.label, !!view.timer, ui.busy, ui.status, ui.statusTone, ui.mode, ui.showPip, ui.still, ui.tools, ui.compact, ui.openLabel]);
    if (key === shape) { tick(view); return; }
    const focused = root.contains(document.activeElement) ? document.activeElement?.dataset?.focusKey : null;
    shape = key;
    const card = el('section', `pc${ui.compact ? ' pc-compact' : ''}`);
    card.dataset.state = view.state;
    card.setAttribute('aria-label', 'Pulse companion');
    if (ui.busy) card.setAttribute('aria-busy', 'true');

    const head = el('header', 'pc-head');
    if (ui.showPip !== false) {
      const pip = el('div', 'pc-pip');
      pip.innerHTML = pipSvg({ mood: view.mood, size: ui.compact ? 56 : 68, still: !!ui.still });
      head.append(pip);
    }
    const hello = el('div', 'pc-hello');
    if (view.greeting) hello.append(el('p', 'pc-greet', view.greeting));
    hello.append(el('h2', 'pc-title', view.title));
    const chip = el('span', 'pc-chip');
    chip.dataset.tone = view.chip?.tone ?? 'neutral';
    chip.append(el('i'), el('span', '', view.chip?.text ?? ''));
    hello.append(chip);
    head.append(hello);
    if (ui.tools?.length) {
      const tools = el('div', 'pc-tools');
      for (const t of ui.tools) {
        const b = button('', 'pc-tool', t.icon, { 'aria-label': t.label, title: t.label, 'data-focus-key': `tool:${t.id}` });
        b.addEventListener('click', () => handlers.onTool?.(t.id));
        tools.append(b);
      }
      head.append(tools);
    }
    card.append(head);

    if (view.timer) {
      const timer = el('div', 'pc-timer');
      clock = el('strong', 'pc-clock', view.timer.display);
      clock.setAttribute('role', 'timer');
      clock.setAttribute('aria-label', `${view.timer.display} ${view.timer.label}`);
      timer.append(clock, el('span', 'pc-timer-label', view.timer.label));
      card.append(timer);
    } else clock = null;
    if (view.subtitle) card.append(el('p', 'pc-sub', view.subtitle));

    if (view.showModes) {
      const modes = el('div', 'pc-modes');
      modes.setAttribute('role', 'radiogroup');
      modes.setAttribute('aria-label', 'Where are you working today?');
      for (const [id, label] of Object.entries(MODES)) {
        const b = button(label, 'pc-mode', null, { role: 'radio', 'aria-checked': String((ui.mode ?? 'office') === id), 'data-focus-key': `mode:${id}` });
        b.addEventListener('click', () => handlers.onMode?.(id));
        modes.append(b);
      }
      card.append(modes);
    }

    const actions = el('div', 'pc-actions');
    for (const a of view.actions) {
      const b = button(a.label, `pc-btn${a.primary ? ' pc-primary' : ''}`, a.id, { 'data-action': a.id, 'data-focus-key': `action:${a.id}` });
      b.disabled = !!ui.busy;
      b.addEventListener('click', () => handlers.onAction?.(a.id));
      actions.append(b);
    }
    card.append(actions);

    const status = el('p', 'pc-status', ui.status ?? (view.pending ? 'Saved on this device · syncing…' : ''));
    status.setAttribute('role', 'status');
    if (ui.statusTone) status.dataset.tone = ui.statusTone;
    card.append(status);

    const foot = el('footer', 'pc-foot');
    if (view.footer) foot.append(el('span', '', view.footer));
    if (view.next && ['done', 'leave', 'holiday', 'off'].includes(view.state)) foot.append(el('span', '', view.next));
    const links = el('div', 'pc-links');
    if (view.waiting) {
      const w = button(view.waiting.label, 'pc-link pc-waiting', 'bell', { 'data-focus-key': 'waiting' });
      w.addEventListener('click', () => handlers.onOpen?.(view.waiting.href));
      links.append(w);
    }
    const open = button(ui.openLabel ?? 'Open Pulse', 'pc-link', 'open', { 'data-focus-key': 'open' });
    open.addEventListener('click', () => handlers.onOpen?.('/me'));
    links.append(open);
    foot.append(links);
    card.append(foot);

    root.replaceChildren(card);
    if (focused) root.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function tick(view) {
    if (!clock || !view.timer) return;
    if (clock.textContent !== view.timer.display) {
      clock.textContent = view.timer.display;
      clock.setAttribute('aria-label', `${view.timer.display} ${view.timer.label}`);
    }
  }

  return { render, tick, reset() { shape = ''; } };
}

/**
 * The sign-in view shared by the desktop panel and the Chrome popup.
 * model: { phase: 'start' | 'code' | 'awaiting' | 'password' | 'gate' | 'error', code, message, busy, still, place }
 * place names whose Pulse this is ("Northwind Studio’s Pulse"), asked before the code is requested; 'awaiting' is a
 * code the person approved that waits for the company's admin.
 * handlers: onPair(), onCancel(), onPassword({ username, password, code }), onDemo(), onOpenUrl()
 */
export function renderConnect(root, model, handlers = {}) {
  const card = el('section', 'pc pc-connect');
  card.setAttribute('aria-label', 'Connect Pulse');
  const head = el('header', 'pc-head');
  const pip = el('div', 'pc-pip');
  const waiting = model.phase === 'code' || model.phase === 'awaiting';
  pip.innerHTML = pipSvg({ mood: waiting ? 'waking' : 'idle', size: 68, still: !!model.still });
  const hello = el('div', 'pc-hello');
  const title = model.phase === 'code' ? 'Approve in your browser' : model.phase === 'awaiting' ? 'Waiting for your admin' : model.place ? `Join ${model.place}?` : 'Connect to Pulse';
  hello.append(el('p', 'pc-greet', 'Hi, I’m Pip'), el('h2', 'pc-title', title));
  head.append(pip, hello);
  card.append(head);

  if (waiting) {
    card.append(el('p', 'pc-sub', model.phase === 'code'
      ? `Your browser opened ${model.place ?? 'Pulse'}. Check that it shows this code, then press Approve.`
      : `Your admin approves new computers for ${model.place ?? 'Pulse'}. Pulse keeps waiting for up to a day, even after a restart.`));
    const code = el('p', 'pc-code', model.code ?? '');
    code.setAttribute('aria-label', `Code ${String(model.code ?? '').split('').join(' ')}`);
    card.append(code);
    const row = el('div', 'pc-actions');
    if (model.phase === 'code') {
      const again = button('Open again', 'pc-btn', 'open');
      again.addEventListener('click', () => handlers.onOpenUrl?.());
      row.append(again);
    }
    const cancel = button('Cancel', 'pc-btn');
    cancel.addEventListener('click', () => handlers.onCancel?.());
    row.append(cancel);
    card.append(row);
  } else if (model.phase === 'password') {
    const form = el('form', 'pc-form');
    const field = (label, name, type, auto) => {
      const l = el('label', 'pc-field', label);
      const i = el('input');
      i.name = name; i.type = type; i.autocomplete = auto; i.required = name !== 'code';
      l.append(i);
      return l;
    };
    form.append(field('Pulse username', 'username', 'text', 'username'), field('Password', 'password', 'password', 'current-password'));
    if (model.twoStep) form.append(field('Authenticator or recovery code', 'code', 'text', 'one-time-code'));
    const submit = button(model.twoStep ? 'Verify' : 'Sign in', 'pc-btn pc-primary');
    submit.type = 'submit';
    submit.disabled = !!model.busy;
    const back = button('Back', 'pc-btn');
    back.addEventListener('click', () => handlers.onCancel?.());
    const row = el('div', 'pc-actions');
    row.append(submit, back);
    form.append(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = new FormData(form);
      handlers.onPassword?.({ username: String(d.get('username') ?? ''), password: String(d.get('password') ?? ''), code: String(d.get('code') ?? '') });
    });
    card.append(form);
  } else {
    card.append(el('p', 'pc-sub', 'Check in, take a break and check out in one click — with the same rules as My desk.'));
    const row = el('div', 'pc-actions pc-stack');
    const pair = button('Sign in with your Pulse account', 'pc-btn pc-primary', 'open');
    pair.disabled = !!model.busy;
    pair.addEventListener('click', () => handlers.onPair?.());
    row.append(pair);
    if (handlers.onPasswordStart) {
      const pw = button('Use username and password', 'pc-btn');
      pw.addEventListener('click', () => handlers.onPasswordStart());
      row.append(pw);
    }
    if (handlers.onDemo) {
      const demo = button('Try it without signing in', 'pc-link');
      demo.addEventListener('click', () => handlers.onDemo());
      row.append(demo);
    }
    card.append(row);
  }
  const status = el('p', 'pc-status', model.message ?? '');
  status.setAttribute('role', model.phase === 'error' || model.phase === 'gate' ? 'alert' : 'status');
  if (model.phase === 'error' || model.phase === 'gate') status.dataset.tone = 'warning';
  card.append(status);
  root.replaceChildren(card);
}
