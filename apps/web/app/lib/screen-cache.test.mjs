// REPLAY-FIXES #1/#2: the screen cache's pure parts (lib/screen-cache.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { SCREEN_MAX_AGE_MS, createScreenCache, linkTarget, matchTap, moveKind, pageReady, screenKey, tapOf } from "./screen-cache.mjs";

const here = { href: "https://app.vitalsos.ai/chats?channel=abc" };

test("a screen's key is its path and query, without volatile keys, sorted, no hash or trailing slash", () => {
  assert.equal(screenKey("/dashboard", here.href), "/dashboard");
  assert.equal(screenKey("/dashboard/", here.href), "/dashboard");
  assert.equal(screenKey("/hr?view=leave&tab=policies#x", here.href), "/hr?tab=policies&view=leave");
  assert.equal(screenKey("/tasks?_rsc=1x&utm_source=mail", here.href), "/tasks");
  assert.equal(screenKey("/", here.href), "/");
});

test("only this app's screens have a key: not another site, the API, Next's files, sign-in pages or files", () => {
  for (const href of ["https://example.com/dashboard", "/api/v0/home", "/_next/static/x.js", "/login?next=/tasks", "/welcome", "/oauth/consent", "/photo/abc", "/files/x/download", "/report.pdf", "/accept/abc"])
    assert.equal(screenKey(href, here.href), null, href);
  assert.equal(screenKey("http://[bad", here.href), null);
});

test("a tap opens another screen only for a plain primary click on a same-site link to a different screen", () => {
  const link = (over = {}) => ({ href: "/dashboard", button: 0, mods: false, target: "", download: false, ...over });
  assert.equal(linkTarget(link(), here), "/dashboard");
  assert.equal(linkTarget(link({ target: "_self" }), here), "/dashboard");
  assert.equal(linkTarget(link({ target: "_blank" }), here), null, "new tab");
  assert.equal(linkTarget(link({ mods: true }), here), null, "Ctrl/⌘/Shift click");
  assert.equal(linkTarget(link({ button: 1 }), here), null, "middle click");
  assert.equal(linkTarget(link({ download: true }), here), null, "download");
  assert.equal(linkTarget(link({ href: "/chats?channel=abc#m1" }), here), null, "the same screen (a hash)");
  assert.equal(linkTarget(link({ href: "https://example.com/" }), here), null, "another site");
  assert.equal(linkTarget(null, here), null);
});

test("the store keeps the newest screens, refreshes one put again, and never returns a copy older than its age", () => {
  const c = createScreenCache({ max: 3 });
  c.put("/a", 1, 0); c.put("/b", 2, 0); c.put("/c", 3, 0);
  c.put("/a", 11, 10);             // /a is newest again
  c.put("/d", 4, 20);              // /b (the oldest) goes
  assert.deepEqual(c.keys(), ["/c", "/a", "/d"]);
  assert.equal(c.get("/b", 20), null);
  assert.equal(c.get("/a", 20).value, 11);
  assert.equal(c.get("/a", 10 + SCREEN_MAX_AGE_MS + 1), null, "too old: dropped");
  assert.equal(c.size, 2);
  c.put(null, 5); assert.equal(c.size, 2, "no key, not kept");
  c.drop("/c"); assert.deepEqual(c.keys(), ["/d"]);
  c.clear(); assert.equal(c.size, 0);
});

test("the real page takes over only on the tapped address and once no loading screen covers it", () => {
  assert.equal(pageReady({ here: "/chats", target: "/dashboard", busy: [], visible: 800 }), false, "still on the old address");
  assert.equal(pageReady({ here: "/dashboard", target: "/dashboard", busy: [700], visible: 800 }), false, "the route's loading screen");
  assert.equal(pageReady({ here: "/dashboard", target: "/dashboard", busy: [90, 200], visible: 800 }), true, "small busy panels inside a drawn page");
  assert.equal(pageReady({ here: "/dashboard", target: "/dashboard", busy: [], visible: 800 }), true);
  assert.equal(pageReady({ here: "/dashboard", target: "/dashboard", busy: [130], visible: 100 }), false, "a short screen: 120 px still counts as covering");
  assert.equal(pageReady({ here: "/x", target: null }), false);
});

test("a tap on the copy is matched on the real page by test id, nav id, link or words, never by guessing", () => {
  const page = [
    { tag: "button", role: "", label: "Check in" },
    { tag: "a", href: "/tasks/1", label: "Fix the roof" },
    { tag: "button", label: "Open" }, { tag: "button", label: "Open" },
    { tag: "button", testid: "new-task", label: "New" },
    { tag: "a", nav: "rail:home", href: "/dashboard", label: "Home" },
    { tag: "button", label: "" },
  ];
  assert.equal(matchTap(tapOf({ tag: "button", label: "Check  in " }), page), 0, "same words (spaces folded)");
  assert.equal(matchTap(tapOf({ tag: "a", href: "/tasks/1", label: "Fix the roof" }), page), 1);
  assert.equal(matchTap(tapOf({ tag: "button", testid: "new-task", label: "New" }), page), 4);
  assert.equal(matchTap(tapOf({ tag: "a", nav: "rail:home", href: "/dashboard", label: "Home" }), page), 5);
  assert.equal(matchTap(tapOf({ tag: "button", label: "Open", nth: 1 }), page, 2), 3, "the second of two, same count as the copy");
  assert.equal(matchTap(tapOf({ tag: "button", label: "Open", nth: 1 }), page, 3), -1, "the list changed: nothing is pressed");
  assert.equal(matchTap(tapOf({ tag: "button", label: "" }), page), -1, "no words, id or link: never matched");
  assert.equal(matchTap(tapOf({ tag: "button", label: "Delete" }), page), -1, "gone from the real page");
  assert.equal(matchTap(null, page), -1);
});

test("VITALS-SWEEP: another view of the same page (a tab, a chip) gets the thin bar too; typing in a page's own query does not", () => {
  // Production, 22-23 Nov 2026: Kazuk's Work tab (/tasks?view=…), Bevit's reviews chip and the owner's project view links
  // were dead clicks: the same page with another query showed nothing until the server answered.
  assert.equal(moveKind({ target: "/tasks?view=projects", current: "/tasks?view=mine", type: "push" }), "view");
  assert.equal(moveKind({ target: "/tasks?view=reviews", current: "/tasks", type: "push" }), "view");
  assert.equal(moveKind({ target: "/clients?q=ab", current: "/clients?q=a", type: "replace" }), null, "a page writing its own query (search as you type)");
  assert.equal(moveKind({ target: "/tasks?view=mine", current: "/tasks?view=mine", type: "push" }), null, "the same address: nothing moves");
  assert.equal(moveKind({ target: "/chats", current: "/tasks?view=mine", type: "push" }), "screen");
  assert.equal(moveKind({ target: "/chats", current: "/tasks", type: "replace" }), "screen");
  assert.equal(moveKind({ target: "/chats", current: null, type: "push" }), "screen");
  assert.equal(moveKind({ target: null, current: "/tasks", type: "push" }), null);
});
