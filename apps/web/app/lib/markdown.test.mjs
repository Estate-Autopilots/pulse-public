import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown, plain, safeHref } from "./markdown.mjs";

const POLICY = `# Synthetic Leave Policy

Version 1 (draft) · Synthetic
Items marked **(confirm)** need confirmation.

## 1. Leave entitlement

- Two synthetic days a month, carried up to **12 days** **(confirm)**. Leave above the
  limit lapses on 31 March.
- Half days count as 0.5.

## 2. Types of leave

| Type | How it works |
| --- | :-: |
| Paid leave | From the monthly entitlement |
| Paternity leave | 5 working days **(confirm)** |

## 3. Applying

1. Apply in **Pulse → My desk → Leave**.
   - 1–2 days: 3 working days ahead.
   - 3 or more days: 2 weeks ahead.
2. Your Pod Head approves.

### 3.1 Emergencies

> Call your Pod Head *as early as possible*.

---

Raw <script>alert(1)</script> stays text; [a link](javascript:alert(1)) loses its address; [help](/hr/help) works.
`;

test("headings get unique anchors and an outline", () => {
  const doc = parseMarkdown(POLICY + "\n## 1. Leave entitlement\n");
  const headings = doc.blocks.filter((b) => b.type === "heading");
  assert.deepEqual(headings.map((h) => [h.level, h.id]), [[1, "synthetic-leave-policy"], [2, "1-leave-entitlement"], [2, "2-types-of-leave"], [2, "3-applying"], [3, "3-1-emergencies"], [2, "1-leave-entitlement-2"]]);
  assert.deepEqual(doc.outline.map((o) => o.text), ["Synthetic Leave Policy", "1. Leave entitlement", "2. Types of leave", "3. Applying", "3.1 Emergencies", "1. Leave entitlement"]);
});

test("the first line under the title is a byline of its own", () => {
  const [, byline, intro] = parseMarkdown(POLICY).blocks;
  assert.equal(plain(byline.children), "Version 1 (draft) · Synthetic");
  assert.equal(plain(intro.children), "Items marked (confirm) need confirmation.");
  assert.equal(parseMarkdown("# T\n\nOne line only").blocks.length, 2);
});

test("lists keep continuation lines and nesting", () => {
  const lists = parseMarkdown(POLICY).blocks.filter((b) => b.type === "list");
  assert.equal(lists[0].ordered, false);
  assert.equal(lists[0].items.length, 2);
  assert.match(plain(lists[0].items[0].children[0].children), /Leave above the limit lapses on 31 March\.$/);
  assert.equal(lists[1].ordered, true);
  assert.equal(lists[1].items.length, 2);
  const nested = lists[1].items[0].children.find((c) => c.type === "list");
  assert.equal(nested.ordered, false);
  assert.deepEqual(nested.items.map((i) => plain(i.children[0].children)), ["1–2 days: 3 working days ahead.", "3 or more days: 2 weeks ahead."]);
});

test("tables become header, alignment and rows of cells", () => {
  const table = parseMarkdown(POLICY).blocks.find((b) => b.type === "table");
  assert.deepEqual(table.head.map(plain), ["Type", "How it works"]);
  assert.deepEqual(table.align, [null, "center"]);
  assert.deepEqual(table.rows.map((r) => r.map(plain)), [["Paid leave", "From the monthly entitlement"], ["Paternity leave", "5 working days (confirm)"]]);
  assert.equal(parseMarkdown("| a | b |\n| --- | --- |\n| x \\| y | z |").blocks[0].rows[0].map(plain)[0], "x | y");
});

test("confirmation items list each question once, not the sentence explaining the marker", () => {
  const { confirm } = parseMarkdown(POLICY);
  assert.deepEqual(confirm.map((c) => [c.section, c.text]), [
    ["1. Leave entitlement", "Two synthetic days a month, carried up to 12 days (confirm). Leave above the limit lapses on 31 March."],
    ["2. Types of leave", "Paternity leave — 5 working days (confirm)"],
  ]);
  assert.equal(confirm[0].sectionId, "1-leave-entitlement");
});

test("inline formatting, quotes and rules", () => {
  assert.deepEqual(parseInline("**bold** and *em* and `code`").map((n) => n.type), ["strong", "text", "em", "text", "code"]);
  assert.deepEqual(parseInline("snake_case_name stays text"), [{ type: "text", text: "snake_case_name stays text" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
  const doc = parseMarkdown(POLICY);
  assert.ok(doc.blocks.some((b) => b.type === "quote" && b.children[0].children.some((n) => n.type === "em")));
  assert.ok(doc.blocks.some((b) => b.type === "rule"));
});

test("no HTML or unsafe address gets through", () => {
  const last = parseMarkdown(POLICY).blocks.at(-1);
  assert.equal(last.type, "paragraph");
  assert.ok(plain(last.children).includes("<script>alert(1)</script>"));
  const links = last.children.filter((n) => n.type === "link");
  assert.deepEqual(links.map((l) => l.href), ["/hr/help"]);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example"), null);
  assert.equal(safeHref("https://example.test/x"), "https://example.test/x");
  assert.equal(safeHref("mailto:hr@example.test"), "mailto:hr@example.test");
});

test("plain text from a flat document still reads as paragraphs and lists", () => {
  const doc = parseMarkdown("Draft — not published\n\n1. First item\n\n2. Second item\n\nClosing line.");
  assert.deepEqual(doc.blocks.map((b) => b.type), ["paragraph", "list", "paragraph"]);
  assert.equal(doc.blocks[1].items.length, 2);
  assert.equal(doc.blocks[1].loose, true);
});
