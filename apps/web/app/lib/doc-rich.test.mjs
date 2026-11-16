// DOCS-RICH: the rules of rich doc blocks (lib/doc-rich.mjs). Every value here is synthetic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FRAME_CSP, FRAME_SANDBOX, axis, blockChanges, blocksOf, cellNumber, diagramType, formatTick, formatValue, frameHeight, framePath, isFramePath, kpiOf, parseCsv, tidyChart, toCsv } from "./doc-rich.mjs";
import { ownCsp } from "../api/proxy.mjs";

const block = (b) => `<div data-type="pulse-block" data-kind="${b.kind}" data-id="${b.id}" data-block="${JSON.stringify(b).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`;

test("the sealed frame: scripts only, an opaque origin, no network but the CDN list, framed only by Pulse", () => {
  const d = Object.fromEntries(FRAME_CSP.split(/;\s*/).map((x) => { const [k, ...v] = x.split(" "); return [k, v.join(" ")]; }));
  assert.equal(d.sandbox, "allow-scripts", "the page gets scripts and nothing else from its sandbox");
  for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-forms", "allow-popups", "allow-modals", "allow-downloads"]) assert.ok(!FRAME_CSP.includes(flag), flag);
  assert.equal(d["default-src"], "'none'");
  assert.equal(d["connect-src"], "'none'", "no fetch, XHR, WebSocket or beacon");
  assert.equal(d["form-action"], "'none'");
  assert.equal(d["frame-src"], "'none'");
  assert.equal(d["frame-ancestors"], "'self'");
  assert.equal(d["base-uri"], "'none'");
  assert.equal(d["img-src"], "data: blob:", "no picture from the web (no tracking pixels)");
  assert.ok(!/\*|https?:(?!\/\/)/.test(d["script-src"].replace(/'[^']*'/g, "")), "no wildcard or bare scheme in script-src");
  assert.equal(FRAME_SANDBOX, "allow-scripts");
});

test("the frame's path is its own policy's, never the page's", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(framePath(id), `/api/v0/docs/frames/${id}`);
  assert.ok(isFramePath(["docs", "frames", id]));
  assert.ok(!isFramePath(["docs", "frames", "../x"]));
  assert.ok(ownCsp(["docs", "frames", id]), "the proxy leaves the frame's own policy in place");
  assert.ok(ownCsp(["docs", "files", id]), "a doc's file is answered as a file (sandboxed unless a picture or PDF)");
});

test("only a height comes back from a page, and it is kept in range", () => {
  assert.equal(frameHeight({ pulseFrame: "height", height: 640.4 }), 640);
  assert.equal(frameHeight({ pulseFrame: "height", height: 20 }), 120);
  assert.equal(frameHeight({ pulseFrame: "height", height: 1e9 }), 8000);
  assert.equal(frameHeight({ pulseFrame: "height", height: "NaN" }), null);
  assert.equal(frameHeight({ type: "navigate", url: "https://x.example" }), null);
  assert.equal(frameHeight("height:500"), null);
});

test("the API sends the same frame policy as the web proxy", async () => {
  const api = await readFile(new URL("../../../../services/api/src/doc-rich.ts", import.meta.url), "utf8");
  const cdns = JSON.parse((api.match(/FRAME_CDNS = (\[[^\]]+\])/) ?? [])[1].replace(/'/g, '"'));
  assert.ok(FRAME_CSP.includes(cdns.join(" ")), "same CDN list");
  for (const part of ["'sandbox allow-scripts'", `"connect-src 'none'"`, `"form-action 'none'"`, `"frame-ancestors 'self'"`, "'img-src data: blob:'"]) assert.ok(api.includes(part), part);
});

test("pasted data: CSV, spreadsheet tabs and semicolons, quotes, Indian and rupee numbers", () => {
  const a = parseCsv("Month,Revenue,Cost\nJan,\"2,40,000\",1.8\nFeb,₹ 2.7,\n");
  assert.deepEqual(a.columns, ["Month", "Revenue", "Cost"]);
  assert.deepEqual(a.rows, [["Jan", 240000, 1.8], ["Feb", 2.7, null]]);
  const b = parseCsv("City\tLeads\nPune\t96\nMumbai\t78");
  assert.deepEqual(b.rows, [["Pune", 96], ["Mumbai", 78]]);
  const c = parseCsv("a;b\nx;12%");
  assert.deepEqual(c.rows, [["x", 12]]);
  assert.equal(toCsv(["Name", "Value"], [["Pune, MH", 2]]), 'Name,Value\n"Pune, MH",2');
  assert.equal(cellNumber("-3e2"), -300);
  assert.equal(cellNumber("abc"), null);
});

test("a chart's data is read like the API reads it; the first bar chart keeps drawing sideways", () => {
  const t = tidyChart({ type: "line", columns: ["Month", "A"], rows: [["Jan", "4"], ["Feb", "x"]] });
  assert.deepEqual(t.rows, [["Jan", 4], ["Feb", null]]);
  const old = tidyChart({ kind: "chart", title: "Old", unit: "h", rows: [{ label: "This week", value: 3 }] });
  assert.deepEqual(old.columns, ["Name", "h"]);
  assert.deepEqual(old.rows, [["This week", 3]]);
  assert.equal(old.type, "bar");
  assert.equal(old.horizontal, true);
  assert.equal(tidyChart({ type: "rainbow" }).type, "bar");
});

test("numbers read the Indian way, and axes are round", () => {
  assert.equal(formatValue(1234567, "₹"), "₹12,34,567");
  assert.equal(formatValue(42.6, "₹ lakh"), "₹42.6 lakh");
  assert.equal(formatValue(-3.456, "%"), "-3.46%");
  assert.equal(formatValue(12, "hours"), "12 hours");
  assert.equal(formatValue(null), "–");
  assert.equal(formatTick(250000), "2.5L");
  assert.equal(formatTick(32000000), "3.2Cr");
  assert.equal(formatTick(12000), "12K");
  const a = axis([3.1, 4.2, 2.4], true);
  assert.equal(a.min, 0); assert.ok(a.max >= 4.2); assert.ok(a.ticks.length >= 3 && a.ticks.length <= 7);
  const b = axis([-12, 30], true);
  assert.ok(b.min <= -12 && b.ticks.includes(0), "values below zero get their own part of the axis");
  const c = axis([1020, 1100], false);
  assert.ok(c.min >= 1000, "a line may start at its data");
});

test("a KPI tile: the last value and its change from the row before", () => {
  const k = kpiOf({ columns: ["Month", "Revenue"], rows: [["Sep", 38], ["Oct", 42.6]] });
  assert.equal(k.value, 42.6); assert.equal(k.at, "Oct"); assert.equal(Math.round(k.change * 1000) / 10, 12.1);
  assert.equal(kpiOf({ columns: ["M", "V"], rows: [] }), null);
});

test("diagram words", () => {
  assert.equal(diagramType("timeline\n title x"), "Timeline");
  assert.equal(diagramType("%% note\ngraph LR\nA-->B"), "Flowchart");
  assert.equal(diagramType("mindmap\n root"), "Mind map");
  assert.equal(diagramType("gantt"), "Gantt chart");
});

test("what changed between two versions: blocks added, removed, a chart's type, series and rows, and the words", () => {
  const before = `<h2>Sales</h2><p>Old line</p>${block({ kind: "chart", id: "b_c1", type: "bar", title: "Leads", columns: ["City", "Leads"], rows: [["Pune", 96], ["Delhi", 62]] })}`
    + block({ kind: "diagram", id: "b_d1", title: "Plan", code: "timeline\n a : b" });
  const after = `<h2>Sales</h2><p>New line</p>${block({ kind: "chart", id: "b_c1", type: "line", title: "Leads", columns: ["City", "Leads", "Calls"], rows: [["Pune", 97, 3], ["Kochi", 36, 1]] })}`
    + block({ kind: "stat", id: "b_s1", items: [{ value: "9.4%", label: "Win rate" }] });
  assert.equal(blocksOf(after).length, 2);
  const c = blockChanges(before, after).map((x) => x.text);
  assert.ok(c.includes("Big numbers added"), c.join(" | "));
  assert.ok(c.includes("Diagram “Plan” removed"), c.join(" | "));
  const chart = c.find((x) => x.startsWith("Chart “Leads”"));
  assert.ok(chart && /type bar → line/.test(chart) && /series added: Calls/.test(chart) && /1 row added/.test(chart) && /1 row removed/.test(chart) && /1 row changed/.test(chart), chart);
  assert.ok(c.some((x) => x === "Words: 1 line added, 1 removed"), c.join(" | "));
  assert.deepEqual(blockChanges(after, after), []);
});
