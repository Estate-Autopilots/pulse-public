// ONBOARD-SELF: the wizard's answers cleaned into the one payload pulse.onboard_org writes (services/api/src/self-serve-model.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { MODULE_KEYS } from "../dist/modules.js";
import { CHECKLIST, SEATS, TEMPLATES, inviteMail, onboardingPlan, parseEmails } from "../dist/self-serve-model.js";

test("a plan from templates brings their modules, starter projects and pack", () => {
  const p = onboardingPlan({ name: "  NeetiCRM  ", handle: "@NeetiCRM", templates: ["sales", "software", "sales"] });
  assert.equal(p.name, "NeetiCRM"); assert.equal(p.handle, "neeticrm");
  assert.deepEqual(p.templates, ["sales", "software"]);
  assert.deepEqual(p.starters.map((s) => s.name), ["Sales pipeline", "Product roadmap"]);
  assert.ok(p.starters.every((s) => s.steps.length >= 3 && s.steps.length <= 12));
  assert.deepEqual(p.companyModules, { chats: true, finance: true });
  assert.ok(!p.modulesDoc.off.includes("acquisition") && p.modulesDoc.off.includes("hr") && p.modulesDoc.off.includes("designers"));
  assert.ok(p.modulesDoc.off.every((k) => MODULE_KEYS.includes(k)));
  assert.deepEqual([p.workDays, p.dayStart, p.dayEnd, p.timeZone], [[1, 2, 3, 4, 5], "09:30", "18:30", ""]);
  assert.equal(p.pack.key, "neutral");
  assert.equal(onboardingPlan({ name: "Studio", templates: ["agency"] }).pack.key, "marketing_agency");
});

test("modules picked by hand win over the templates' own", () => {
  const p = onboardingPlan({ name: "Ruvin Traders", templates: ["sales"], modules: ["hr"] });
  assert.deepEqual(p.companyModules, { chats: false, finance: false });
  assert.ok(p.modulesDoc.off.includes("acquisition") && p.modulesDoc.off.includes("chats") && !p.modulesDoc.off.includes("hr"));
});

test("refusals are plain sentences, and an address is never part of a plan", () => {
  for (const [body, re] of [[{ name: "x", templates: ["general"] }, /name/], [{ name: "Acme" }, /what your company does/], [{ name: "Acme", templates: ["casino"] }, /listed kinds/],
    [{ name: "Acme", templates: ["general"], modules: ["payroll"] }, /listed modules/], [{ name: "Acme", templates: ["general"], workDays: [] }, /working day/],
    [{ name: "Acme", templates: ["general"], dayStart: "18:00", dayEnd: "09:00" }, /hours/], [{ name: "Acme", templates: ["general"], timeZone: "Mars; drop" }, /time zone/]])
    assert.match(onboardingPlan(body).error, re);
  const p = onboardingPlan({ name: "Acme", templates: ["general"], host: "acme.com", domain: "acme.com", slug: "x" });
  assert.equal(JSON.stringify(p).includes("acme.com"), false);
});

test("bulk e-mails: any separator, names around them, each once", () => {
  assert.deepEqual(parseEmails("Asha <user-3eeffa7a@org-e6abb3.example>, user-bc0866ba@org-e6abb3.example; user-bc0866ba@org-e6abb3.example\nmailto:user-eba11515@org-e6abb3.example nope@ x"), { emails: ["user-3eeffa7a@org-e6abb3.example", "user-bc0866ba@org-e6abb3.example", "user-eba11515@org-e6abb3.example"], invalid: ["nope@"] });
});

test("seats say what they will and won't see; the invitation mail carries it and the sign-in path", () => {
  assert.deepEqual(SEATS.map((s) => s.key), ["leadership", "manager", "staff", "sales", "freelancer", "client"]);
  assert.ok(SEATS.every((s) => s.sees.length && s.wont.length && s.tips.length >= 3));
  assert.deepEqual(CHECKLIST.map((c) => c.key), ["invite", "project", "targets", "app"]);
  assert.equal(TEMPLATES.length, 5);
  const m = inviteMail({ org: "NeetiCRM", by: "Neeti", seat: "freelancer", link: "https://pulse.example/join#t", hasAccount: true });
  assert.equal(m.title, "Neeti invited you to NeetiCRM on Pulse");
  assert.match(m.body, /as freelancer/); assert.match(m.body, /You won't see: Salaries/); assert.match(m.body, /already has a Pulse account: sign in/);
});
