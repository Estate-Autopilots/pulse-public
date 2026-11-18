// DOCS-GDOCS: Markdown as Google Docs, Word and chat answers write it becomes real formatting on import (built dist).
// The words are made up; the faults are the ones a real Google Docs import showed.
import assert from "node:assert/strict";
import test from "node:test";
import { onePerLine, tidyMarkdown, webPageHtml } from "../dist/doc-markdown.js";
await import("../dist/routes.js"); // the docs module is loaded the way the server loads it (its imports go in a circle)
const { cleanHtml, markdownToHtml } = await import("../dist/docs.js");

const GOOGLE = `## Step 1: Who it is for
**Our buyer in one line:** the owner of a growing service business with fifteen to fifty people, who can no longer watch everything.
**Who:** the founder of a service or project business, in any industry, with a working offer and a team that delivers.
- **Scale:** more revenue and more profit.
- **Systemise:** a team that runs on systems, and his own time back.
The second is how the first happens.
**Sample’s****$1M Growth Map****:** at ten people a business needs written steps.

| #### What buyers expect | #### Where it is covered |
| --- | --- |
| #### Moving data across | ### In the stack |
| Plain cell | 5 |

> A quoted line that is long enough to be a paragraph of its own in the source document.
> A second quoted line.

\`\`\`
**kept** as written
#### in code
\`\`\`
`;

test("a Google Docs export imports as paragraphs, lists, bold and clean table cells", () => {
  const html = cleanHtml(markdownToHtml(GOOGLE));
  assert.doesNotMatch(html.replace(/<pre>[\s\S]*?<\/pre>/g, ""), /\*\*|#{2,6} /, "no Markdown left outside code");
  assert.match(html, /<p><strong>Our buyer in one line:<\/strong>[^<]*everything\.<\/p>\s*<p><strong>Who:<\/strong>/);
  assert.match(html, /<li><strong>Systemise:<\/strong>[^<]*back\.<\/li>\s*<\/ul>\s*<p>The second is how the first happens\.<\/p>/);
  assert.match(html, /<strong>Sample’s<\/strong> <strong>\$1M Growth Map:<\/strong>/);
  assert.match(html, /<th><strong>What buyers expect<\/strong><\/th>/);
  assert.match(html, /<td><strong>In the stack<\/strong><\/td>/);
  assert.match(html, /<blockquote>\s*<p>A quoted line[^<]*<\/p>\s*<p>A second quoted line\.<\/p>\s*<\/blockquote>/);
  assert.match(html, /<pre><code>\*\*kept\*\* as written\n#### in code\n<\/code><\/pre>/);
});

test("hand-wrapped Markdown and AI Markdown with blank lines are read as before", () => {
  const wrapped = "This paragraph was written by hand in a text editor that wraps its lines at about\neighty characters, so each line is about as long as the one before it and the\nreader expects one paragraph.\n\n- one\n- two\n";
  assert.equal(onePerLine(wrapped.split("\n")), false);
  assert.equal(tidyMarkdown(wrapped), wrapped);
  const ai = "# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
  assert.equal(tidyMarkdown(ai), ai);
  assert.match(markdownToHtml(ai), /<p>First paragraph\.<\/p>\n<p>Second paragraph\.<\/p>/);
});

test("a Google Docs web page keeps its bold, italics and underline; its links go straight to the page", () => {
  const page = '<html><head><style>.c1{font-weight:700}.c2{font-style:italic;text-decoration:underline}.c9{color:#000000}</style></head><body><p class="c3"><span class="c1 c9">Who:</span><span class="c9"> founders </span><span class="c2">now</span> <a href="https://www.google.com/url?q=https://example.com/a%3Fb%3D1&amp;sa=D">link</a></p></body></html>';
  const html = cleanHtml(webPageHtml(page).replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, ""));
  assert.match(html, /<strong>Who:<\/strong>/);
  assert.match(html, /<em><u>now<\/u><\/em>/);
  assert.match(html, /href="https:\/\/example\.com\/a\?b=1"/);
});

test("Google Docs' toolbar formatting is kept, and only the palette's colours and checked styles", () => {
  const html = cleanHtml('<p style="text-align: center" data-indent="2">a <span data-color="red" style="font-size: 14pt">b</span> <mark data-color="yellow">c</mark></p>'
    + '<h2 style="text-align: right; color: red">d</h2><p style="position: fixed" data-indent="99"><span data-color="javascript" style="font-size: 900pt; background: url(x)">e</span></p><div data-type="page-break"></div>');
  assert.match(html, /<p style="text-align:center" data-indent="2">a <span data-color="red" style="font-size:14pt">b<\/span> <mark data-color="yellow">c<\/mark><\/p>/);
  assert.match(html, /<h2 style="text-align:right">d<\/h2>/);
  assert.match(html, /<p><span>e<\/span><\/p>/);
  assert.match(html, /<div data-type="page-break"><\/div>/);
});
