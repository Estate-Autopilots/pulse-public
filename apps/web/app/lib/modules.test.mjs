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
