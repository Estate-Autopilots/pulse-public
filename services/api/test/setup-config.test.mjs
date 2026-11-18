// ONBOARD-CONFIG (owner, 13 Nov 2026, G3 T3.1.2): reading a transcript into a company setup, by plain rules on the
// company's own server. Synthetic sources only (no real company's words or people).
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanProposal, dateIn, diff, extractSetup, prepare, rolesFrom, wordsFrom } from '../dist/setup-config.js';
import { wordsOf } from '../dist/flow/packs.js';

const PODCAST = `Host: So how is the agency set up?
Guest: We work in pods. Each pod has a pod head, a growth strategist and two designers. The pod head reports to me.
Our pods sit in two departments, the Creative department and the Performance department. The sales team is separate.
Every customer gets one pod. We onboard a customer in a week; our customers are developers mostly.
First we sign the customer, then the growth strategist writes the blueprint, after that the designers make the first set, and finally the pod head reviews it with the customer.
Our goal is to sign 20 customers by 31 March 2027. We also run campaigns: every campaign has a growth strategist and a designer.
The growth strategist owns the campaign. A designer makes the creatives for every campaign. A campaign runs for six weeks.
We started a project called Atlas Launch for our own brand.`;

test('the words a company uses: its team word, who leads one, a group of teams, its clients and projects', () => {
  const { words, evidence } = wordsFrom(prepare(PODCAST));
  assert.equal(words.team, 'Pod'); assert.equal(words.teams, 'Pods');
  assert.equal(words.head, 'Head'); assert.equal(words.heads, 'Heads');
  assert.equal(words.department, 'Department'); assert.equal(words.departments, 'Departments');
  assert.equal(words.client, 'Customer'); assert.equal(words.clients, 'Customers');
  assert.equal(words.project, 'Campaign'); assert.equal(words.projects, 'Campaigns');
  assert.equal(words.lead, undefined, 'no sales-lead word is proposed from "pod head" or "to lead"');
  assert.ok(evidence.some((e) => e.what.startsWith('A team is called') && e.seen >= 2));
});

test('a source read into teams, roles, a workflow, a goal with its date and a project', () => {
  const { proposal } = extractSetup(PODCAST, 'public');
  const teams = proposal.teams.map((t) => `${t.name}:${t.kind}`);
  assert.ok(teams.includes('Creative:department') && teams.includes('Performance:department') && teams.includes('Sales:team'), teams.join(', '));
  const roles = proposal.roles.map((r) => r.name);
  for (const r of ['Pod head', 'Growth strategist', 'Designer']) assert.ok(roles.includes(r), `${r} in ${roles.join(', ')}`);
  const flow = proposal.workflows[0];
  assert.ok(flow && flow.steps.length === 4, JSON.stringify(proposal.workflows));
  assert.equal(flow.steps[1].role, 'Growth strategist');
  assert.equal(proposal.goals[0].title, 'Sign 20 customers by 31 March 2027');
  assert.equal(proposal.goals[0].targetOn, '2027-03-31');
  assert.ok(proposal.projects.some((p) => p.name === 'Atlas Launch'), JSON.stringify(proposal.projects));
});

test('a private source keeps its words out of goals', () => {
  const md = '# Meeting\n\n## 1. The goal\n\n**Ship the seller journey to invited users.**\n\n- **Why it matters:** the partner pitches it to clients now, in his words.\n- **Target (proposal):** 20 Nov 2026.\n';
  const pub = extractSetup(md, 'public').proposal.goals[0], priv = extractSetup(md, 'private').proposal.goals[0];
  assert.equal(pub.title, 'Ship the seller journey to invited users');
  assert.equal(pub.targetOn, '2026-11-20');
  assert.ok(pub.why?.includes('pitches'));
  assert.equal(priv.title, pub.title); assert.equal(priv.why, undefined);
});

test('a flow written with arrows, and Marathi loan words in Devanagari', () => {
  const { proposal } = extractSetup('D4. The seller\'s flow: open the app → see today\'s work → call the lead → fill in the outcome.', 'private');
  assert.deepEqual(proposal.workflows[0].steps.map((s) => s.title), ['Open the app', 'See today\'s work', 'Call the lead', 'Fill in the outcome']);
  assert.equal(proposal.workflows[0].name, 'The seller\'s flow');
  const t = prepare('आमच्या पॉड मध्ये तीन लोक. प्रत्येक पॉड ला एक क्लायंट. क्लायंट खूप. क्लायंट नवीन. पॉड हेड ठरवतो.');
  const w = wordsFrom(t).words;
  assert.equal(w.team, 'Pod'); assert.equal(w.head, 'Head');
});

test('roles need a word before head or lead; dates in three forms', () => {
  const r = rolesFrom(prepare('The head said so. A lead came in. The head again. Another lead. Our sales head and the sales head agreed.')).map((x) => x.name);
  assert.deepEqual(r, ['Sales head']);
  assert.equal(dateIn('by 2026-12-01'), '2026-12-01');
  assert.equal(dateIn('by December 5, 2026'), '2026-12-05');
  assert.equal(dateIn('by 5th Dec 2026'), '2026-12-05');
  assert.equal(dateIn('soon'), undefined);
});

test('a sent proposal is cleaned: known word keys only, trimmed, de-duplicated, steps required', () => {
  const p = cleanProposal({ words: { team: '  Squad ', teams: 'Squads', bogus: 'x' }, teams: [{ name: 'Ops' }, { name: 'ops' }], roles: [{ name: 'Editor' }, { name: 'editor' }],
    workflows: [{ name: 'Empty', steps: [] }, { name: 'Edit', steps: [{ title: 'Cut' }, { title: '' }] }], goals: [{ title: 'Grow', targetOn: 'soon' }], docs: [{ title: 'Notes', markdown: '' }] });
  assert.deepEqual(p.words, { team: 'Squad', teams: 'Squads' });
  assert.equal(p.teams.length, 1); assert.equal(p.teams[0].kind, 'team'); assert.equal(p.roles.length, 1);
  assert.deepEqual(p.workflows, [{ name: 'Edit', steps: [{ title: 'Cut' }] }]);
  assert.deepEqual(p.goals, [{ title: 'Grow' }]); assert.deepEqual(p.docs, []);
});

test('the diff says add, change or same against what the company has; a private source goes to the private folder', () => {
  const have = { words: wordsOf({ team: 'Pod', teams: 'Pods' }), teams: new Map([['creative', { id: 'x', name: 'Creative', kind: 'department' }]]), roles: new Map([['designer', 'r']]),
    workflows: new Map(), goals: new Map(), projects: new Map(), docs: new Map() };
  const p = cleanProposal({ words: { team: 'Pod', client: 'Customer' }, teams: [{ name: 'Creative', kind: 'department' }, { name: 'Sales' }], roles: [{ name: 'Designer' }, { name: 'Editor' }] });
  const items = diff(p, have, { from: 'talk.md', cls: 'private' });
  const by = (s, n) => items.find((i) => i.section === s && i.name === n);
  assert.equal(by('words', 'team').change, 'same');
  assert.equal(by('words', 'client').change, 'change'); assert.equal(by('words', 'client').detail, 'Client → Customer');
  assert.equal(by('teams', 'Creative').change, 'same'); assert.equal(by('teams', 'Sales').change, 'add');
  assert.equal(by('roles', 'Designer').change, 'same'); assert.equal(by('roles', 'Editor').change, 'add');
  assert.match(by('docs', 'Source: talk.md').detail, /Private sources, open only to you/);
});

test('a group of teams nobody named follows the team word; a chosen one stays', () => {
  assert.equal(wordsOf({}).department, 'Department');
  assert.equal(wordsOf({ team: 'Pod' }).department, 'Team');
  assert.equal(wordsOf({ team: 'Pod', department: 'Vertical', departments: 'Verticals' }).departments, 'Verticals');
});

test('a meeting write-up: its title mentions goals and projects in passing; the Goal and Projects sections decide', () => {
  const md = ['# Synthetic team x partner meeting, 1 Jan 2026: everything said, sorted into one goal, projects and tasks', '',
    'The source is a synthetic transcript, read line by line.', '',
    '## 1. The goal', '', '**The seller app is ready for invited people: one finished seller journey, the coaching loop, and a landing page that can take paid ads.**', '',
    '- **Target (proposal):** 20 Jan 2026.', '', '## 2. Decisions', '', '| D4 | The first flow is the seller\'s: open the app → see today\'s work → call → fill in the outcome. |', '',
    'The production app stays up. The production build is slow. In production we log. Production keys rotate. Production data is synthetic.', '',
    '## 4. Projects, tasks and subtasks', '', '### P1. Demo tomorrow: two screens run smoothly', '', '#### T-A1 Fix the report screen', '',
    '### P2. Websites', '', '- T-W1 (S) Seller flow: open → read → reply', '', '## 5. How we work', ''].join('\n');
  const { proposal: p } = extractSetup(md, 'private');
  assert.deepEqual(p.goals.map((g) => [g.title, g.targetOn]), [['The seller app is ready for invited people', '2026-01-20']]);
  assert.deepEqual(p.projects.map((x) => x.name), ['Demo tomorrow: two screens run smoothly', 'Websites']);
  assert.equal(p.projects[0].goal, 'The seller app is ready for invited people');
  assert.equal(p.words.project, undefined, '"the production app" is not what they call a project');
  assert.deepEqual(p.workflows.map((w) => [w.name, w.steps.length]), [["The first flow is the seller's", 4], ['Seller flow', 3]]);
});
