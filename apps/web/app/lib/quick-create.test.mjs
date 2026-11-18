import assert from "node:assert/strict";
import test from "node:test";
import { quickCreateShows } from "./quick-create.mjs";

test("the phone's + shows on staff pages and stays out of the way elsewhere", () => {
  for (const p of ["/", "/dashboard", "/people", "/erp", "/clients/abc", "/hr", "/meetings", "/sales"]) assert.equal(quickCreateShows(p), true, p);
  // Pages with their own + New (PROJECTS-CREATE).
  for (const p of ["/tasks", "/tasks?view=projects", "/tasks/123", "/my-day"]) assert.equal(quickCreateShows(p), false, p);
  // Something else lives at the bottom of the screen.
  for (const p of ["/chats", "/chats?channel=x", "/erp/documents/abc", "/erp/new", "/calls", "/meetings/abc"]) assert.equal(quickCreateShows(p), false, p);
  for (const p of ["/login", "/signup", "/invited/x", "/portal"]) assert.equal(quickCreateShows(p), false, p);
  assert.equal(quickCreateShows(undefined), true);
  assert.equal(quickCreateShows("/tasksheet"), true);
});
