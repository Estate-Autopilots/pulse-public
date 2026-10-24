// UX-5B: the destinations registry stays true to the app. A destination whose page, tab, anchor or event disappears
// fails here, before anyone is sent somewhere that no longer exists.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESTINATIONS, EVENTS, canSee, destForHref, destination, goHref, matchDestinations, placesIn } from "./registry.mjs";
import { proposeFor, targetFor } from "./propose.mjs";

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

test("the owner's example: target, button and signals", () => {
  const task = { title: "Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people", notes: null };
  const t = targetFor(task, { role: "HR" });
  assert.equal(t?.dest.id, "hr.policies.presence.wifi");
  assert.equal(t?.button, "Go to Office presence");
  assert.equal(t?.source, "title");
  const p = proposeFor(task);
  assert.deepEqual(p.map((s) => [s.event, s.need, s.distinct ?? null, JSON.stringify(s.where ?? null)]), [
    ["office.network.saved", 1, null, JSON.stringify({ wifi_count: { gte: 1 }, ip_count: { gte: 1 } })],
    ["attendance.office.arrived", 2, "subject", "null"],
  ]);
  assert.equal(p[0].label, "Office Wi-Fi and IP saved");
  assert.equal(p[1].label, "2 people checked in on arriving at the office");
});

test("signals are proposed only when the text asks for them", () => {
  assert.deepEqual(proposeFor({ title: "Add the office Wi-Fi", notes: null }).map((s) => s.event), ["office.network.saved"]);
  assert.deepEqual(proposeFor({ title: "Write the welcome video script", notes: null }), []);
  assert.deepEqual(proposeFor({ title: "Publish staff notice v2 in Pulse → HR → Policies", notes: null }).map((s) => s.event), ["policy.published"]);
  const three = proposeFor({ title: "Make sure three people check in when they arrive at the office", notes: null });
  assert.equal(three.find((s) => s.event === "attendance.office.arrived")?.need, 3);
  // The notes' place wins over the title's guess, and the creator's pick wins over both.
  const notes = targetFor({ title: "Office things", notes: "1. Open Pulse → HR → Onboard team → Check-in settings." }, { role: "HR" });
  assert.equal(notes?.dest.id, "hr.onboard.settings"); assert.equal(notes?.source, "notes");
  assert.equal(targetFor({ title: "Office things", notes: null, target: "hr.policies.presence.ip" }, { role: "HR" })?.source, "creator");
  // A page named whole and a control by one word: the control is where the work is done.
  const guest = targetFor({ title: "Add the guest Wi-Fi in Office presence", notes: null }, { role: "HR" });
  assert.equal(guest?.dest.id, "hr.policies.presence.wifi"); assert.equal(guest?.button, "Go to Office presence");
  assert.equal(targetFor({ title: "Set the payroll cut-off day", notes: null }, { role: "HR" })?.button, "Go to Check-in settings");
  // Someone who cannot open the place is not sent there.
  assert.equal(targetFor({ title: "Add the office Wi-Fi", notes: null }, { role: "Employee" }), null);
});
