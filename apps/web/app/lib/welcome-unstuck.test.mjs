// BUGFIX #21 (31 Oct 2026, "Vitals OS | Bugs | EA"): on the onboarding documents step the person saw "Still to add"
// and no button to go ahead. WELCOME-UNSTUCK (4 Nov) fixed it; nothing pinned it. These checks fail on the old wizard,
// whose gated "Nearly there" footer was `: null` while anything was missing, and on a gate that waits for ID documents.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");
/** The JSX of one wizard step, from `current === "<key>"` up to the next step's branch. */
const stepJsx = (wizard, key) => {
  const start = wizard.indexOf(`{current === "${key}" ?`);
  assert.ok(start >= 0, `the wizard renders the ${key} step`);
  const end = wizard.indexOf("{current === ", start + 1);
  return wizard.slice(start, end < 0 ? wizard.indexOf("</div>\n  );", start) : end);
};

test("the last setup screen always has a button forward, also while something is still to add", async () => {
  const wizard = await source("../welcome/wizard.tsx");
  const done = stepJsx(wizard, "done");
  const foot = done.slice(done.indexOf("foot={"), done.indexOf("<ol"));
  assert.ok(foot.length > 0, "the done step has a footer");
  // Gated and not complete: the old wizard rendered nothing here.
  assert.doesNotMatch(foot, /Open Pulse<\/button>\s*:\s*null\s*\)/, "no empty footer while something is missing");
  assert.match(foot, /complete \? <button[^>]*onClick=\{leave\}>Open Pulse<\/button>\s*:\s*<button[^>]*onClick=\{\(\) => go\(stepFor\(/);
  assert.match(foot, />Continue setup<\/button>/);
  // Not gated: a link onwards either way.
  assert.match(foot, />Check in now<\/Link>\s*:\s*<Link[^>]*>Open My desk<\/Link>/);
  // Every missing item leads to the step that fills it in; Aadhaar, PAN and the photo are all on Documents.
  assert.match(wizard, /const stepFor = \(k: string\): StepKey => k\.startsWith\("doc:"\) \|\| k === "photo" \? "documents"/);
});

test("the Documents step always offers Continue and Later, also while Pulse is still closed", async () => {
  const wizard = await source("../welcome/wizard.tsx");
  // `later` is null while gated; Documents gets `optional` so "Later" is always there.
  assert.match(stepJsx(wizard, "documents"), /<Documents [^>]*onDone=\{\(\) => void save\(null\)\} later=\{optional\} \/>/);
  const docs = wizard.slice(wizard.indexOf("function Documents("), wizard.indexOf("function PhotoCard("));
  assert.match(docs, /foot=\{<><button type="button" className=\{`\$\{styles\.btn\} \$\{styles\.btnPrimary\}[^`]*`\} disabled=\{busy\} onClick=\{onDone\}>\{pending \? "Continue" : "Done"\}<\/button>\{later\}<\/>\}/);
});

test("missing ID documents never keep Pulse closed (the gate waits only for the profile)", async () => {
  const gate = await source("../../../../db/migrations/1466_gate_documents_later.sql");
  assert.match(gate, /core:=coalesce\(\(select array_agg\(x\) from unnest\(m\) x where x not like 'doc:%'\),'\{\}'\);/);
  assert.match(gate, /'blocked',cardinality\(core\)>0/);
  assert.match(gate, /'later',to_jsonb\(coalesce\(\(select array_agg\(x\) from unnest\(m\) x where x like 'doc:%'\),'\{\}'\)\)/);
});
