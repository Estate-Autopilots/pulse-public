import { pipSvg } from './pip.js';
export function updateCard(root, { update, installLabel = 'Install and restart', onInstall, onLater, busy = false, hint = '', showPip = true }) {
  const card = document.createElement('section'); card.className = 'pc-update'; card.setAttribute('aria-label', 'Pulse update');
  const pip = document.createElement('div'); pip.innerHTML = pipSvg({ mood: 'waking', size: 44, still: true });
  const text = document.createElement('p'); text.textContent = `A new Pulse is ready — what's new: ${update.notes}`;
  if (showPip) card.append(pip);
  card.append(text);
  if (hint) card.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: hint }));
  for (const [label, handler, primary] of [[installLabel, onInstall, true], ['Later', onLater, false]]) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: primary ? 'pc-btn pc-primary' : 'pc-btn', textContent: label, disabled: busy });
    b.addEventListener('click', handler); card.append(b);
  }
  root.append(card);
}
