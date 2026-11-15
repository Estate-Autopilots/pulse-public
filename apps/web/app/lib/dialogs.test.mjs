// UI-DIALOGS: the logic under useConfirm(), usePrompt() and toast() (kit/dialogs.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmOptions, createDialogQueue, enterAnswers, firstFocus, isLink, normalizeLink, promptOptions, promptProblem, promptValue, toastNotice, typedMatches } from "./dialogs.mjs";

test("a confirm resolves true for the main button and false for Cancel; a prompt gives its text or null", async () => {
  const q = createDialogQueue();
  const yes = q.open("confirm", { title: "Archive this folder?", confirmLabel: "Archive folder" });
  assert.equal(q.current()?.kind, "confirm");
  q.answer(q.current().id, true);
  assert.equal(await yes, true);
  const no = q.open("confirm", { title: "Delete it?", confirmLabel: "Delete" });
  q.answer(q.current().id, false);
  assert.equal(await no, false);
  const named = q.open("prompt", { title: "Name the new folder", confirmLabel: "Create folder" });
  q.answer(q.current().id, "Contracts");
  assert.equal(await named, "Contracts");
  const dropped = q.open("prompt", { title: "Why?", confirmLabel: "Withdraw" });
  q.answer(q.current().id, null);
  assert.equal(await dropped, null);
  assert.equal(q.current(), null);
});

test("dialogs asked for together show one after another, in order", async () => {
  const q = createDialogQueue();
  let changes = 0;
  const off = q.subscribe(() => { changes += 1; });
  const a = q.open("confirm", { title: "First?", confirmLabel: "Yes" });
  const b = q.open("prompt", { title: "Second", confirmLabel: "Save" });
  assert.equal(q.size(), 2);
  assert.equal(q.current().options.title, "First?");
  assert.equal(q.answer(q.current().id + 1, "skipped"), true, "a waiting one can be answered by id");
  assert.equal(await b, "skipped");
  assert.equal(q.current().options.title, "First?", "the one on screen stays");
  q.answer(q.current().id, true);
  assert.equal(await a, true);
  assert.equal(q.answer(999, true), false, "an unknown id changes nothing");
  off();
  const before = changes;
  q.open("confirm", { title: "Third?", confirmLabel: "Yes" });
  assert.equal(changes, before, "no listener after unsubscribe");
});

test("going Back closes every dialog: confirms answer false, prompts null", async () => {
  const q = createDialogQueue();
  const a = q.open("confirm", { title: "A?", confirmLabel: "Yes" });
  const b = q.open("prompt", { title: "B", confirmLabel: "Save" });
  q.clear();
  assert.deepEqual(await Promise.all([a, b]), [false, null]);
  assert.equal(q.size(), 0);
});

test("confirm defaults: Cancel, a verb even when none was given, the name to type trimmed", () => {
  const o = confirmOptions({ title: "Archive the folder “Q4”?", confirmLabel: "Archive folder", danger: true, typeToConfirm: "  Q4  " });
  assert.equal(o.cancelLabel, "Cancel");
  assert.equal(o.danger, true);
  assert.equal(o.typeToConfirm, "Q4");
  assert.equal(confirmOptions({ title: "Go on?" }).confirmLabel, "Continue");
  assert.equal(confirmOptions({ title: "Go on?", typeToConfirm: "   " }).typeToConfirm, null);
  assert.equal(firstFocus("confirm", o), "input", "the box to type the name in gets focus");
  assert.equal(firstFocus("confirm", confirmOptions({ title: "x", confirmLabel: "Delete" })), "confirm", "else the main button, so Enter answers");
  assert.equal(firstFocus("prompt", {}), "input");
});

test("type the name to confirm: spaces at the ends, doubled spaces and capitals do not matter", () => {
  assert.equal(typedMatches("q4 plans", "Q4  Plans"), true);
  assert.equal(typedMatches("  Q4 Plans ", "Q4 Plans"), true);
  assert.equal(typedMatches("Q4 Plan", "Q4 Plans"), false);
  assert.equal(typedMatches("", ""), false, "nothing to type never matches");
});

test("prompt checks say what is wrong in plain words", () => {
  assert.equal(promptProblem("", { title: "Name", confirmLabel: "Save" }), "Please fill this in.");
  assert.equal(promptProblem("   ", { title: "Name", confirmLabel: "Save" }), "Please fill this in.", "spaces alone are empty");
  assert.equal(promptProblem("", { title: "Link", confirmLabel: "Save", required: false }), null);
  assert.equal(promptProblem("ab", { title: "Why?", confirmLabel: "Withdraw", minLength: 3 }), "Please use at least 3 characters.");
  assert.equal(promptProblem("abc", { title: "Why?", confirmLabel: "Withdraw", minLength: 3, maxLength: 300 }), null);
  assert.match(promptProblem("x".repeat(301), { title: "Why?", confirmLabel: "Withdraw", maxLength: 300 }), /300 characters or fewer \(now 301\)/);
  assert.equal(promptProblem("Team", { title: "Name", confirmLabel: "Save", validate: (v) => (v === "Team" ? "That name is taken." : null) }), "That name is taken.");
  // Every message is short and plain (6th-7th grade): no jargon, no codes.
  for (const m of [promptProblem("", { url: true }), promptProblem("nope", { url: true }), promptProblem("", {})]) {
    assert.ok(m && m.length < 90 && !/invalid|regex|format|null|undefined/i.test(m), m);
  }
});

test("links: example.com gets https://, other schemes are refused unless allowed", () => {
  assert.equal(normalizeLink("example.com/post/1"), "https://example.com/post/1");
  assert.equal(normalizeLink("https://x.com"), "https://x.com");
  assert.equal(normalizeLink("not a link"), "not a link");
  assert.equal(isLink("https://instagram.com/p/abc"), true);
  assert.equal(isLink("javascript:alert(1)"), false);
  assert.equal(isLink("mailto:ana@example.com"), false, "mailto only when asked for");
  assert.equal(isLink("mailto:ana@example.com", ["https:", "http:", "mailto:"]), true);
  assert.equal(isLink("https://nodot"), false);
  const link = { title: "Link to", confirmLabel: "Add link", url: ["https:", "http:", "mailto:"] };
  assert.equal(promptProblem("example.com", link), null);
  assert.equal(promptValue(" example.com ", link), "https://example.com");
  assert.match(promptProblem("javascript:alert(1)", link), /https:\/\/, http:\/\/ or mailto:/);
  assert.equal(promptValue("  Contracts  ", { title: "Name", confirmLabel: "Save" }), "Contracts", "answers are trimmed");
});

test("prompt defaults and normalising twice changes nothing", () => {
  const o = promptOptions({ title: "Why?", confirmLabel: "Withdraw", multiline: true, maxLength: 300, url: true });
  assert.deepEqual(o.url, ["https:", "http:"]);
  assert.equal(o.required, true);
  assert.equal(o.cancelLabel, "Cancel");
  assert.deepEqual(promptOptions(o), o);
  assert.equal(promptOptions({ title: "x", defaultValue: 5 }).defaultValue, "5");
});

test("Enter answers, except while composing, on a button or link, or with Shift in a box of several lines", () => {
  assert.equal(enterAnswers({ key: "Enter", tag: "INPUT" }), true);
  assert.equal(enterAnswers({ key: "Enter", tag: "DIALOG" }), true, "a confirm without a box");
  assert.equal(enterAnswers({ key: "Enter", tag: "INPUT", isComposing: true }), false);
  assert.equal(enterAnswers({ key: "Enter", tag: "BUTTON" }), false, "a focused Cancel presses itself");
  assert.equal(enterAnswers({ key: "Enter", tag: "TEXTAREA", multiline: true }), true);
  assert.equal(enterAnswers({ key: "Enter", tag: "TEXTAREA", multiline: true, shiftKey: true }), false);
  assert.equal(enterAnswers({ key: "a", tag: "INPUT" }), false);
});

test("toasts: an Error's words become the title, problems stay longer, an action is kept", () => {
  const e = toastNotice("error", new Error("Not created: the name is taken"));
  assert.equal(e.tone, "error");
  assert.equal(e.title, "Not created: the name is taken");
  assert.ok(e.timeout >= 8000);
  assert.equal(toastNotice("error", null).title, "Something went wrong");
  assert.equal(toastNotice("error", { message: "" }).title, "Something went wrong");
  const ok = toastNotice("success", "Folder made", { message: "In My docs" });
  assert.equal(ok.message, "In My docs");
  assert.ok(ok.timeout <= 4000);
  const run = () => {};
  const undo = toastNotice("success", "Archived", { action: { label: "Undo", run }, id: "undo-1" });
  assert.equal(undo.id, "undo-1");
  assert.equal(undo.action.run, run);
  assert.ok(undo.timeout > ok.timeout, "an Undo stays long enough to press");
  assert.equal(toastNotice("loud", "x").tone, "info");
  assert.notEqual(toastNotice("info", "a").id, toastNotice("info", "a").id, "each toast has its own id");
});
