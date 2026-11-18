import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WHATS_NEW, whatsNewFor } from "./whats-new.mjs";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The app route folder of an address, with [id] folders for ids (a page.tsx in it). */
const routeOf = (href) => {
  let dir = APP;
  for (const part of href.split(/[?#]/)[0].split("/").filter(Boolean)) {
    const next = join(dir, part);
    if (existsSync(next) && statSync(next).isDirectory()) { dir = next; continue; }
    const dyn = ["[id]", "[slug]"].map((d) => join(dir, d)).find((d) => existsSync(d));
    if (!dyn) return null;
    dir = dyn;
  }
  return existsSync(join(dir, "page.tsx")) ? dir : null;
};

test("VISIBLE: every item of the update opens a real page, once", () => {
  assert.equal(new Set(WHATS_NEW.map((i) => i.id)).size, WHATS_NEW.length);
  for (const i of WHATS_NEW) assert.ok(routeOf(i.href), `${i.id}: ${i.href} has a page`);
});

test("VISIBLE: each role sees its part of the update", () => {
  const ids = (role) => whatsNewFor(role).map((i) => i.id);
  assert.ok(ids("Member").includes("groups-hub") && !ids("Member").includes("insights") && !ids("Member").includes("salary-list"));
  assert.ok(ids("Leadership").includes("insights") && ids("Leadership").includes("signals") && !ids("Leadership").includes("salary-list"));
  assert.ok(ids("HR and leadership").includes("insights"));
  assert.ok(!ids("HR").includes("insights"));
  assert.ok(ids("Organisation owner/admin").includes("salary-list"));
  // A page the company switched off or hid from the role leaves the list.
  assert.ok(!whatsNewFor("Organisation owner/admin", (href) => href.startsWith("/apps/sales-xray")).some((i) => i.id === "sales-xray"));
});
