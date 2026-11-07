// SELF-SERVE: the two sign-up answers cleaned into the space's setup (services/api/src/self-serve-setup.ts), the web's
// catalogue keeps the same keys, and the client invitation. (The mail route is MAIL-IDENTITY: mail-identity.test.mjs.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MODULE_KEYS } from "../dist/modules.js";
import { PROFILE_KEYS, SERVED_KEYS, SPACES, SPACE_KEYS, practiceInviteMail, setupPlan } from "../dist/self-serve-setup.js";

test("a psychologist's practice: clients (or patients), sessions, money and chats on, its client types, starter and cards", () => {
  const p = setupPlan({ profiles: ["professional"], space: "practice", orgName: "  Omoza   Pesub Practice ", timeZone: "Asia/Kolkata" }, "Omoza Pesub");
  assert.equal(p.name, "Omoza Pesub Practice");
  assert.deepEqual(p.templates, ["space:practice"]);
  assert.equal(p.pack.words.clients, "Clients"); assert.equal(p.pack.words.runs, "Sessions");
  assert.deepEqual(p.companyModules, { chats: true, finance: true });
  assert.ok(p.modulesDoc.off.includes("acquisition") && p.modulesDoc.off.includes("hr") && !p.modulesDoc.off.includes("money"));
  assert.ok(p.modulesDoc.off.every((k) => MODULE_KEYS.includes(k)));
  assert.deepEqual(p.starters.map((s) => s.name), ["Set up my practice"]);
  assert.deepEqual(p.setup.cards.map((c) => c.key), ["client", "appointment", "invoice", "words", "app"]);
  assert.equal(p.setup.cards[0].label, "Add your first client"); assert.equal(p.setup.cards[0].href, "/clients/add");
  assert.deepEqual(p.setup.clientTypes.map((t) => t.key), ["individual", "couple_family", "organisation"]);
  assert.equal(p.setup.home, "/dashboard");
  const patients = setupPlan({ profiles: ["professional"], space: "practice", orgName: "Mind Clinic", served: "patients" }, "Omoza");
  assert.equal(patients.pack.words.client, "Patient"); assert.equal(patients.setup.cards[0].label, "Add your first patient");
  assert.match(patients.setup.cards.find((c) => c.key === "words").note, /patients/);
});

test("a personal space: named after the person, starters for each of their types, no chats, My day home", () => {
  const p = setupPlan({ profiles: ["student", "creator"], space: "personal", orgName: "ignored" }, "Rila Shah");
  assert.equal(p.name, "Rila Shah's Pulse");
  assert.deepEqual(p.starters.map((s) => s.name), ["My studies", "Content calendar"], "one per type, in the order chosen");
  assert.deepEqual(p.companyModules, { chats: false, finance: false });
  assert.equal(p.setup.home, "/my-day"); assert.deepEqual(p.setup.cards.map((c) => c.key), ["todo", "project", "app"]);
  assert.deepEqual(p.workDays, [1, 2, 3, 4, 5, 6, 7]);
  // A freelancer's own space keeps money (quotes and invoices) on.
  assert.equal(setupPlan({ profiles: ["freelancer"], space: "personal" }, "Kabir").companyModules.finance, true);
  assert.deepEqual(setupPlan({ profiles: ["other"], space: "personal" }, "Kabir").starters.map((s) => s.name), ["My plans"]);
});

test("every kind of organisation sets up without refusal, with words for the people it serves", () => {
  const expect = { practice: "Clients", agency: "Clients", shop: "Customers", maker: "Dealers", real_estate: "Buyers", school: "Students", ngo: "Donors", other: "Clients" };
  for (const s of SPACES.filter((x) => x.key !== "personal")) {
    const p = setupPlan({ profiles: ["owner"], space: s.key, orgName: `Synthetic ${s.label}` }, "Synthetic Owner");
    assert.ok(!("error" in p), `${s.key}: ${p.error}`);
    assert.equal(p.pack.words.clients, expect[s.key], s.key);
    assert.ok(p.starters.length >= 1 && p.starters.every((x) => x.steps.length >= 3 && x.steps.length <= 12), s.key);
    assert.ok(p.setup.cards.length >= 3 && p.setup.cards.length <= 8 && p.setup.cards.every((c) => c.href.startsWith("/")), s.key);
    assert.ok(p.setup.clientTypes.every((t) => /^[a-z][a-z0-9_]{1,39}$/.test(t.key) && t.label.length >= 2), s.key);
  }
  assert.equal(setupPlan({ profiles: ["owner"], space: "real_estate", orgName: "Synthetic Homes" }, "x").pack.key, "real_estate_developer");
  // A creator running an agency also gets the content calendar.
  assert.deepEqual(setupPlan({ profiles: ["creator", "owner"], space: "agency", orgName: "Synthetic Studio" }, "x").starters.map((s) => s.name), ["First client project", "Content calendar"]);
});

test("refusals are plain sentences", () => {
  for (const [b, re] of [[{ profiles: [], space: "personal" }, /describes you/], [{ profiles: ["astronaut"], space: "personal" }, /listed kinds/],
    [{ profiles: ["owner"], space: "casino" }, /use Pulse for/], [{ profiles: ["owner"], space: "shop", orgName: "x" }, /name of 2 to 80/],
    [{ profiles: ["owner"], space: "shop", orgName: "Shop", served: "aliens" }, /people you serve/], [{ profiles: ["owner"], space: "shop", orgName: "Shop", timeZone: "Mars; drop" }, /time zone/]])
    assert.match(setupPlan(b, "Synthetic Person").error, re);
  assert.match(setupPlan({ profiles: ["student"], space: "personal" }, "").error, /your name/);
});

test("the web's catalogue has the same keys", () => {
  const web = readFileSync(new URL("../../../apps/web/app/signup/setup-catalogue.ts", import.meta.url), "utf8");
  const keys = (block) => [...web.slice(web.indexOf(`export const ${block}`)).split("] as const")[0].matchAll(/key: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys("PROFILES"), [...PROFILE_KEYS]);
  assert.deepEqual(keys("SPACES"), [...SPACE_KEYS]);
  assert.deepEqual(keys("SERVED"), [...SERVED_KEYS]);
});

test("the client's invitation names the professional and promises no password", () => {
  const m = practiceInviteMail({ org: "Omoza Pesub Practice", by: "Omoza Pesub", contact: "Asha Rao", link: "https://pulse.example/invited#t", message: "See you Tuesday." });
  assert.equal(m.subject, "Omoza Pesub has set up your space on Pulse");
  assert.match(m.body, /^Hi Asha,/); assert.match(m.body, /appointments, files, invoices and messages/); assert.match(m.body, /no password needed/);
  assert.match(m.body, /See you Tuesday\./); assert.match(m.body, /https:\/\/pulse\.example\/invited#t/);
});
