// DE-EA (owner, 28 Oct 2026: "make Pulse ready as a product for any company"): no company's address, code or word is a
// default in code. The install's mail and origin come from its environment; a company's words from its own settings.
import assert from 'node:assert/strict';
import test from 'node:test';
import { platformMail } from '../dist/platform-config.js';
import { orgVocabulary, workLabels } from '../dist/work-model.js';
import { vapidSubject } from '../dist/web-push-config.js';
import { registry } from '../dist/relationships-model.js';
import { countFile } from '../../../tools/check-tenant-neutral.mjs';

test('an install with no address set up sends no mail and names nobody', () => {
  const m = platformMail({});
  assert.deepEqual(m, { origin: null, mailDomain: null, mailFrom: null, clientMailFrom: null, mailProductionHost: null, mailStagingAllow: [] });
  assert.equal(vapidSubject({}), 'mailto:push@pulse.invalid');
});

test("an install's senders and production host follow its own domain", () => {
  const prod = platformMail({ PULSE_PUBLIC_URL: 'https://pulse.example.test/', PULSE_ENV: 'production' });
  assert.equal(prod.origin, 'https://pulse.example.test');
  assert.equal(prod.mailDomain, 'example.test');
  assert.equal(prod.mailFrom, 'hr@example.test');
  assert.equal(prod.clientMailFrom, 'admin@example.test');
  assert.equal(prod.mailProductionHost, 'pulse.example.test');
  // A staging host is never production by default: it mails only its own senders.
  const staging = platformMail({ PULSE_PUBLIC_URL: 'https://pulse-dev.example.test' });
  assert.equal(staging.mailProductionHost, null);
  assert.deepEqual(staging.mailStagingAllow, ['hr@example.test', 'admin@example.test']);
  const set = platformMail({ PULSE_PUBLIC_URL: 'https://app.other.test', PULSE_MAIL_FROM: 'Pulse@Other.test', PULSE_GOOGLE_DOMAIN: 'other.test', PULSE_MAIL_STAGING_ALLOW: 'a@other.test, bad' });
  assert.equal(set.mailFrom, 'pulse@other.test');
  assert.equal(set.clientMailFrom, 'admin@other.test');
  assert.deepEqual(set.mailStagingAllow, ['a@other.test']);
  assert.equal(vapidSubject({ PULSE_PUBLIC_URL: 'https://pulse.example.test' }), 'https://pulse.example.test');
});

test('one vocabulary: neutral by default, the company says "Pod", its own words win', () => {
  assert.equal(workLabels('agency').team, 'Team');
  assert.equal(workLabels('agency').teams, 'Teams');
  assert.deepEqual(orgVocabulary(undefined), { client: 'Client', clients: 'Clients', project: 'Project', projects: 'Projects', run: 'Run', runs: 'Runs', team: 'Team', teams: 'Teams', lead: 'Lead', leads: 'Leads' });
  assert.equal(orgVocabulary('product').client, 'Customer');
  const pod = orgVocabulary('agency', 'Pod');
  assert.equal(pod.team, 'Pod'); assert.equal(pod.teams, 'Pods');
  const own = orgVocabulary('agency', 'Pod', { team: 'Crew', client: 'Buyer', clients: 'Buyers', project: '  ' });
  assert.equal(own.team, 'Crew'); assert.equal(own.teams, 'Crews'); assert.equal(own.client, 'Buyer'); assert.equal(own.project, 'Project');
});

test("a project's registry number is in the company's code, never another company's", () => {
  assert.equal(registry(42), '#0042');
  assert.equal(registry(42, 'ACR'), 'ACR-0042');
  assert.equal(registry(null), null);
});

test('the tenant-neutral check counts company literals outside comments only', () => {
  const ts = countFile(['// EA comment, estateautopilots.com', 'const a = "EA-0042"; // EA', '/* Kazuk', ' still a comment EA */ const b = "Kazuk";',
    'const c = "EA_CREATIVE ea_hold PEAK TEAM"; const u = "https://x.test//EA";', 'const ok = "EA"; // tenant-neutral:allow (config)'].join('\n'), false);
  assert.deepEqual(ts.n, { domain: 0, ea: 1, name: 1, pod: 0 });
  const py = countFile('# EA only here\nx = "hr@estateautopilots.com"  # EA\n', true);
  assert.deepEqual(py.n, { domain: 1, ea: 0, name: 0, pod: 0 });
  const web = countFile(['type P = Pod[]; const x: Pod = y;', '<th>Pod</th><b>No pods</b>', 'title="Pods side by side" key={"pod"}', '{/* Pod in a comment */}'].join('\n'), false, true);
  assert.equal(web.n.pod, 2, 'JSX text and a human string; never a type name, a key or a comment');
});
