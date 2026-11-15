// UX-PEOPLE: the permissions matrix reads roles and grants the way the service enforces them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessWords, capability, CAPABILITIES, named, planBulk, profile, workRole } from "./access-matrix.mjs";

const cap = (k) => CAPABILITIES.find((c) => c.key === k);
const holders = [{ personId: "a", role: "admin" }, { personId: "h", role: "hr" }, { personId: "m", role: "manager" }, { personId: "l", role: "leadership" }, { personId: "l", role: "admin" }];

test("a capability is the widest any held role gives, and says which role", () => {
  assert.equal(capability(cap("work"), []).level, "no");
  assert.deepEqual(capability(cap("work"), ["manager"]), { level: "part", text: "Their team", from: "manager" });
  assert.equal(capability(cap("work"), ["manager", "leadership"]).from, "leadership");
  assert.equal(capability(cap("access"), ["hr", "leadership"]).level, "no");
  assert.equal(capability(cap("money"), ["admin"]).level, "no");
  assert.equal(capability(cap("money"), ["admin"]).text, "Only with Leadership");
  assert.equal(capability(cap("money"), ["admin", "leadership"]).level, "yes");
  assert.equal(capability(cap("money"), ["finance"]).text, "Billing only");
});

test("named HR permissions: by role off the named list, by grant on it, a grant without a role does nothing", () => {
  assert.equal(named("hr.salary.read", ["hr"], [], false).text, "By role");
  assert.equal(named("hr.salary.read", ["hr"], [], true).level, "no");
  assert.equal(named("hr.contact.read", ["hr"], [], true).text, "By role");
  assert.equal(named("hr.salary.read", ["admin"], [], false).level, "no");
  assert.equal(named("hr.salary.read", ["admin"], [{ permission: "hr.salary.read", effective: true }], true).text, "Granted");
  assert.equal(named("hr.salary.read", [], [{ permission: "hr.salary.read", effective: false }], false).level, "idle");
});

test("work-rule column: leadership and admins, HR, pod heads (role or reports), members", () => {
  assert.equal(workRole(["admin"], false), "leadership");
  assert.equal(workRole(["hr", "manager"], false), "hr");
  assert.equal(workRole(["pgs"], false), "pod_head");
  assert.equal(workRole([], true), "pod_head");
  assert.equal(workRole(["finance"], false), "member");
});

test("profile counts what a person can do", () => {
  const p = profile({ id: "l" }, holders, [], false);
  assert.deepEqual(p.roles.sort(), ["admin", "leadership"]);
  assert.ok(p.can >= CAPABILITIES.length);
  assert.equal(profile({ id: "x" }, holders, [], false).can, 0);
});

test("bulk changes leave out what would change nothing or what the service refuses for a known reason", () => {
  const people = [{ id: "a", name: "A", pod: null }, { id: "h", name: "H", pod: "Pod 1" }, { id: "z", name: "Z", pod: null }];
  const give = planBulk(people, holders, "grant", "manager", "a");
  assert.deepEqual(give.plan.map((x) => x.personId), ["h"]);
  assert.equal(give.skipped.length, 2);
  const take = planBulk(people, holders, "revoke", "admin", "a");
  assert.deepEqual(take.plan, []);
  assert.match(take.skipped.find((s) => s.person.id === "a").why, /own admin/);
});

test("DE-EA: the matrix says the company's own team word", () => {
  const pod = accessWords({ team: "Pod", teams: "Pods" });
  assert.equal(pod.TEMPLATE.head_pgs.title, "Pod leads");
  assert.equal(capability(pod.CAPABILITIES.find((c) => c.key === "work"), ["manager"]).text, "Their pod");
  assert.equal(accessWords(null).TEMPLATE.head_pgs.title, "Team leads");
  const skipped = pod.planBulk([{ id: "z", name: "Z", pod: null }], [], "grant", "manager", null).skipped;
  assert.equal(skipped[0].why, "needs a pod first");
  assert.ok(!/{team/i.test(JSON.stringify(accessWords(null))));
});
