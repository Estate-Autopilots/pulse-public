// DOCS-EDITOR-2: rows pasted from Google Sheets or Excel as text become a doc table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridHtml, looksLikeHeader, parseGrid, MAX_ROWS } from "./table-paste.mjs";

test("tab-separated lines are rows of cells; the copy's last line break adds no row", () => {
  assert.deepEqual(parseGrid("Task\tOwner\tDue\nShoot reel\tAsha\t20 Nov\nEdit reel\tRavi\t22 Nov\n"),
    [["Task", "Owner", "Due"], ["Shoot reel", "Asha", "20 Nov"], ["Edit reel", "Ravi", "22 Nov"]]);
  assert.deepEqual(parseGrid("a\tb\r\nc\td\r\n"), [["a", "b"], ["c", "d"]]);
});

test("a quoted cell keeps its line breaks, tabs and quotes (Excel and Sheets)", () => {
  assert.deepEqual(parseGrid("Name\tNote\n\"Lotus\nInteriors\"\t\"says \"\"yes\"\"\tnow\"\n"), [["Name", "Note"], ["Lotus\nInteriors", "says \"yes\"\tnow"]]);
});

test("plain words, one line or one column are not a table", () => {
  assert.equal(parseGrid("just words\nmore words"), null);
  assert.equal(parseGrid("a\tb\tc"), null);
  assert.equal(parseGrid(""), null);
  assert.equal(parseGrid(null), null);
});

test("short rows are padded; mostly ragged text is not a grid", () => {
  assert.deepEqual(parseGrid("a\tb\tc\nd\te\tf\ng\th\n"), [["a", "b", "c"], ["d", "e", "f"], ["g", "h", ""]]);
  assert.equal(parseGrid("a\tb\tc\td\nx\ny\tz\n"), null);
});

test("very large pastes are cut to the table limit", () => {
  const big = Array.from({ length: MAX_ROWS + 50 }, (_, i) => `r${i}\t${i}`).join("\n");
  assert.equal(parseGrid(big).length, MAX_ROWS);
});

test("the table's HTML: a header row when the first row reads as one, words escaped, line breaks as paragraphs", () => {
  const html = gridHtml([["Item", "Amount"], ["<b>Kitchen</b>", "1,85,000"], ["Two\nlines", "92,000"]]);
  assert.equal(html, "<table><tbody><tr><th><p>Item</p></th><th><p>Amount</p></th></tr><tr><td><p>&lt;b&gt;Kitchen&lt;/b&gt;</p></td><td><p>1,85,000</p></td></tr><tr><td><p>Two</p><p>lines</p></td><td><p>92,000</p></td></tr></tbody></table>");
  assert.equal(looksLikeHeader([["1,200", "300"], ["4", "5"]]), false);
  assert.match(gridHtml([["1", "2"], ["3", "4"]]), /^<table><tbody><tr><td>/);
  assert.match(gridHtml([["1", "2"], ["3", "4"]], { header: true }), /^<table><tbody><tr><th>/);
});
