// SPEED-3: the slow pages' server renders start their reads together instead of one round after another.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("/people starts every read at once and reads the company figures only on Tracking", () => {
  const s = read("../people/page.tsx");
  const all = s.indexOf("await Promise.all([");
  assert.ok(all > 0 && !s.slice(0, all).includes("await vocabulary()"), "the vocabulary (the person's record) must not be awaited before the list");
  assert.match(s, /tracked \? insightsFor\(\) : Promise\.resolve\(null\)/);
  assert.match(s, /leaderP\.then\(\(leader\) => leader \? api<\{ agents: AiTeamRow\[\] \}>\("agents\/team"\) : null\)/);
  assert.match(s, /const trackingTab = seesInsights\(reviewer\) \|\| canReviewAccountClaims;/);
});

test("/me starts the work calendar with hr/self where attendance is on, never where it is off", () => {
  const s = read("../me/page.tsx");
  assert.match(s, /m\.data\?\.companyModules\?\.attendance === true \? api<WorkCalendar>\("hr\/work-calendar"\) : null/);
  assert.match(s, /const work = attendanceEnabled \? workFirst \?\? await api<WorkCalendar>\("hr\/work-calendar"\) : null;/);
});

test("Work starts the list, its view, the requests and the summary's cards beside tasks/home, through one read per address", () => {
  const s = read("../tasks/page.tsx");
  const start = s.indexOf("void startReads(q)"), home = s.indexOf('api<Home>("tasks/home")');
  assert.ok(start > 0 && start < home, "the early reads start before tasks/home is awaited");
  assert.match(s, /const readOnce = cache\(\(path: string\) => api<unknown>\(path\)\);/);
  assert.match(s, /read<WorkList>\(listPath\(place, q\)\)/);
  assert.match(s, /Promise\.all\(\[summaryOpen && h\.me \? summarySeed\(admin\) : null, h\.me \? read<[^>]+>\("work\/asks"\)/);
  for (const path of ['"ai"', '"admin/runners"', '"agents"', '"telegram/link"', '"hr/colleagues"', '"companion?visible=0"']) assert.ok(s.includes(`read<`) && new RegExp(`read<[^>]*>\\(${path.replace(/[?/]/g, (c) => `\\${c}`)}\\)`).test(s), `${path} goes through read()`);
});

test("the HR desk starts the tab's own read and the approvals count with the desk", () => {
  const s = read("../hr/page.tsx");
  const all = s.indexOf("await Promise.all(["), end = s.indexOf("]);", all);
  const first = s.slice(all, end);
  for (const path of ['"hr/attendance"', "`hr/leave${month}`", '"hr/tickets?scope=all"', '"hr/payroll"', "'hr/flows'", '"hr/onboard"', '"lifecycle"']) assert.ok(first.includes(path), `${path} starts with the desk`);
  assert.match(s, /const flows = d \? flowsRead : null;/);
  assert.ok(!/await api<(TeamLeave|TicketList|Payroll|FlowData|Onboard|Moves)>/.test(s.slice(end)), "no tab read waits for the desk any more");
});
