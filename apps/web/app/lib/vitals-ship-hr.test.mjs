// VITALS-SHIP (owner, 24 Nov 2026): HR and pay bugs from the tutorial and HR-leave lanes, on Approvals.
// Source-level, like the other app/lib tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const repo = (rel) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");

test("Approvals names a leave the way the company does (\"Paid leave\"), not by its key (\"Annual leave\")", () => {
  const api = repo("services/api/src/hr-flow.ts");
  assert.match(api, /case when f\.kind='leave' then \(select t\.name from pulse\.leave_request l join pulse\.leave_type t on t\.org_id=l\.org_id and t\.key=l\.leave_kind where l\.id=f\.source_id\) end "leaveName"/);
  assert.match(read("hr/flow-types.ts"), /leaveName\?:string\|null;/);
  const web = read("hr/flow-actions.tsx");
  assert.match(web, /if\(f\.kind==='leave'&&f\.leaveName\?\.trim\(\)\)return f\.leaveName\.trim\(\);/);
  assert.ok(web.indexOf("f.leaveName?.trim()") < web.indexOf("const k=f.subject.replace(/ leave$/,'')"), "the company's name comes before the key's words");
});

test("Approvals lists the pay decisions waiting for this founder, and counts them", async () => {
  const page = read("me/approvals/page.tsx");
  assert.match(page, /api<PeopleData>\('comp\/people'\)/, "People & pay's own list, without figures (no logged look)");
  assert.doesNotMatch(page, /comp\/people\?figures/);
  assert.match(page, /const payWaiting=pay\.data\?\.can\?\.approve\?payDecisions\(pay\.data\.people\):\[\];/);
  assert.match(page, /\+addsWaiting\+payWaiting\.length,/, "the Waiting for you tile counts them");
  assert.match(page, /<PayWaiting rows=\{payWaiting\}\/>/);
  const src = read("me/approvals/pay-waiting.tsx");
  for (const key of ["offer.proposed", "change.proposed", "pause.proposed", "probation.outcome", "settlement.checked"]) assert.ok(src.includes(`'${key}'`), key);
  assert.match(src, /p\.next\?\.tone === 'act' && DECIDE\.has\(p\.next\.key\)/, "only decisions this viewer can take");
  assert.match(src, /\?do=\$\{encodeURIComponent\(p\.action\.key\)\}/, "Review opens the person's own Review");
  // The decision keys must still be what the API says (comp-model.ts nextEvent).
  const model = repo("services/api/src/comp-model.ts");
  for (const key of ["offer.proposed", "change.proposed", "pause.proposed", "probation.outcome", "settlement.checked"]) assert.ok(model.includes(`key: "${key}"`), `the API still has ${key}`);
});

test("HR cannot forward a request to a co-founder when none is assigned (it would be stuck: nobody can decide it)", () => {
  const api = repo("services/api/src/hr-flow.ts");
  assert.match(api, /if\(action==='forward'&&!\(await c\.query\('select exists\(select 1 from pulse\.hr_cofounder where active and person_id<>\$1\) ok',\[f\.person_id\]\)\)\.rows\[0\]\.ok\)\s*\n\s*fail\(409,'No co-founder is assigned to take it\./);
  assert.ok(api.indexOf("action==='forward'&&!(await") < api.indexOf("select pulse.hr_flow_decide($1,$2,$3)"), "refused before the request moves");
  assert.match(api, /cofounder,cofounders\};/, "the queue says how many co-founders can take one");
  assert.match(read("hr/flow-actions.tsx"), /\{data\.staff&&f\.stage!=='cofounder'&&data\.cofounders!==0\?<button[^>]*>/, "the button is not offered when nobody can take it");
});
