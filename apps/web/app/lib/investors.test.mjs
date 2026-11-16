import assert from "node:assert/strict";
import test from "node:test";
import { METRICS, change, deckText, funnel, headline, num, series, sparkPoints, total, weekLabel } from "./investors.mjs";

const zeros = (n = 4) => Array(n).fill(0);
const data = {
  asOf: "2026-11-08T10:00:00Z",
  weeks: ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"].slice(0, 4),
  series: { contractsSigned: [1, 2, 0, 46], companiesViaDeal: [0, 0, 1, 3], quotes: [10, 20, 30, 400], bills: [1, 2, 3, 20],
    chatUsers: [5, 6, 7, 84], chatUsersClient: [1, 1, 2, 30], activeUsers: [100, 120, 1412, 1388], employees: [1800, 1844, 1844, 1905],
    aiAgents: [200, 202, 202, 214], companies: [30, 31, 32, 33] },
  totals: { contractsSigned: 1240, companiesViaDeal: 38, quotes: 10000, bills: 450, chatUsers: 2310, chatUsersClient: 640,
    activeUsers: 1388, employees: 1905, aiAgents: 214, companies: 33 },
};
const by = (k) => METRICS.find((m) => m.key === k);

test("numbers are written the Indian way and weeks by their Monday", () => {
  assert.equal(num(124500), "1,24,500");
  assert.equal(num(10450), "10,450");
  assert.equal(weekLabel("2026-11-02"), "2 Nov");
  assert.equal(weekLabel("nonsense"), "");
});

test("seven numbers, each with a plain rule for how it is counted", () => {
  assert.equal(METRICS.length, 7);
  for (const m of METRICS) assert.ok(m.label && m.how.length > 20, m.key);
});

test("quotes and bills add up; totals read the right field", () => {
  assert.deepEqual(series(data, by("quotesAndBills")), [11, 22, 33, 420]);
  assert.equal(total(data, by("quotesAndBills")), 10450);
  assert.equal(total(data, by("employees")), 1905);
});

test("a flow's change is this week's count, a level's is the difference from last week", () => {
  assert.deepEqual(change(data, by("contractsSigned")), { n: 46, text: "+46 this week", tone: "up" });
  assert.deepEqual(change(data, by("employees")), { n: 61, text: "+61 this week", tone: "up" });
  assert.deepEqual(change(data, by("activeUsers")), { n: -24, text: "−24 this week", tone: "down" });
  const quiet = { ...data, series: { ...data.series, contractsSigned: zeros(), aiAgents: [5, 5, 5, 5] } };
  assert.equal(change(quiet, by("contractsSigned")).text, "None yet this week");
  assert.equal(change(quiet, by("aiAgents")).text, "Same as last week");
});

test("the headline tells the week in one sentence", () => {
  assert.equal(headline(data), "This week: 46 contracts signed, 3 companies joined through a deal and 420 quotes and bills handled.");
  const one = { ...data, series: { ...data.series, contractsSigned: [0, 0, 0, 1], companiesViaDeal: zeros(), quotes: zeros(), bills: zeros() } };
  assert.equal(headline(one), "This week: 1 contract signed.");
  const none = { ...data, series: { ...data.series, contractsSigned: zeros(), companiesViaDeal: zeros(), quotes: zeros(), bills: zeros() } };
  assert.match(headline(none), /just starting/);
});

test("the deck text has every number and where it came from, and no company", () => {
  const t = deckText(data);
  assert.match(t, /^Vitals network numbers\n/);
  assert.match(t, /Contracts signed: 1,240 \(\+46 this week\)/);
  assert.match(t, /People using chat: 2,310 \(640 client-side\)/);
  assert.match(t, /Weeks of 19 Oct to 9 Nov\./);
  assert.equal(t.split("\n").length, 9);
});

test("the spark line fits its box with zero at the bottom", () => {
  assert.equal(sparkPoints([3]), "");
  const pts = sparkPoints([0, 5, 10]).split(" ").map((p) => p.split(",").map(Number));
  assert.deepEqual(pts.map((p) => p[0]), [0, 50, 100]);
  assert.equal(pts[0][1], 27);
  assert.equal(pts[2][1], 1);
});

test("the funnel counts each step and its rate", () => {
  assert.deepEqual(funnel({ totals: { funnelViewed: 200, funnelClicked: 30, funnelOrgCreated: 6 } }), { viewed: 200, clicked: 30, made: 6, clickRate: "15%", madeRate: "20%" });
  assert.deepEqual(funnel({ totals: {} }), { viewed: 0, clicked: 0, made: 0, clickRate: "–", madeRate: "–" });
});
