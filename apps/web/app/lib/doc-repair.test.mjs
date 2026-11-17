// DOCS-GDOCS: stored docs with Markdown left in them (the faults of a real Google Docs import, written here with
// made-up words) read as formatting; clean docs come back unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { markdownLeftovers, parseHtml, repairDocHtml, writeHtml } from "./doc-repair.mjs";

// What marked made of a Google Docs export: one paragraph per line, "####" in cells, "****" between bold runs.
const IMPORTED = `<h2>Step 1: Who it is for</h2>
<p><strong>Our buyer in one line:</strong> the owner of a growing service business with a team of fifteen to fifty people, who can no longer watch everything.
<strong>Who:</strong> the founder of a service or project business, in any industry, with a working offer and a team that delivers.
<strong>What he wants</strong> (two outcomes):</p>
<ul>
<li><strong>Scale:</strong> more revenue and more profit.</li>
<li><strong>Systemise:</strong> a team that runs on systems, and his own time back, so the business grows without adding more people every month.
The second is how the first happens.
<strong>Who fits:</strong> three questions on the first call:</li>
<li>Does each sale start with a quotation?</li>
<li>Is the team's time what the client pays for?
Three yeses means a fit.</li>
</ul>
<ol>
<li>First step of the plan, written out in full so that the line is long enough to read as one paragraph per line.
A line that belongs after the list.</li>
<li>Second step</li>
</ol>
<ul>
<li><strong>Sample’s</strong>**$1M Growth Map****:** <strong>at ten people a business needs written steps;</strong> after that, more people stop helping.</li>
</ul>
<table>
<thead>
<tr>
<th>#### What buyers expect</th>
<th>#### Where it is covered</th>
</tr>
</thead>
<tbody><tr>
<td>#### Moving data across</td>
<td>### In the stack <em>(one place)</em></td>
</tr>
<tr>
<td>Plain cell</td>
<td><p>#### Inside a paragraph</p></td>
</tr>
</tbody></table>
<pre><code>**kept** as written
#### in code
</code></pre>`;

test("a Google Docs import reads as formatting: no Markdown left, every word kept", () => {
  assert.ok(markdownLeftovers(IMPORTED).length > 0, "the fixture has the faults");
  const out = repairDocHtml(IMPORTED);
  assert.deepEqual(markdownLeftovers(out), []);
  const words = (h) => h.replace(/<[^>]+>/g, " ").replace(/\*\*|#{2,6} /g, " ").replace(/\s+/g, " ").trim();
  assert.equal(words(out).replace(/ /g, ""), words(IMPORTED).replace(/ /g, ""), "every word is still there, in order");
  // one paragraph per line
  assert.match(out, /<p><strong>Our buyer in one line:<\/strong> the owner[^<]*<\/p><p><strong>Who:<\/strong>/);
  // the swallowed lines come after the list as paragraphs; the questions are a new list
  assert.match(out, /<li><strong>Systemise:<\/strong>[^<]*month\.<\/li><\/ul><p>The second is how the first happens\.<\/p><p><strong>Who fits:<\/strong> three questions on the first call:<\/p><ul>\s*<li>Does each sale/);
  assert.match(out, /<li>Is the team's time what the client pays for\?<\/li><\/ul><p>Three yeses means a fit\.<\/p>/);
  // numbering carries on after the paragraph
  assert.match(out, /<\/ol><p>A line that belongs after the list\.<\/p><ol start="2">\s*<li>Second step<\/li>/);
  // two bold runs side by side are one, with the lost space back
  assert.match(out, /<strong>Sample’s \$1M Growth Map:<\/strong> <strong>at ten people/);
  // cells: the heading marks are gone, the words bold
  assert.match(out, /<th><strong>What buyers expect<\/strong><\/th>/);
  assert.match(out, /<td><strong>Moving data across<\/strong><\/td>/);
  assert.match(out, /<td><strong>In the stack <em>\(one place\)<\/em><\/strong><\/td>/);
  assert.match(out, /<td><p><strong>Inside a paragraph<\/strong><\/p><\/td>/);
  // code is left exactly as written
  assert.match(out, /<pre><code>\*\*kept\*\* as written\n#### in code\n<\/code><\/pre>/);
});

test("clean docs and hand-wrapped Markdown are left alone", () => {
  const clean = '<h2>Plan</h2><p style="text-align: center">Hello <strong>there</strong></p><ul><li><p>One</p></li><li><p>Two</p></li></ul><table><tbody><tr><td><p>5</p></td></tr></tbody></table><p><img src="https://example.com/a.png" alt="a"></p>';
  assert.equal(repairDocHtml(clean), clean);
  // a paragraph wrapped at about 80 characters stays one paragraph
  const wrapped = "<p>This paragraph was written by hand in a text editor that wraps its lines at about\neighty characters, so each line is about as long as the one before it and the\nreader expects one paragraph, which is what Markdown makes of it in the end.</p>";
  assert.equal(repairDocHtml(wrapped), wrapped);
  // "## Heading" left as a paragraph becomes a heading; "**bold**" left as text becomes bold
  assert.equal(repairDocHtml("<p>## Next steps</p><p>Say **yes** today</p>"), "<h2>Next steps</h2><p>Say <strong>yes</strong> today</p>");
});

test("the small tree writes back what it read", () => {
  const html = '<p>a &amp; b<br>c</p><div data-type="pulse-block" data-block="{&quot;k&quot;:1}"></div><img src="/x.png" alt="x"><!-- note -->';
  assert.equal(writeHtml(parseHtml(html)), html.replace("<!-- note -->", ""));
  assert.equal(writeHtml(parseHtml("<p>stray </b> close</p>")), "<p>stray  close</p>");
});
