import assert from "node:assert/strict";
import test from "node:test";
import { hiddenValue, maskSecrets, scrubText, shakeDetector, shortcutAction, reportWords } from "./bug-report.mjs";

test("scrubText masks secrets, contacts and long opaque strings", () => {
  assert.equal(scrubText("token=abc123 sent to tara@example.test", 200), "[secret] sent to [email]");
  assert.equal(scrubText("call +91 98765 43210 now", 200), "call [phone] now");
  assert.equal(scrubText("Bearer abcdefghijklmnop", 200), "Bearer [token]");
  assert.equal(scrubText("a".repeat(50), 200), "[long]");
  assert.equal(scrubText("  two   lines\nhere ", 200), "two lines here");
  assert.equal(scrubText(42, 10), "");
});

test("maskSecrets keeps names and e-mail addresses on the picture, hides keys", () => {
  // The key is built at run time so no file holds a string shaped like a real key (the leak gate reads them).
  const fakeKey = ["sk", "live", "REDACTEDTESTKEY"].join("_");
  assert.equal(maskSecrets(`Tara tara@example.test ${fakeKey}`), "Tara tara@example.test [key]");
});

test("hiddenValue never shows what was typed", () => {
  assert.equal(hiddenValue("secret", true), "••••••");
  assert.equal(hiddenValue("", true), "");
  assert.equal(hiddenValue("EXMP0001234"), "•••••••••••");
  assert.equal(hiddenValue("x".repeat(100)).length, 24);
});

test("Ctrl+B opens the reporter, except in a text editor where it stays bold; Ctrl+Shift+B works everywhere", () => {
  assert.equal(shortcutAction({ key: "b", ctrlKey: true }, false), "open");
  assert.equal(shortcutAction({ key: "b", metaKey: true }, false), "open");
  assert.equal(shortcutAction({ key: "b", ctrlKey: true }, true), null);
  assert.equal(shortcutAction({ key: "B", ctrlKey: true, shiftKey: true }, true), "open");
  assert.equal(shortcutAction({ key: "b" }, false), null);
  assert.equal(shortcutAction({ key: "b", ctrlKey: true, altKey: true }, false), null);
  assert.equal(shortcutAction({ key: "c", ctrlKey: true }, false), null);
});

test("a shake is three alternating swings; a lift or a single jolt is not", () => {
  let t = 0;
  const shake = shakeDetector(() => t);
  assert.equal(shake(0, 0, 9.8), false); // at rest
  t += 100; assert.equal(shake(20, 0, 9.8), false); // one jolt
  t += 100; assert.equal(shake(0, 0, 9.8), false);
  t += 2000; assert.equal(shake(0, 0, 9.8), false); // the window passed: starts again
  const swing = (x) => { t += 120; return shake(x, 0, 9.8); };
  assert.equal(swing(25), false);
  assert.equal(swing(-25), false);
  assert.equal(swing(25), true);
  assert.equal(swing(-25), false, "never twice within five seconds");
});

// PM-BUILD-4 (USER-INSIGHT L12: 31 opens, 7 sends): signed in, a report that already shows the problem goes in one tap.
test("words are optional when the report already shows the problem (signed in only)", () => {
  assert.equal(reportWords("  The button did nothing  ", {}), "The button did nothing");
  for (const evidence of [{ picture: true }, { pins: 1 }, { errors: 2 }, { about: true }])
    assert.match(reportWords("  ", evidence), /^Sent in one tap, without words/);
  assert.equal(reportWords("", {}), null, "nothing to look at: words are needed");
  assert.equal(reportWords("", { signedOut: true, picture: true, errors: 3 }), null, "signed out: words are always needed");
  assert.equal(reportWords("Cannot sign in", { signedOut: true }), "Cannot sign in");
  assert.equal(reportWords(undefined, { pins: 0, errors: 0 }), null);
});
