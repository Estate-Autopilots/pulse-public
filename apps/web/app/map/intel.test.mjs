import assert from "node:assert/strict";
import test from "node:test";
import { driveMinutes, moneyByLocation, moneyByMarket, planRoute, pricesByMarket, projectRevenue, reachKm, whiteSpace } from "./intel.ts";

// Synthetic places, clients and amounts only.
const inv = (o = {}) => ({ number: "INV-1", party: "Northstar LLP", day: "2026-09-10", due: "2026-09-20", taxable: 100000, total: 118000, status: "unconfirmed", overdueDays: 0,
  paidBasis: null, clientId: "c1", projectId: "p1", locationId: "l1", basis: "words", confidence: 0.85, ...o });
const row = (id, lat = 18.6, lng = 73.8) => ({ loc: { id, lat, lng } });
const market = (key, name, rows, o = {}) => ({ key, name, city: "Pune", isCity: false, lat: rows[0]?.loc.lat ?? null, lng: rows[0]?.loc.lng ?? null, projects: rows.length, engagements: rows.length,
  clients: 1, repeatClients: 0, topSegment: null, first: "2025-01", last: "2025-06", recent: 0, before: 0, rows, ...o });

test("money adds up per place and per market; overdue is unpaid past its due date", () => {
  const byLoc = moneyByLocation([inv(), inv({ number: "INV-2", status: "paid", taxable: 50000 }), inv({ number: "INV-3", status: "unpaid", overdueDays: 40, taxable: 25000, clientId: "c2" }),
    inv({ number: "INV-4", day: "2024-01-05", taxable: 10000 }), inv({ number: "INV-5", locationId: null })], "2026-10-11");
  const l1 = byLoc.get("l1");
  assert.equal(l1.invoiced, 185000); assert.equal(l1.invoiced12, 175000); assert.equal(l1.paid, 50000); assert.equal(l1.unpaid, 25000);
  assert.equal(l1.overdue, 25000); assert.equal(l1.invoices, 4); assert.equal(l1.clients, 2); assert.equal(l1.last, "2026-09-10");
  assert.equal(byLoc.size, 1);   // an invoice not yet placed is not on the map
  const mk = moneyByMarket([market("Pune|Lakeview", "Lakeview", [row("l1"), row("l1")]), market("Pune|Empty", "Empty", [row("l9")])], byLoc);
  assert.equal(mk.get("Pune|Lakeview").invoiced, 185000);   // a location counts once in its market
  assert.equal(mk.has("Pune|Empty"), false);
});

test("revenue projection: six-month average moved by half the capped trend, with an honest confidence", () => {
  const monthly = { "2026-03": 100, "2026-04": 100, "2026-05": 100, "2026-06": 200, "2026-07": 200, "2026-08": 200, "2026-09": 200 };
  const p = projectRevenue(monthly, "2026-10-11", 3);
  assert.equal(p.base, (100 + 100 + 200 + 200 + 200 + 200) / 6);        // Apr–Sep
  assert.equal(p.trend, 0.3);                                            // +60% capped at +30%
  assert.equal(Math.round(p.perMonth), Math.round(p.base * 1.15));
  assert.equal(p.next6, p.perMonth * 6);
  assert.equal(p.activeMonths, 7); assert.equal(p.confidence, "medium");     // high needs 8 active months and 3 clients
  assert.equal(projectRevenue({ ...monthly, "2025-11": 1, "2025-12": 1 }, "2026-10-11", 3).confidence, "high");
  assert.equal(projectRevenue(monthly, "2026-10-11", 1).confidence, "low");    // one client is one client's plan
  assert.equal(projectRevenue({}, "2026-10-11", 0).next6, 0);
  assert.match(p.method, /last six full months \(2026-04 to 2026-09\)/);
});

test("prices: median per market and kind, confidence by how many projects quote them", () => {
  const mks = [market("Pune|A", "A", [row("a1"), row("a2"), row("a3")]), market("Pune|B", "B", [row("b1")])];
  const stats = pricesByMarket([{ locationId: "a1", projectId: "p1", price: 6000, kind: "apartment" }, { locationId: "a2", projectId: "p2", price: 7000, kind: "apartment" },
    { locationId: "a3", projectId: "p3", price: 9000, kind: "apartment" }, { locationId: "a3", projectId: "p3", price: 1800, kind: "plot" },
    { locationId: "b1", projectId: "p4", price: 5000, kind: "apartment" }, { locationId: "zz", projectId: "p5", price: 4000, kind: "apartment" }], mks);
  const a = stats.find((s) => s.key === "Pune|A" && s.kind === "apartment");
  assert.deepEqual([a.median, a.low, a.high, a.projects, a.confidence], [7000, 6000, 9000, 3, "high"]);
  assert.equal(stats.find((s) => s.key === "Pune|A" && s.kind === "plot").median, 1800);
  assert.equal(stats.find((s) => s.key === "Pune|B").confidence, "low");
  assert.equal(stats.length, 3);   // a price whose project is not on the map is left out
});

test("white space: demand nearby or known projects, but nothing invoiced in the last year", () => {
  const paying = market("Pune|Paying", "Paying", [row("p1", 18.60, 73.80)]);
  const near = market("Pune|Near", "Near", [row("n1", 18.62, 73.81), row("n2", 18.62, 73.81)]);
  const far = market("Pune|Far", "Far", [row("f1", 19.20, 74.40)]);
  const lone = market("Pune|Lone", "Lone", [row("o1", 19.50, 74.90), row("o2", 19.50, 74.90), row("o3", 19.50, 74.90)]);
  const byMarket = new Map([["Pune|Paying", { invoiced12: 500000 }], ["Pune|Near", { invoiced12: 0 }]]);
  const gaps = whiteSpace([paying, near, far, lone], byMarket, [{ key: "Pune|Near", kind: "apartment", median: 7000 }]);
  assert.deepEqual(gaps.map((g) => g.key), ["Pune|Near", "Pune|Lone"]);        // the paying market is not white space; a lone single project is not a lead
  assert.equal(gaps[0].confidence, "medium"); assert.deepEqual(gaps[0].nearbyMarkets, ["Paying"]);
  assert.match(gaps[0].why, /paying clients in Paying nearby/); assert.match(gaps[0].why, /₹7,000\/sq ft/);
});

test("shoot route: nearest first, then untangled; times are estimates with a road factor", () => {
  const office = { id: "office", name: "Office", lat: 18.52, lng: 73.85 };
  const stops = [{ id: "far", name: "Far", lat: 18.70, lng: 73.85 }, { id: "near", name: "Near", lat: 18.54, lng: 73.85 }, { id: "mid", name: "Mid", lat: 18.62, lng: 73.85 }];
  const r = planRoute(stops, office);
  assert.deepEqual(r.order.map((s) => s.id), ["near", "mid", "far"]);
  assert.equal(r.legs.length, 3); assert.ok(r.km > 0 && r.minutes > 0);
  assert.deepEqual(planRoute([], office).order, []);
  assert.deepEqual(planRoute(stops, null).order.map((s) => s.id).sort(), ["far", "mid", "near"]);
  assert.equal(driveMinutes(0), 0);
  assert.equal(driveMinutes(10), Math.round((13.5 / 22) * 60));          // inside the city: 22 km/h on 1.35x the line
  assert.ok(Math.abs(reachKm(driveMinutes(30)) - 30) < 1);                // the ring radius inverts the estimate
});
