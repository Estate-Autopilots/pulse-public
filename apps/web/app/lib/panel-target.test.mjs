import test from "node:test";
import assert from "node:assert/strict";
import { embedPath, frameAllowed, panelTarget, stripEmbed, titleForPath } from "./panel-target.mjs";

const ORIGIN = "https://pulse-dev.example.com";

test("a Pulse page opens inside the panel with embed=1", () => {
  const t = panelTarget("/tasks?scope=me", ORIGIN);
  assert.equal(t.kind, "page");
  assert.equal(t.src, "/tasks?scope=me&embed=1");
  assert.equal(t.href, "/tasks?scope=me");
  assert.equal(t.title, "Work");
  assert.equal(panelTarget(`${ORIGIN}/people/abc?tab=info&embed=1`, ORIGIN).href, "/people/abc?tab=info", "own full address, embed stripped");
  assert.equal(panelTarget("/tasks/projects/p1", ORIGIN).title, "Project");
});

test("the chat, sign-in and API addresses never open as a page", () => {
  assert.equal(panelTarget("/chats?channel=x", ORIGIN), null);
  assert.equal(panelTarget("/login", ORIGIN), null);
  assert.equal(panelTarget("/api/v0/people", ORIGIN), null);
  assert.equal(panelTarget("/api/v0/chats/files/abc123def", ORIGIN).kind, "file", "a chat file is a file");
});

test("Google Docs, Sheets, Slides and Forms open in Google's preview", () => {
  const doc = panelTarget("https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit?usp=sharing", ORIGIN);
  assert.equal(doc.kind, "gdoc"); assert.equal(doc.src, "https://docs.google.com/document/d/1AbCdEfGhIjKlMn/preview");
  assert.equal(doc.href, "https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit"); assert.equal(doc.title, "Google Doc");
  assert.equal(panelTarget("https://docs.google.com/spreadsheets/d/1SheetIdHere00/edit#gid=0", ORIGIN).src, "https://docs.google.com/spreadsheets/d/1SheetIdHere00/preview");
  assert.equal(panelTarget("https://docs.google.com/forms/d/e/1FAIpQLSform00/viewform", ORIGIN).src, "https://docs.google.com/forms/d/e/1FAIpQLSform00/viewform?embedded=true");
});

test("Drive files and folders open in Drive's own preview", () => {
  assert.equal(panelTarget("https://drive.google.com/file/d/1FileIdAbcdef/view?usp=drive_link", ORIGIN).src, "https://drive.google.com/file/d/1FileIdAbcdef/preview");
  assert.equal(panelTarget("https://drive.google.com/open?id=1FileIdAbcdef", ORIGIN).kind, "drive-file");
  const folder = panelTarget("https://drive.google.com/drive/u/0/folders/1FolderIdAbc", ORIGIN);
  assert.equal(folder.kind, "drive-folder"); assert.equal(folder.src, "https://drive.google.com/embeddedfolderview?id=1FolderIdAbc#list");
});

test("other addresses are framed if allowed; unsafe ones are refused", () => {
  assert.equal(panelTarget("example.com/docs", ORIGIN).src, "https://example.com/docs");
  assert.equal(panelTarget("http://example.com", ORIGIN).embed, false, "plain http is a card, never framed");
  assert.equal(panelTarget("javascript:alert(1)", ORIGIN), null);
  assert.equal(panelTarget("data:text/html,hi", ORIGIN), null);
  assert.equal(panelTarget("just some words", ORIGIN), null);
  assert.equal(panelTarget("file:../../etc", ORIGIN), null);
});

test("embed=1 is added and removed keeping the query and hash", () => {
  assert.equal(embedPath("/me?tab=leave#x"), "/me?tab=leave&embed=1#x");
  assert.equal(stripEmbed("/me?embed=1&tab=leave"), "/me?tab=leave");
  assert.equal(stripEmbed("/me?embed=1"), "/me");
  assert.equal(titleForPath("/finance?tab=revenue"), "Finance");
});

test("a site's headers decide whether it can be framed", () => {
  assert.equal(frameAllowed({ "x-frame-options": "DENY" }, ORIGIN), false);
  assert.equal(frameAllowed({ "x-frame-options": "SAMEORIGIN" }, ORIGIN), false);
  assert.equal(frameAllowed({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }, ORIGIN), false);
  assert.equal(frameAllowed({ "content-security-policy": "frame-ancestors https://*.example.com" }, ORIGIN), true);
  assert.equal(frameAllowed({ "content-security-policy": "frame-ancestors *" }, ORIGIN), true);
  assert.equal(frameAllowed({}, ORIGIN), true);
});
