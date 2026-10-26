import { pipSvg } from './companion/pip.js';

// The update lives outside the scrollable panel body, so its actions always have space.
export function updateCard(root, { update, onInstall, onLater, onNotes, onResize, showPip = true }) {
  const card = document.createElement('section');
  card.className = 'pc pc-update'; card.setAttribute('aria-label', 'Pulse update');
  const head = document.createElement('div'); head.className = 'pc-update-head';
  if (showPip) {
    const pip = document.createElement('div'); pip.innerHTML = pipSvg({ mood: 'waking', size: 32, still: true });
    head.append(pip);
  }
  head.append(Object.assign(document.createElement('p'), { className: 'pc-update-summary', textContent: 'A new Pulse is ready' }));
  const details = document.createElement('details');
  details.append(Object.assign(document.createElement('summary'), { textContent: "What's new" }));
  const notes = update.notes.trim();
  details.append(Object.assign(document.createElement('p'), { className: 'pc-update-notes', textContent: notes.length > 240 ? `${notes.slice(0, 240).trimEnd()}…` : notes }));
  if (notes.length > 240) {
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-link', textContent: 'Full release notes' });
    more.addEventListener('click', onNotes); details.append(more);
  }
  details.addEventListener('toggle', onResize);
  const actions = document.createElement('div'); actions.className = 'pc-update-actions';
  for (const [label, handler, primary] of [['Install and restart', onInstall, true], ['Later', onLater, false]]) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: `pc-btn${primary ? ' pc-primary' : ''}`, textContent: label });
    button.addEventListener('click', handler); actions.append(button);
  }
  card.append(head, details, actions); root.append(card);
}
