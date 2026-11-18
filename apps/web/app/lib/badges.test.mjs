// HR-PEOPLE (owner, 13 Nov 2026, T1.1.3): every badge with a count above 0 says on hover what is waiting, and leads to a
// page that shows exactly those items (the page marks their list with data-badge-target, which badge-arrival.tsx lights).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { BADGES, BADGE_TRAVEL_MS, badgeHref, badgeTip, badgeTravel } from "./badges.mjs";

const APP = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, APP), "utf8");

/** The page file a link opens: app/<path>/page.tsx, or a dynamic segment ([id]) beside it. */
function pageFor(href) {
  const parts = href.split(/[?#]/)[0].split("/").filter(Boolean);
  let dir = APP;
  for (const part of parts) {
    const next = new URL(`${part}/`, dir);
    if (existsSync(next)) { dir = next; continue; }
    const dyn = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && /^\[[^\]]+\]$/.test(e.name));
    if (!dyn) return null;
    dir = new URL(`${dyn.name}/`, dir);
  }
  const page = new URL("page.tsx", dir);
  return existsSync(page) ? page : null;
}

test("every badge says what waits, in plain words, for one and for many", () => {
  for (const id of Object.keys(BADGES)) {
    for (const n of [1, 2, 37]) {
      const tip = badgeTip(id, n);
      assert.ok(tip.startsWith(String(n)), `${id}: the hover starts with the count (${tip})`);
      assert.match(tip, /Click to see (it|them)\.$/, `${id}: the hover says what a click does`);
      assert.ok(tip.length < 140, `${id}: short enough to read in a glance`);
      assert.doesNotMatch(tip, /\b1 \w+s wait\b|undefined|NaN/, `${id}: ${tip}`);
    }
    assert.equal(badgeTip(id, 0), "", `${id}: a badge with nothing waiting says nothing`);
  }
});

test("every badge with a count leads to a page that shows those items", () => {
  for (const [id, b] of Object.entries(BADGES)) {
    assert.equal(badgeHref(id), b.href);
    assert.ok(b.href.startsWith("/"), `${id}: an address inside the app`);
    assert.ok(pageFor(b.href), `${id}: ${b.href} is a page of the app`);
    assert.ok(b.target.length, `${id}: names the files that list its items`);
    const marked = b.target.some((f) => read(f).includes(`data-badge-target="${id}"`));
    assert.ok(marked, `${id}: the page it opens (${b.target.join(", ")}) marks the list with data-badge-target="${id}"`);
    const drawn = b.source.some((f) => { const s = read(f); return s.includes(`"${id}"`) && /badgeTip|badgeHref|BADGE_OF/.test(s); });
    assert.ok(drawn, `${id}: the badge (${b.source.join(", ")}) takes its words and address from lib/badges.mjs`);
  }
});

test("the HR desk's counts open the view that lists them (Time opened the week while corrections waited in Totals)", () => {
  assert.match(BADGES["hr.attendance"].href, /view=totals/, "corrections are listed in Totals");
  const totals = read("hr/desk/attendance.tsx");
  assert.ok(totals.indexOf('data-badge-target="hr.attendance"') > totals.indexOf('currentView === "totals"'), "the marked list sits in the Totals view");
  assert.ok(!/Waiting for you"[^\n]*href: regularisations\.length \? "\/hr\?tab=attendance"/.test(read("hr/desk/dashboard.tsx")), "Waiting for you's All goes where corrections are");
});

test("a badge click is remembered only briefly, and only for a known badge", () => {
  const now = 1_000_000;
  assert.deepEqual(badgeTravel({ id: "hr.leave", at: now - 1000 }, now), { id: "hr.leave", at: now - 1000 });
  assert.equal(badgeTravel({ id: "hr.leave", at: now - BADGE_TRAVEL_MS }, now), null, "stale");
  assert.equal(badgeTravel({ id: "nope", at: now }, now), null, "unknown");
  assert.equal(badgeTravel(null, now), null);
  assert.equal(badgeTravel({ id: "hr.leave", at: now + 5 }, now), null, "from the future");
});
