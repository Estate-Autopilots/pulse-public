// DOCS-POLISH: "Make this doc richer" on the API side (built dist). A synthetic Markdown report like the ones people import
// or Claude writes: a price table with a Total row, a "Key numbers" list, dated steps, a numbered process, a comparison
// table, an appendix. Checks what is offered, that applying keeps every word and invents no number, that the result passes
// the sanitiser, and that a second run offers nothing new. Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
let richer = null, missing = "";
try { richer = await import("../dist/doc-richer.js"); } catch (e) { if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; missing = `htmlparser2 is not installed in this checkout (bash ~/work/pulse/lane-deps.sh): ${String(e.message).slice(0, 80)}`; }
import { blocksIn } from "../dist/doc-blocks.js";
import "../dist/doc-rich.js"; // first, as doc-rich.test.mjs does: entering through docs.js first trips the routes ↔ v1-docs import cycle
import { cleanHtml, htmlToMarkdown, markdownToHtml } from "../dist/docs.js";

const appendix = Array.from({ length: 30 }, (_, i) => `Visit ${i + 1} was logged by the field team with the site address and time.`).join(" ");
const REPORT = `# Field kit plan (synthetic)

Three kits for the pilot sites.

## Key numbers

- Sites in the pilot: 12
- Kit budget: ₹4.2 L
- Battery life: 18 hours (per charge)

## Kit prices

| Kit | Price (₹) | Units |
| --- | --- | --- |
| Starter kit | 1245000 | 4 |
| Field kit | 2,150,000 | 6 |
| Pro kit | 31,500 | 2 |
| Total | 3426500 | 12 |

## Rollout

- Week 1: Order the kits
- Week 2: Set up two pilot sites
- Week 4: Train the field team
- Week 6: Review and decide

## How it works

1. A visitor scans the code
2. The kit records the visit
3. The manager sees it in Pulse

## Vendors compared

| Vendor | Support | Warranty |
| --- | --- | --- |
| Lotus Supplies | Phone and visit | One year |
| Harbor Tech | Phone only | Two years |

## Appendix

${appendix}
`;

const numbersIn = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ""));

test("a plain report gets a chart, big numbers, a timeline, a diagram, a toggle and Indian amounts; the comparison table stays", { skip: missing || false }, () => {
  const html = cleanHtml(markdownToHtml(REPORT));
  const r = richer.suggestRicher(html);
  const kinds = r.suggestions.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ["chart", "diagram", "numbers", "stat", "stat", "timeline", "toggle"], JSON.stringify(r.suggestions.map((s) => [s.kind, s.title])));
  assert.equal(r.kept.tables, 1, "the vendors table has no numbers: it stays a table");
  const chart = r.suggestions.find((s) => s.kind === "chart");
  assert.equal(chart.block.type, "bar");
  assert.deepEqual(chart.block.columns, ["Kit", "Price (₹)"], "like with like: the money column, the units column stays in the table");
  assert.deepEqual(chart.block.rows, [["Starter kit", 1245000], ["Field kit", 2150000], ["Pro kit", 31500]], "the Total row is left out; values as written");
  assert.match(chart.detail, /“Units” column stays in the table only/);
  assert.match(chart.detail, /total row is left out/);
  const total = r.suggestions.find((s) => s.kind === "stat" && s.block.items[0].label.startsWith("Total"));
  assert.deepEqual(total.block.items.map((i) => [i.value, i.label]), [["34,26,500", "Total price (₹)"]], "the Total row's amount as written (Indian commas)");
  const key = r.suggestions.find((s) => s.kind === "stat" && s.block.items[0].label === "Sites in the pilot");
  assert.deepEqual(key.block.items.map((i) => [i.label, i.value, i.delta]), [["Sites in the pilot", "12", ""], ["Kit budget", "₹4.2 L", ""], ["Battery life", "18 hours", "per charge"]]);
  const tl = r.suggestions.find((s) => s.kind === "timeline");
  assert.deepEqual(tl.block.steps.map((s) => [s.date, s.text]), [["Week 1", "Order the kits"], ["Week 2", "Set up two pilot sites"], ["Week 4", "Train the field team"], ["Week 6", "Review and decide"]]);
  const dg = r.suggestions.find((s) => s.kind === "diagram");
  assert.match(dg.block.code, /^flowchart LR\n {2}s1\["A visitor scans the code"\]/);
  const tg = r.suggestions.find((s) => s.kind === "toggle");
  assert.equal(tg.on, true); assert.match(tg.title, /Appendix/);
  const nb = r.suggestions.find((s) => s.kind === "numbers");
  assert.deepEqual(nb.examples, ["1245000 → 12,45,000", "2,150,000 → 21,50,000", "3426500 → 34,26,500"]);
  assert.ok(!nb.examples.some((e) => e.startsWith("31,500")), "31,500 is the same either way");
});

test("applying keeps every word, invents no number, passes the sanitiser and offers nothing new the second time", { skip: missing || false }, () => {
  const html = cleanHtml(markdownToHtml(REPORT));
  const before = richer.suggestRicher(html);
  const out = richer.applyRicher(html, "all");
  assert.equal(out.missing.length, 0);
  assert.equal(out.applied.length, before.suggestions.filter((s) => s.on).length);
  const clean = cleanHtml(out.html);
  assert.equal(clean, out.html, "the result is exactly what the sanitiser keeps");
  const blocks = blocksIn(clean);
  assert.deepEqual(blocks.map((b) => b.kind), ["stat", "stat", "chart", "timeline", "diagram"]);
  // No number appears that the doc did not already hold.
  const had = new Set(numbersIn(markdownToHtml(REPORT)));
  for (const b of blocks) for (const n of numbersIn(JSON.stringify({ ...b, id: "" }))) assert.ok(had.has(n) || had.has(String(Number(n))), `invented number ${n} in ${b.kind}`);
  // Every word is still there (the tables and the process list stay; lists turned into blocks keep their words in the block).
  const md = htmlToMarkdown(clean);
  for (const w of ["Three kits for the pilot sites", "Starter kit", "12,45,000", "21,50,000", "34,26,500", "Lotus Supplies", "Two years", "A visitor scans the code", "Order the kits", "per charge", "Visit 30 was logged"]) assert.ok(md.includes(w), `kept: ${w}`);
  assert.match(clean, /<details data-type="toggle"><summary>Appendix<\/summary><div data-type="toggle-content">/);
  assert.equal(richer.suggestRicher(clean).suggestions.length, 0, "a second run offers nothing");
  // Choosing: only the chart; an id the doc no longer has is reported, not guessed.
  const chartId = before.suggestions.find((s) => s.kind === "chart").id;
  const one = richer.applyRicher(html, [chartId, "chart_000000000000"]);
  assert.deepEqual(one.missing, ["chart_000000000000"]);
  assert.deepEqual(blocksIn(cleanHtml(one.html)).map((b) => b.kind), ["chart"]);
});

test("words that look like dates or numbers are left alone", { skip: missing || false }, () => {
  const html = cleanHtml(markdownToHtml(`## Notes\n\n- Marketing: launch the ads\n- Monitoring: check the vans\n- Call 9876543210 for help\n\n| Name | Phone |\n| --- | --- |\n| Asha | 9876543210 |\n| Ravi | 9123456780 |\n\n1. Do this\n2. Then that\n3. Done`));
  const r = richer.suggestRicher(html);
  assert.deepEqual(r.suggestions, [], JSON.stringify(r.suggestions.map((s) => s.title)));
  assert.equal(richer.readNumber("Rs. 40,000/-").value, 40000);
  assert.deepEqual(richer.readNumber("₹1.1 Cr"), { value: 1.1, unit: "₹ crore" });
  assert.equal(richer.indianGroup("123456789.50"), "12,34,56,789.50");
});
