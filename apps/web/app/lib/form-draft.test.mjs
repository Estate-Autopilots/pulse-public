import assert from "node:assert/strict";
import test from "node:test";
import { draftKey, keptAgo, offerDraft, resumeList } from "./form-draft.mjs";

// Made-up record ids, built so no id literal sits in the source.
const ID = ["0f4c2d6e", "aaaa", "4bbb", "8ccc", "dddddddddddd"].join("-"), ID2 = ID.replace(/^0/, "1");

test("a draft key is the form's kind and the record's id, and nothing else", () => {
  assert.equal(draftKey("erp", ID.toUpperCase()), `erp-${ID}`);
  assert.equal(draftKey("new-project"), "new-project");
  assert.equal(draftKey("", "x"), null);
  assert.equal(draftKey("erp", "../../etc"), null);
  assert.equal(draftKey("a"), null);
});

test("a kept draft is offered back only when it is newer than the record's own save", () => {
  const d = { data: { notes: "half typed" }, updatedAt: "2026-11-06T10:05:00Z" };
  assert.equal(offerDraft(d, "2026-11-06T10:00:00Z"), true);
  assert.equal(offerDraft(d, "2026-11-06T10:06:00Z"), false);
  assert.equal(offerDraft(d, null), true);
  assert.equal(offerDraft({ data: {}, updatedAt: d.updatedAt }, null), false);
  assert.equal(offerDraft(null, null), false);
  assert.equal(offerDraft({ data: { a: 1 }, updatedAt: "not a date" }, null), false);
});

test("how long ago a draft was kept, in plain words", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(keptAgo("2026-11-06T11:59:40Z", now), "just now");
  assert.equal(keptAgo("2026-11-06T11:59:00Z", now), "1 minute ago");
  assert.equal(keptAgo("2026-11-06T11:15:00Z", now), "45 minutes ago");
  assert.equal(keptAgo("2026-11-06T09:00:00Z", now), "3 hours ago");
  assert.equal(keptAgo("2026-11-04T12:00:00Z", now), "2 days ago");
  assert.equal(keptAgo("", now), "");
});

test("resume lists forms and Billing drafts newest first, one row per quotation", () => {
  const id = ID;
  const rows = resumeList(
    [{ key: `erp-${id}`, title: "QT draft · Synthetic Towers", href: `/erp/documents/${id}`, updatedAt: "2026-11-06T10:05:00Z" },
     { key: "new-project", title: "New project: Office move", href: "/tasks?view=projects&newProject=1", updatedAt: "2026-11-06T09:00:00Z" }],
    [{ id, docType: "quotation", number: null, buyer: "Synthetic Towers", updatedAt: "2026-11-06T10:00:00Z" },
     { id: ID2, docType: "invoice", number: "INV/26-27/0009", buyer: null, updatedAt: "2026-11-06T11:00:00Z" }],
    { quotation: "quotation", invoice: "tax invoice" });
  assert.deepEqual(rows.map((r) => r.title), ["INV/26-27/0009", "QT draft · Synthetic Towers", "New project: Office move"]);
  assert.equal(rows[0].what, "Tax invoice draft");
  assert.equal(rows[1].what, "Unfinished form");
  assert.equal(resumeList([], [], {}).length, 0);
});
