import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MODULE_PATHS, moduleForPath, pathSwitchedOff } from "../../../../packages/ui-shell/src/modules.ts";

test("the shell knows exactly the schema's module keys", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../../packages/schemas/config/modules.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(MODULE_PATHS), schema.properties.off.items.enum);
});

test("pages map to their module; always-on pages map to none", () => {
  const owned = { "/designers": "designers", "/map": "map", "/acquisition": "acquisition", "/portal/projects/x": "acquisition",
    "/chats": "chats", "/communication": "chats", "/inbox?x=1": "chats", "/groups/abc": "chats", "/briefs/new": "briefs",
    "/finance/desk": "money", "/money/a/b": "money", "/erp/documents/x": "money", "/hr": "hr", "/hr-history": "hr", "/shifts": "hr", "/leave": "hr",
    // RELEASE-5: lane C's rounds; the longest base decides (/chats/import is the import's, the rest of /chats is chats').
    "/relationships": "relationships", "/people/skills": "skills", "/people/jobs": "jobs", "/people/jobs/x": "jobs", "/chats/import": "chat_import", "/chats/abc": "chats" };
  for (const [path, key] of Object.entries(owned)) assert.equal(moduleForPath(path), key, path);
  for (const path of ["/dashboard", "/tasks", "/projects/x", "/clients", "/contacts", "/people", "/people/x", "/me", "/settings",
    "/review-data", "/audit", "/leadership", "/hrx", "/mapping", "/", "", null, undefined]) assert.equal(moduleForPath(path), null, String(path));
});

test("a page is hidden only when its own module is off", () => {
  assert.equal(pathSwitchedOff("/map", ["map"]), true);
  assert.equal(pathSwitchedOff("/map", ["hr"]), false);
  assert.equal(pathSwitchedOff("/map", []), false);
  assert.equal(pathSwitchedOff("/map", undefined), false);
  assert.equal(pathSwitchedOff("/dashboard", Object.keys(MODULE_PATHS)), false);
});

// VISUAL-QA (D126, 13 Nov 2026): a module's path list only hides the menu entry; the page itself must refuse by address
// too. /brand was in pulse_hq's list without a gate and opened in every company.
test("every module page folder has a layout that gates on its module", async () => {
  const { existsSync } = await import("node:fs");
  const app = new URL("../", import.meta.url);
  for (const [key, paths] of Object.entries(MODULE_PATHS)) for (const path of paths) {
    if (!existsSync(new URL(`.${path}/`, app))) continue; // a base with no page folder of its own (e.g. /leave)
    let gated = false;
    for (let dir = path; dir && !gated; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      const layout = new URL(`.${dir}/layout.tsx`, app);
      if (existsSync(layout) && (await readFile(layout, "utf8")).includes(`"${key}"`)) gated = true;
    }
    assert.ok(gated, `${path} (${key}) has no layout that checks "${key}"`);
  }
});
