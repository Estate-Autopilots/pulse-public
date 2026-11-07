// FLOW-D: "Describe it": Pip's draft of a process from someone's own words (src/flow/describe.ts, pure).
import assert from 'node:assert/strict';
import test from 'node:test';
import { draftFromText } from '../dist/flow/describe.js';
import { normalizeFlow, problems } from '../dist/flow/model.js';

test('a solar job in plain words becomes primitives, in order, with who and when', () => {
  const text = 'When a new lead comes in, the sales executive calls them within 1 day. Then the site surveyor visits the site and takes photos of the roof and the meter. '
    + 'The sales executive sends the quotation within 2 days. If the customer approves, the install team installs the panels; otherwise the sales executive follows up. '
    + 'Accounts makes the tax invoice. Tell the owner on WhatsApp. Done.';
  const d = draftFromText(text, 'Solar', ['Sales executive']);
  const def = normalizeFlow(d.definition);
  const blocks = def.steps.map((s) => `${s.block}:${s.module}`);
  assert.deepEqual(blocks.slice(0, 6), ['start:lead_capture', 'meet:meeting', 'collect:site_visit', 'app:quotation', 'decide:decision', 'task:checklist']);
  assert.ok(blocks.includes('app:tax_invoice') && blocks.includes('message:message') && blocks.at(-1) === 'end:end', blocks.join(' '));
  const call = def.steps[1]; assert.equal(call.who.by, 'role'); assert.equal(def.roles.find((r) => r.key === call.who.role)?.label, 'Sales executive'); assert.equal(call.due?.days, 1);
  const visit = def.steps[2]; assert.equal(def.roles.find((r) => r.key === visit.who.role)?.label, 'Site surveyor');
  const decide = def.steps.find((s) => s.block === 'decide');
  assert.ok(def.wires.some((w) => w.from.step === decide.id && w.from.port === 'yes') && def.wires.some((w) => w.from.step === decide.id && w.from.port === 'no'));
  assert.equal(problems(def).filter((p) => p.level === 'error').length, 0, JSON.stringify(problems(def)));
  assert.ok(d.notes[0].includes('steps'));
});

test('a numbered list with stages and sub-points: stages, steps and their checklists', () => {
  const text = 'Stage 1: Onboarding\n1. Kick-off call with the client\n   - Agree the timeline\n   - Name the approver\n2. The strategist writes the brief within 3 days\nStage 2: Delivery\n3. The client approves the brief\n4. Wait 2 days\n5. Send the final files';
  const def = normalizeFlow(draftFromText(text, 'Agency', []).definition);
  assert.deepEqual(def.stages.map((s) => s.label), ['Onboarding', 'Delivery']);
  const call = def.steps.find((s) => s.block === 'meet'); assert.deepEqual(call.checklist, ['Agree the timeline', 'Name the approver']);
  assert.ok(def.steps.some((s) => s.block === 'review' && s.module === 'approval'));
  const wait = def.steps.find((s) => s.block === 'wait'); assert.equal(wait.settings.hours, 48);
  assert.ok(def.steps.some((s) => s.block === 'write' && s.due?.days === 3));
});
