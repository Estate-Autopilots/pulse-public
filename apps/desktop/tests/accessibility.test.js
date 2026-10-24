import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureFocusTarget, restoreFocusTarget } from '../src/accessibility.js';

function node({ dataset = {}, attributes = {}, id = '', tagName = 'BUTTON' } = {}) {
  return {
    dataset,
    id,
    tagName,
    getAttribute(name) { return attributes[name] ?? null; },
    focus(options) { this.focusOptions = options; },
  };
}

function rootWith(...nodes) {
  return {
    contains(candidate) { return nodes.includes(candidate); },
    querySelectorAll() { return nodes; },
    querySelector(selector) {
      return selector === '[data-view-heading]'
        ? nodes.find((candidate) => candidate.dataset.viewHeading !== undefined) ?? null
        : null;
    },
  };
}

const oldThemeButton = node({ dataset: { action: 'theme' } });
const focusRoot = rootWith(oldThemeButton);
assert.deepEqual(captureFocusTarget(focusRoot, oldThemeButton), { kind: 'data', key: 'action', value: 'theme' });
assert.equal(captureFocusTarget(focusRoot, node()), null, 'controls outside the app are ignored');

const replacementThemeButton = node({ dataset: { action: 'theme' } });
const themeRoot = rootWith(replacementThemeButton);
assert.equal(restoreFocusTarget(themeRoot, { kind: 'data', key: 'action', value: 'theme' }), replacementThemeButton);
assert.deepEqual(replacementThemeButton.focusOptions, { preventScroll: true });

const heading = node({ dataset: { viewHeading: '' }, tagName: 'H1' });
const newView = rootWith(heading);
assert.equal(restoreFocusTarget(newView, { kind: 'data', key: 'removed', value: 'gone' }), heading, 'missing controls fall back to the new heading');
assert.deepEqual(heading.focusOptions, { preventScroll: true });

// The Settings sheet replaced the old Settings & privacy window (owner, 9 Oct 2026). Its controls are labelled the
// same way: every switch is a role="switch" button named by its row label and described by its one-line hint, and
// the sheet has one polite live region; the left list is a labelled navigation landmark.
const html = await readFile(new URL('../src/settings.html', import.meta.url), 'utf8');
assert.match(html, /id="settings" class="settings-root" aria-live="polite"/);
assert.match(html, /<script type="module" src="settings.js"/);
const settings = await readFile(new URL('../src/settings.js', import.meta.url), 'utf8');
assert.match(settings, /setAttribute\('role', 'switch'\)/);
assert.match(settings, /control\.setAttribute\('aria-labelledby', l\.id\)/);
assert.match(settings, /control\.setAttribute\('aria-describedby', `\$\{id\}-h`\)/);
assert.match(settings, /nav\.setAttribute\('aria-label', 'Settings sections'\)/);
assert.match(settings, /box\.setAttribute\('aria-label', 'Your feedback'\)/);
assert.doesNotMatch(settings, /\bconfirm\(|\balert\(/, 'confirmations use the in-page dialog');
console.log('Desktop accessibility checks passed (labelled controls and scoped live region).');
