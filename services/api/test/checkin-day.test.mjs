// SPEED-5 (owner, 18 Nov 2026): Check in / Check out from the header waited for two round trips in a row: the action,
// then the day (GET /api/v0/companion) to show the new state (header Check in p90 1.8 s for real people; ~0.3-0.5 s per
// round trip from India). An action that asks for it (`day: true`) now answers with the day, read after the change in
// the same transaction, by the very function GET /companion answers with; the GET's own signals stay in the GET.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hr = readFileSync(new URL("../src/hr.ts", import.meta.url), "utf8");
const companion = readFileSync(new URL("../src/companion.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/routes.ts", import.meta.url), "utf8");

test("check-in, check-out and break answer with the day only when asked", () => {
  for (const path of ["check-in", "check-out", "break"])
    assert.match(hr, new RegExp(`app\\.post<\\{ Body: Body \\}>\\("/api/v0/attendance/${path}",[^\\n]*req => withDay\\(req, async \\(c, v\\) => \\{`));
  assert.match(hr, /return companionDay && \(req\.body as Body \| undefined\)\?\.day === true \? \{ \.\.\.out, day: await companionDay\(c, v\) \} : out;/);
  assert.match(routes, /registerHrRoutes\(app, \{ tx, companionDay \}\);/);
});

test("the day is GET /companion's own answer; the GET keeps its signals, the day has none", () => {
  const get = companion.slice(companion.indexOf('app.get("/api/v0/companion"'), companion.indexOf("registerCompanionActions(app, { tx, open });"));
  assert.match(get, /pulse\.companion_presence_tick/);
  assert.match(get, /pulse\.presence_browser_seen/);
  assert.match(get, /pulse\.onboarding_seen\(\)/);
  assert.match(get, /return companionDay\(c, v\);/);
  const day = companion.slice(companion.indexOf("export async function companionDay("), companion.indexOf("function registerCompanionActions("));
  assert.ok(day.length > 2000, "the whole day is in companionDay");
  assert.doesNotMatch(day, /presence_browser_seen|companion_presence_tick|onboarding_seen|insert into|update pulse\./);
  assert.match(day, /if \(!v\.person\) fail\(403/);
  assert.match(day, /links: \{ desk: "\/me", corrections: "\/me\?tab=attendance" \}/);
});
