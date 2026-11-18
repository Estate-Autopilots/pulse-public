// "Your Pulse address": the first step on a new computer, before sign-in, and Settings → Account → Change. Pulse has
// no built-in company: the person enters their company's address, and the shell checks it with the signed-out
// probe before saving it.
import { pipSvg } from './companion/pip.js';

export const EXAMPLE = 'https://pulse.example.com';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; };
export const failure = (e) => { if (e && typeof e === 'object' && 'message' in e && !(e instanceof Error)) return e; try { return JSON.parse(String(e?.message ?? e)); } catch { return { message: String(e?.message ?? e ?? 'Something went wrong') }; } };

/** The host people recognise ("pulse.example.com") for a saved gateway or site, or '' when there is none. */
export function addressHost(base) {
  try { return base ? new URL(base).host : ''; } catch { return ''; }
}

/** Checks and saves an address through the shell; resolves to the new session, or rejects with `{ message }`. */
export async function saveAddress(invoke, value) {
  const address = String(value ?? '').trim();
  if (!address) throw { message: `Enter your Pulse address, like ${EXAMPLE}` };
  let session;
  try { session = await invoke('companion_address_set', { address }); } catch (e) { throw failure(e); }
  // The company name for "Join <company>'s Pulse?"; an older Pulse gives none and the host is shown instead.
  return invoke('companion_about').then((named) => named ?? session, () => session);
}

/** The address step as a card like the sign-in screen. model: { value, busy, message, still }; handlers: onSave, onCancel. */
export function renderAddress(root, model, handlers = {}) {
  const card = el('section', 'pc pc-connect pc-address');
  card.setAttribute('aria-label', 'Your Pulse address');
  const head = el('header', 'pc-head'), pip = el('div', 'pc-pip'), hello = el('div', 'pc-hello');
  pip.innerHTML = pipSvg({ mood: 'idle', size: 68, still: !!model.still });
  hello.append(el('p', 'pc-greet', 'Hi, I’m Pip'), el('h2', 'pc-title', 'Your Pulse address'));
  head.append(pip, hello);
  card.append(head, el('p', 'pc-sub', 'Enter the address your company uses for Pulse. It’s in your browser’s address bar when Pulse is open, or ask your admin.'));
  const form = el('form', 'pc-form'), label = el('label', 'pc-field', 'Pulse address'), input = el('input');
  Object.assign(input, { name: 'address', type: 'text', inputMode: 'url', autocomplete: 'url', spellcheck: false, placeholder: EXAMPLE, value: model.value ?? '', required: true });
  input.setAttribute('autocapitalize', 'off');
  label.append(input);
  const row = el('div', 'pc-actions'), save = el('button', 'pc-btn pc-primary', model.busy ? 'Checking…' : 'Continue');
  save.type = 'submit'; save.disabled = !!model.busy;
  row.append(save);
  if (handlers.onCancel) { const cancel = el('button', 'pc-btn', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => handlers.onCancel()); row.append(cancel); }
  form.append(label, row);
  form.addEventListener('submit', (e) => { e.preventDefault(); handlers.onSave?.(input.value); });
  const status = el('p', 'pc-status', model.message ?? (model.busy ? 'Checking that this is your Pulse…' : ''));
  status.setAttribute('role', model.message ? 'alert' : 'status');
  if (model.message) { status.dataset.tone = 'warning'; input.setAttribute('aria-invalid', 'true'); }
  card.append(form, status);
  root.replaceChildren(card);
  if (!model.busy) input.focus({ preventScroll: true });
  return card;
}
