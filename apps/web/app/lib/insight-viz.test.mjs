// INSIGHTS-2 (1082): the chart system's rules. Every row here is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { activeWindow, applyFilters, baseline, count, days, delta, heatStep, kindOf, minutes, niceStep, niceTop, normalize, quantileFromBins, rupees, ticks, toCsv } from "./insight-viz.mjs";

test("kinds: the vocabulary and the names other producers use", () => {
  assert.equal(kindOf({ kind: "bars" }), "bars");
  assert.equal(kindOf({ kind: "hbar" }), "bars");
  assert.equal(kindOf({ kind: "histogram" }), "distribution");
  assert.equal(kindOf({ kind: "matrix" }), "heatmap");
  assert.equal(kindOf({ kind: "curve" }), "line");
  assert.equal(kindOf({ kind: "KPI" }), "kpis");
  assert.equal(kindOf({ kind: "pie3d" }), null);
  assert.equal(kindOf(null), null);
});

test("rows are normalised from a spec's field mapping", () => {
  const bars = normalize({ kind: "hbar", x: { field: "n" }, y: { field: "reason" } }, [{ reason: "Lead quality", n: 12 }, { reason: "Funds", n: "7" }]);
  assert.deepEqual(bars.rows.map((r) => [r.label, r.value]), [["Lead quality", 12], ["Funds", 7]]);
  const heat = normalize({ kind: "matrix", x: { field: "hour" }, y: { field: "day" }, color: { field: "msgs" } }, [{ hour: 11, day: "Mon", msgs: 40 }]);
  assert.deepEqual([heat.rows[0].row, heat.rows[0].col, heat.rows[0].value], ["Mon", 11, 40]);
  const sc = normalize({ kind: "scatter", x: { field: "load" }, y: { field: "mins" }, label: { field: "who" } }, [{ load: 10, mins: 5, who: "Colleague A" }, { load: null, mins: 3 }]);
  assert.equal(sc.rows.length, 1);
  assert.equal(sc.rows[0].label, "Colleague A");
  assert.deepEqual(normalize({ kind: "nope" }, [{ a: 1 }]), { kind: null, rows: [] });
  const line = normalize({ kind: "line" }, [{ x: "2025-Q1", value: 3, series: "a" }, null, "x"]);
  assert.equal(line.rows.length, 1);
});

test("filters: summed rows keep the chosen pod and add up per key", () => {
  const rows = [{ label: "Complaints", value: 3, pod: "Pod A" }, { label: "Complaints", value: 2, pod: "Pod B" }, { label: "Delays", value: 1, pod: "Pod A" }];
  assert.deepEqual(applyFilters(rows, { agg: "sum" }, {}).rows, [{ label: "Complaints", value: 5 }, { label: "Delays", value: 1 }]);
  assert.deepEqual(applyFilters(rows, { agg: "sum" }, { pod: "Pod A" }).rows, [{ label: "Complaints", value: 3 }, { label: "Delays", value: 1 }]);
  const r = applyFilters(rows, { agg: "sum" }, { segment: "R" });
  assert.deepEqual(r.ignored, ["segment"]);
});

test("filters: picked rows choose the precomputed value, '*' means everyone", () => {
  const rows = [{ x: "Q1", value: 9, pod: "*" }, { x: "Q1", value: 4, pod: "Pod A" }];
  assert.deepEqual(applyFilters(rows, { agg: "pick" }, {}).rows.map((r) => r.value), [9]);
  assert.deepEqual(applyFilters(rows, { agg: "pick" }, { pod: "Pod A" }).rows.map((r) => r.value), [4]);
});

test("filters: a period drops months before it", () => {
  const rows = [{ x: "a", value: 1, month: "2025-01" }, { x: "a", value: 2, month: "2026-08" }];
  assert.deepEqual(applyFilters(rows, {}, { since: "2026-07-28" }).rows.map((r) => r.value), [2]);
});

test("percentiles from binned counts", () => {
  const bins = [{ lo: 0, hi: 5, n: 50 }, { lo: 5, hi: 15, n: 30 }, { lo: 15, hi: null, n: 20 }];
  assert.equal(quantileFromBins(bins, 0.5), 5);
  assert.equal(quantileFromBins(bins, 0.65), 10);
  assert.equal(quantileFromBins(bins, 0.95), 15);
  assert.equal(quantileFromBins([{ lo: 0, hi: 1, n: 0 }], 0.5), null);
});

test("scales and heat steps", () => {
  assert.equal(niceTop(7), 10);
  assert.equal(niceTop(230), 250);
  assert.equal(niceTop(0), 1);
  assert.deepEqual(ticks(7, 2), [0, 5, 10]);
  assert.equal(niceStep(5.7), 10);
  assert.equal(niceStep(1.3), 2);
  assert.equal(heatStep(0, 10), 0);
  assert.equal(heatStep(10, 10), 6);
  assert.ok(heatStep(1, 100) >= 1);
});

test("the clients' active window is the busiest run of hours", () => {
  const h = Array(24).fill(1); for (let i = 11; i < 17; i++) h[i] = 20;
  assert.deepEqual(activeWindow(h, 6), { start: 11, end: 17, share: 120 / 138 });
  assert.equal(activeWindow([], 6), null);
});

test("CSV export quotes what needs it and defuses formulas", () => {
  assert.equal(toCsv([{ a: 1, b: "x,y" }, { a: 2, c: '=SUM(1)' }]), 'a,b,c\n1,"x,y",\n2,,"\'=SUM(1)"');
});

test("units in words", () => {
  assert.equal(minutes(7.6), "8 min");
  assert.equal(minutes(84), "1.4 h");
  assert.equal(minutes(1499), "2.8 days");
  assert.equal(minutes(null), "–");
  assert.equal(days(0.5), "12 h");
  assert.equal(days(7.66), "7.7 days");
  assert.equal(days(1), "1 day");
  assert.equal(count(131048), "1,31,048");
  assert.equal(count(131048, true), "1.3L");
  assert.equal(rupees(420000), "₹4.2L");
  assert.deepEqual(delta(8, 10, "down"), { d: -0.2, good: true, text: "-20%" });
  assert.equal(delta(1, 0), null);
  assert.equal(baseline([10, 2, 6, 99]), 6);
});
