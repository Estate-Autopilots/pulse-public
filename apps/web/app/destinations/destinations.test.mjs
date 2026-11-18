// UX-5B: the destinations registry stays true to the app. A destination whose page, tab, anchor or event disappears
// fails here, before anyone is sent somewhere that no longer exists.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESTINATIONS, EVENTS, canSee, destForHref, destination, goHref, matchDestinations, placesIn } from "./registry.mjs";
import { proposeFor, specificPlace, targetFor, titleMayRoute } from "./propose.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(APP, "..", "..", "..");
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (f === "node_modules" || f.startsWith(".")) return [];
  return statSync(p).isDirectory() ? files(p) : /\.(tsx?|mjs)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
});
const SOURCES = files(APP).filter((p) => !p.includes(`${join("app", "destinations")}`)).map((p) => ({ p, text: readFileSync(p, "utf8") }));

/** The app folder that serves a path ("/people/org" → app/people/org), or null. */
function routeDir(path) {
  const dir = join(APP, ...path.split("/").filter(Boolean));
  return existsSync(join(dir, "page.tsx")) ? dir : null;
}

test("ids are unique, parents exist and hrefs are routes", () => {
  const ids = new Set();
  for (const d of DESTINATIONS) {
    assert.ok(!ids.has(d.id), `duplicate id ${d.id}`); ids.add(d.id);
    assert.match(d.id, /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/, `id ${d.id} is dotted lowercase`);
    assert.ok(d.href.startsWith("/") && !d.href.includes("#"), `${d.id}: href is a path without #hash`);
    if (d.parent) assert.ok(destination(d.parent), `${d.id}: parent ${d.parent} exists`);
    assert.ok(d.path.length >= 1 && d.label, `${d.id}: has a label and a path`);
    assert.ok(routeDir(d.href.split("?")[0]), `${d.id}: ${d.href} has a page`);
  }
});

test("every tab's query keys are read by its page", () => {
  for (const d of DESTINATIONS.filter((x) => x.href.includes("?"))) {
    const dir = routeDir(d.href.split("?")[0]);
    const text = files(dir).map((p) => readFileSync(p, "utf8")).join("\n");
    for (const [key, value] of new URLSearchParams(d.href.split("?")[1])) {
      assert.ok(new RegExp(`["'\`]${value.replace(/[-]/g, "\\-")}["'\`]`).test(text), `${d.id}: the page under ${dir} never names ${key}=${value}`);
    }
  }
});

test("every section and control is marked on its page", () => {
  for (const d of DESTINATIONS.filter((x) => x.kind === "section" || x.kind === "control")) {
    const marked = SOURCES.some(({ text }) => text.includes(`dest("${d.id}")`) || text.includes(`data-dest="${d.id}"`));
    assert.ok(marked, `${d.id} (${d.label}) has no anchor: add {...dest("${d.id}")} to the element on ${d.href}`);
  }
});

test("every event is a registered type, and every destination's events are known", () => {
  const yaml = readFileSync(join(REPO, "packages", "schemas", "registry.yaml"), "utf8");
  for (const e of Object.keys(EVENTS)) assert.match(yaml, new RegExp(`^  ${e.replace(/\./g, "\\.")}:`, "m"), `${e} is not in registry.yaml`);
  for (const d of DESTINATIONS) {
    for (const e of d.events ?? []) assert.ok(e in EVENTS, `${d.id}: unknown event ${e}`);
    for (const s of d.signals ?? []) assert.ok(s.event in EVENTS, `${d.id}: unknown signal event ${s.event}`);
  }
});

test("links go there and tabs are found by their address", () => {
  assert.equal(goHref("hr.policies.presence.wifi", "t1"), "/hr?tab=policies&view=presence&go=hr.policies.presence.wifi&task=t1");
  assert.equal(destForHref("/hr?tab=policies&view=presence&go=x")?.id, "hr.policies.presence");
  assert.equal(destForHref("/hr?tab=attendance&month=2026-10&view=week")?.id, "hr.attendance");
  assert.equal(destForHref("/tasks/outcomes")?.id, "work.outcomes");
});

test("roles see what the rail shows them", () => {
  const presence = destination("hr.policies.presence");
  assert.ok(canSee(presence, { role: "HR" }) && canSee(presence, { role: "Organisation owner/admin" }));
  assert.ok(!canSee(presence, { role: "Employee" }));
  assert.ok(!canSee(presence, { role: "Organisation owner/admin", modulesOff: ["hr"] }));
  assert.ok(canSee(destination("me.attendance"), { role: "Employee" }));
});

test("places written in notes resolve through the registry", () => {
  const one = (t) => placesIn(t).map((p) => p.dest.id);
  assert.deepEqual(one("Add the office Wi-Fi and IP in Pulse → HR → Policies → Office presence"), ["hr.policies.presence"]);
  assert.deepEqual(one("HR sets them in Pulse → HR → Onboard team → Check-in settings."), ["hr.onboard.settings"]);
  assert.deepEqual(one("2. Upload them in Pulse → Finance → Bank statements."), ["finance.desk"]);
  assert.deepEqual(one("Upload it to Pulse → Company."), ["settings.organisation"]);
  assert.deepEqual(one("Read it in Pulse → HR → Policies -> Office presence and test it"), ["hr.policies.presence"]);
  assert.deepEqual(one("Nothing here → at all"), []);
});

test("titles match the exact control", () => {
  const top = (t) => matchDestinations(t, 1)[0]?.dest.id;
  assert.equal(top("Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people"), "hr.policies.presence.wifi");
  assert.equal(top("Set the payroll cut-off date"), "hr.onboard.settings.cutoff");
  assert.equal(top("Add this year's holidays"), "hr.policies.leave");
  assert.deepEqual(matchDestinations("   ", 3), []);
});

// TASK-MERGE (Pip, owner 7 Nov 2026): "It detects keywords in titles and auto-opens irrelevant suggestions." A title's
// words never pick a place or a signal; the creator's pick, or a place written out in full, does.
test("the owner's example: words alone pick nothing; the written place or the creator's pick does", () => {
  const task = { title: "Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people", notes: null };
  assert.equal(targetFor(task, { role: "HR" }), null, "no place from the title's words");
  assert.deepEqual(proposeFor(task), [], "no signals from the title's words");
  const written = { ...task, notes: "1. Open Pulse → HR → Policies → Office presence." };
  const t = targetFor(written, { role: "HR" });
  assert.equal(t?.dest.id, "hr.policies.presence.wifi");
  assert.equal(t?.button, "Go to Office presence");
  assert.equal(t?.source, "notes");
  const p = proposeFor(written);
  assert.deepEqual(p.map((s) => [s.event, s.need, s.distinct ?? null]), [["office.network.saved", 1, null], ["attendance.office.arrived", 2, "subject"]]);
  assert.equal(p[0].label, "Office Wi-Fi and IP saved");
  assert.equal(p[1].label, "2 people checked in on arriving at the office");
  assert.deepEqual(proposeFor({ ...task, target: "hr.policies.presence.wifi" }).map((s) => s.event), ["office.network.saved", "attendance.office.arrived"]);
});

test("signals are proposed only on a structural place, and only those the task asks for", () => {
  assert.deepEqual(proposeFor({ title: "Add the office Wi-Fi", notes: null }), []);
  assert.deepEqual(proposeFor({ title: "Write the welcome video script", notes: null }), []);
  assert.deepEqual(proposeFor({ title: "Make sure three people check in when they arrive at the office", notes: null }), []);
  assert.deepEqual(proposeFor({ title: "Publish staff notice v2 in Pulse → HR → Policies", notes: null }).map((s) => s.event), ["policy.published"]);
  assert.deepEqual(proposeFor({ title: "Office things", notes: null, target: "hr.policies.presence.wifi" }), [], "a picked place, but nothing asked of it");
  // The notes' place wins over the title's, and the creator's pick wins over both.
  const notes = targetFor({ title: "Office things", notes: "1. Open Pulse → HR → Onboard team → Check-in settings." }, { role: "HR" });
  assert.equal(notes?.dest.id, "hr.onboard.settings"); assert.equal(notes?.source, "notes");
  assert.equal(targetFor({ title: "Office things", notes: null, target: "hr.policies.presence.ip" }, { role: "HR" })?.source, "creator");
  // A written page and a control named by one word beside it: the control is where the work is done.
  const guest = targetFor({ title: "Add the guest Wi-Fi in Pulse → HR → Policies → Office presence", notes: null }, { role: "HR" });
  assert.equal(guest?.dest.id, "hr.policies.presence.wifi"); assert.equal(guest?.button, "Go to Office presence");
  for (const title of ["Add the guest Wi-Fi in Office presence", "Set the payroll cut-off day", "Update company settings", "Review the leave policy"])
    assert.equal(targetFor({ title, notes: null }, { role: "Organisation owner/admin" }), null, title);
  // Someone who cannot open the place is not sent there.
  assert.equal(targetFor({ title: "Office things", notes: null, target: "hr.policies.presence.ip" }, { role: "Employee" }), null);
});

// PERSONAL-WORKSPACE (owner, 6 Nov 2026): Pip sent "Achievement A10: one Pulse at app.vitalsos.ai for every company" to
// Settings → Organisation. A title's words about a company, an organisation or a team are not a place; the task's real
// context (organisation kind, project type) decides whether the title is read at all.
test("a title that says company or organisation goes nowhere by that word", () => {
  const admin = { role: "Organisation owner/admin" };
  for (const title of ["Achievement A10: One Pulse at app.vitalsos.ai for every company", "Thank every company we worked with this year",
    "One login for the whole organization", "Thank the organisation for its patience", "Company pulse: what I learned this year", "Pitch Akabod: Brahata company, my equity"]) {
    assert.equal(targetFor({ title, notes: null }, admin), null, title);
    assert.equal(targetFor({ title, notes: null, projectType: "internal" }, admin), null, title);
  }
  assert.equal(specificPlace("company"), false);
  assert.equal(specificPlace("company details"), false);
  assert.equal(specificPlace("Office presence"), true);
});

test("no organisation kind or project type makes a title's words a place", () => {
  const hr = { role: "HR" };
  const title = "Add the office Wi-Fi and IP in Office presence";
  for (const projectType of [null, "internal", "personal", "client_delivery"]) {
    assert.equal(targetFor({ title, notes: null, projectType }, hr), null, String(projectType));
    assert.equal(targetFor({ title, notes: null, projectType }, { ...hr, orgKind: "personal" }), null, String(projectType));
  }
  assert.equal(titleMayRoute({ projectType: "personal" }, {}), false);
  assert.equal(titleMayRoute({ projectType: null }, { orgKind: "company" }), false);
  // A place written out in full, or picked by the creator, still counts anywhere: it is a link, not a guess.
  assert.equal(targetFor({ title: "Every company: Pulse → HR → Policies → Office presence", notes: null, projectType: "personal" }, { ...hr, orgKind: "personal" })?.source, "title");
  assert.equal(targetFor({ title: "For every company", notes: null, target: "hr.policies.presence.ip", projectType: "personal" }, { ...hr, orgKind: "personal" })?.source, "creator");
});
