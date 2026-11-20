import { test } from "node:test";
import assert from "node:assert/strict";
import { canDropFolders, countWords, descendants, docType, dropKind, highlight, nextIndex, pathTo, selectWith, snippetParts, sortRows, whoWords } from "./docs-drive.mjs";

const folders = [
  { id: "company", name: "Company", parentId: null },
  { id: "offer", name: "Offer", parentId: "company" },
  { id: "stage2", name: "Stage 2", parentId: "offer" },
  { id: "sops", name: "SOPs", parentId: null },
];

test("a doc's type comes from its category, with Doc for anything else", () => {
  assert.equal(docType("Meeting notes"), "meeting");
  assert.equal(docType("SOP"), "sop");
  assert.equal(docType("Offer"), "offer");
  assert.equal(docType("Legal"), "contract");
  assert.equal(docType("Policy"), "policy");
  assert.equal(docType(null), "doc");
  assert.equal(docType("Idea"), "doc");
});

test("the list sorts by a column, folders first, empty values last", () => {
  const rows = [
    { key: "d1", kind: "doc", name: "Pricing notes", owner: "Ravi", updatedAt: "2026-11-08T10:00:00Z", access: "company", tags: ["sales"] },
    { key: "d2", kind: "doc", name: "Discovery call", owner: null, updatedAt: "2026-11-07T10:00:00Z", access: "private", tags: [] },
    { key: "f1", kind: "folder", name: "Stage 2" },
    { key: "d3", kind: "doc", name: "Agenda 10", owner: "Mia", updatedAt: "2026-11-08T12:00:00Z", access: "people", tags: ["client"] },
    { key: "d4", kind: "doc", name: "Agenda 9", owner: "Mia", updatedAt: "2026-11-01T12:00:00Z", access: "people", tags: ["client"] },
  ];
  assert.deepEqual(sortRows(rows, "name", "asc").map((r) => r.key), ["f1", "d4", "d3", "d2", "d1"]);
  assert.deepEqual(sortRows(rows, "updated", "desc").map((r) => r.key), ["f1", "d3", "d1", "d2", "d4"]);
  assert.deepEqual(sortRows(rows, "owner", "asc").map((r) => r.key), ["f1", "d4", "d3", "d1", "d2"]);
  assert.deepEqual(sortRows(rows, "access", "asc").map((r) => r.key), ["f1", "d2", "d4", "d3", "d1"]);
});

test("click picks one, Ctrl adds or takes off, Shift picks a range from the anchor", () => {
  const order = ["a", "b", "c", "d", "e"];
  let s = selectWith(order, new Set(), null, "b", {});
  assert.deepEqual([...s.selected], ["b"]);
  s = selectWith(order, s.selected, s.anchor, "d", { shift: true });
  assert.deepEqual([...s.selected], ["b", "c", "d"]);
  s = selectWith(order, s.selected, s.anchor, "c", { toggle: true });
  assert.deepEqual([...s.selected].sort(), ["b", "d"]);
  s = selectWith(order, s.selected, "a", "a", {});
  assert.deepEqual([...s.selected], ["a"]);
});

test("a folder never goes inside itself or one of its own folders", () => {
  assert.deepEqual([...descendants(folders, "company")].sort(), ["offer", "stage2"]);
  assert.equal(canDropFolders(folders, ["company"], "stage2"), false);
  assert.equal(canDropFolders(folders, ["offer"], "offer"), false);
  assert.equal(canDropFolders(folders, ["offer"], "company"), false, "already there");
  assert.equal(canDropFolders(folders, ["offer"], "sops"), true);
  assert.equal(canDropFolders(folders, ["stage2"], null), true);
  assert.equal(canDropFolders(folders, [], "sops"), true, "docs only");
});

test("the way up from a folder, and what a folder holds in words", () => {
  assert.deepEqual(pathTo(folders, "stage2").map((f) => f.name), ["Company", "Offer", "Stage 2"]);
  assert.deepEqual(pathTo(folders, null), []);
  assert.equal(countWords({ docs: 4, folders: 0, files: 0 }), "4 docs");
  assert.equal(countWords({ docs: 1, folders: 2, files: 1 }), "1 doc · 2 folders · 1 file");
  assert.equal(countWords({ docs: 0, folders: 0, files: 0 }), "Empty");
});

test("matching words are highlighted in titles and in the server's snippets", () => {
  assert.deepEqual(highlight("Offer stage 2 pricing", "pricing offer"), [{ text: "Offer", hit: true }, { text: " stage 2 ", hit: false }, { text: "pricing", hit: true }]);
  assert.deepEqual(highlight("Plan", "a"), [{ text: "Plan", hit: false }]);
  assert.deepEqual(highlight("a+b (c)", "(c)"), [{ text: "a+b ", hit: false }, { text: "(c)", hit: true }]);
  assert.deepEqual(snippetParts("the «price» band is «INR»"), [{ text: "the ", hit: false }, { text: "price", hit: true }, { text: " band is ", hit: false }, { text: "INR", hit: true }]);
});

test("a dropped file becomes a doc, a zip of docs or a kept file; programs are refused", () => {
  assert.equal(dropKind("Notes.MD"), "doc");
  assert.equal(dropKind("Offer.docx"), "doc");
  assert.equal(dropKind("vitals.zip"), "zip");
  assert.equal(dropKind("price list.pdf"), "file");
  assert.equal(dropKind("setup.exe"), "blocked");
});

test("arrow keys move through the grid by rows and columns", () => {
  assert.equal(nextIndex(0, "ArrowRight", 3, 7), 1);
  assert.equal(nextIndex(1, "ArrowDown", 3, 7), 4);
  assert.equal(nextIndex(5, "ArrowDown", 3, 7), 6);
  assert.equal(nextIndex(1, "ArrowUp", 3, 7), 0);
  assert.equal(nextIndex(-1, "ArrowDown", 3, 7), 0);
  assert.equal(nextIndex(3, "End", 1, 7), 6);
  assert.equal(nextIndex(0, "ArrowDown", 1, 0), -1);
});

test("who can see a doc, in plain words", () => {
  assert.equal(whoWords("private", 0, null), "Only you");
  assert.equal(whoWords("company", 0, null), "Everyone");
  assert.equal(whoWords("company", 0, "Legal"), "People in Legal");
  assert.equal(whoWords("people", 3, null), "3 people");
});
