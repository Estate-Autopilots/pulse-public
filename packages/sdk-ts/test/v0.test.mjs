import assert from "node:assert/strict";
import test from "node:test";
import { API_V0_PATHS } from "../dist/v0.js";
import { syntheticV0Fixtures } from "../dist/v0-fixtures.js";

test("v0 provides one synthetic fixture for each screen endpoint", () => {
  assert.deepEqual(API_V0_PATHS, {
    me: "/api/v0/me",
    hq: "/api/v0/hq",
    myHr: "/api/v0/me/hr",
    myWeek: "/api/v0/my-week",
    podBoard: "/api/v0/pod-board",
    leadershipWeek: "/api/v0/leadership-week",
    editors: "/api/v0/editors",
    editor: API_V0_PATHS.editor,
    designDeliveriesSummary: "/api/v0/design-deliveries/summary",
    designers: API_V0_PATHS.designers,
    designer: API_V0_PATHS.designer,
    designerBrandProjects: "/api/v0/designers/brand-projects/open",
  });
  assert.equal(API_V0_PATHS.myHr, "/api/v0/me/hr");
  assert.equal(API_V0_PATHS.editor("shared@example.test"), "/api/v0/editors/shared%40example.test");
  assert.equal(API_V0_PATHS.designers("2026-W41"), "/api/v0/designers?week=2026-W41");
  assert.equal(API_V0_PATHS.designDeliveriesSummary, "/api/v0/design-deliveries/summary");
  assert.equal(API_V0_PATHS.designerBrandProjects, "/api/v0/designers/brand-projects/open");
  assert.equal(API_V0_PATHS.designer("00000000-0000-0000-0000-000000000001", "2026-W41"),
    "/api/v0/designers/00000000-0000-0000-0000-000000000001?week=2026-W41");
  assert.deepEqual(Object.keys(syntheticV0Fixtures), [
    "me",
    "myWeek",
    "podBoard",
    "leadershipWeek",
  ]);
});

test("every aggregate count includes rule, source, and sample-file evidence", () => {
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (typeof value.value === "number") {
      assert.equal(typeof value.why?.rule, "string");
      assert.equal(typeof value.why?.detail, "string");
      assert.equal(value.why?.source, "deliveries_read_model");
      assert.ok(Array.isArray(value.why?.sampleFileIds));
    }
    Object.values(value).forEach(visit);
  };
  visit(syntheticV0Fixtures);
});

test("pod and leadership fixtures do not include ranked-list fields", () => {
  const forbidden = new Set(["rank", "ranking", "position", "score", "leaderboard"]);
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key.toLowerCase()), false, `unexpected field: ${key}`);
      visit(child);
    }
  };
  visit(syntheticV0Fixtures.podBoard);
  visit(syntheticV0Fixtures.leadershipWeek);
});
