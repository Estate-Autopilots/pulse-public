// R48: the CV export's text. Synthetic people and skills only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cvFileName, cvMarkdown, month } from '../dist/skills-model.js';

const body = {
  person: { name: 'Asha Example', role: 'Video editor', team: 'Creative', pod: 'Pod 1', joined: '2025-01-06' },
  headline: 'Edits *launch* reels', summary: 'Line one\nline two',
  skills: [
    { label: 'edit video footage', family: 'esco', code: 'urn:synthetic:1', local: false, level: 3, levelLabel: 'Strong', since: '2025-04', lastUsed: null,
      verified: { level: 2, levelLabel: 'Working', by: 'Ravi Example', basis: 'manager', at: '2026-10-01' }, approvedWork: ['Launch reel'], claimedWork: 2 },
    { label: 'Model shoot direction', family: 'local', code: 'local:x', local: true, level: 2, levelLabel: 'Working', since: null, lastUsed: '2026-08',
      verified: null, approvedWork: [], claimedWork: 1 },
  ],
  experience: [{ title: 'Shoot lead', project: 'Lakeview', started: '2025-03', ended: null, responsibilities: null, outcomes: '12 reels', confirmed: { by: 'HR Person', basis: 'hr' } }],
  scale: { confirmed: false, levels: [{ level: 1, label: 'Learning', description: 'x' }, { level: 2, label: 'Working', description: 'x' }] },
  attribution: ['This service uses the ESCO classification of the European Commission.'],
};

test('the CV says what is self-assessed, verified, approved, local and attributed', () => {
  const md = cvMarkdown(body, { version: 2, reviewedAt: '2026-10-12T10:00:00Z', company: 'Synthetic Co' });
  assert.match(md, /^# Asha Example\n\nVideo editor · Creative · Pod 1\n/);
  assert.match(md, /\*\*Edits \\\*launch\\\* reels\*\*/, 'typed markdown is escaped');
  assert.match(md, /Line one line two/);
  assert.match(md, /- \*\*edit video footage\*\* \(ESCO\): Strong, self-assessed; verified Working by Ravi Example \(manager, 2026-10-01\); since Apr 2025, in use now/);
  assert.match(md, / {2}- Approved work: Launch reel\n {2}- 2 more pieces of work linked, not yet approved/);
  assert.match(md, /\*\*Model shoot direction\*\* \(local skill\): Working, self-assessed; not verified yet; last used Aug 2026/);
  assert.match(md, /### Shoot lead · Lakeview\n\nMar 2025 – now · confirmed by HR Person \(HR\)/);
  assert.match(md, /Pulse's starting scale, not yet confirmed by HR\): 1 Learning, 2 Working\./);
  assert.match(md, /Reviewed by Asha Example on 2026-10-12 \(version 2\)\. Internal to Synthetic Co\./);
  assert.ok(md.trimEnd().endsWith('This service uses the ESCO classification of the European Commission.'));
});

test('months and file names', () => {
  assert.equal(month('2025-04'), 'Apr 2025');
  assert.equal(month(null), '');
  assert.equal(cvFileName('Asha Ëxample', 3), 'cv-asha-example-v3.md');
  assert.equal(cvFileName('***', 1), 'cv-person-v1.md');
});
