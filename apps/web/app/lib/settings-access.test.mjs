import assert from "node:assert/strict";
import test from "node:test";
import { canOpenSection, seesDeveloperApps } from "./settings-access.mjs";

const ALL = ["account", "notifications", "appearance", "privacy", "devices", "data-health", "sign-in", "work-rules", "team", "roles", "organisation",
  "industry", "apps", "ai", "servers", "mail", "chats", "connected-apps", "connected", "api-keys", "desktop-app"];
const open = (role, opts) => ALL.filter((k) => canOpenSection(role, k, opts));
const own = ["account", "notifications", "appearance", "privacy", "devices", "connected-apps", "api-keys"];

test("admins open every Settings section", () => assert.deepEqual(open("admin"), ALL));

test("leadership sets industry, AI and chats, but not sign-in, team, mail or data health", () => {
  for (const k of ["industry", "ai", "chats", "apps", "work-rules", ...own]) assert.ok(canOpenSection("leadership", k), k);
  for (const k of ["sign-in", "team", "roles", "mail", "data-health", "connected", "desktop-app", "organisation"]) assert.ok(!canOpenSection("leadership", k), k);
});

test("HR opens sign-in, Apps and Who can do what, and Organisation only for a company on the setup checklist", () => {
  for (const k of ["sign-in", "work-rules", "apps", ...own]) assert.ok(canOpenSection("hr", k), k);
  for (const k of ["data-health", "mail", "team", "roles", "ai", "industry", "chats", "connected", "desktop-app", "organisation"]) assert.ok(!canOpenSection("hr", k), k);
  assert.ok(canOpenSection("hr", "organisation", { hrSetup: true }));
});

test("a member opens only their own sections, Apps and Who can do what", () => {
  for (const role of ["member", "manager", "finance", "pgs", "something-new"]) assert.deepEqual(open(role), ["account", "notifications", "appearance", "privacy", "devices", "work-rules", "apps", "connected-apps", "api-keys"], role);
  assert.ok(!canOpenSection("member", "sign-in")); assert.ok(!canOpenSection("member", "roles"));
});

test("Servers & AI (Pulse Runner) is for organisation admins only", () => {
  assert.ok(canOpenSection("admin", "servers"));
  for (const role of ["leadership", "hr", "finance", "manager", "pgs", "member", "something-new"]) {
    assert.ok(!canOpenSection(role, "servers"), role);
    assert.ok(!canOpenSection(role, "servers", { hrSetup: true }), role);
  }
});

test("registered developer apps: admins and HR, as before the Settings home", () => {
  assert.ok(seesDeveloperApps("admin")); assert.ok(seesDeveloperApps("hr"));
  for (const role of ["leadership", "member", "finance"]) assert.ok(!seesDeveloperApps(role), role);
});
