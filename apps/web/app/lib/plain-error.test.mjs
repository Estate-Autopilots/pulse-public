import { test } from "node:test";
import assert from "node:assert/strict";
import { plainError, UNUSUAL_ADDRESS } from "./plain-error.mjs";

test("SIGNED-OUT-SHELL: the proxy's 'Invalid origin' reads as plain words; other texts stand", () => {
  assert.equal(plainError("Invalid origin"), UNUSUAL_ADDRESS);
  assert.equal(plainError(" Invalid origin "), UNUSUAL_ADDRESS);
  assert.match(UNUSUAL_ADDRESS, /^This page was opened from an unusual address\. Open Pulse from its usual link and try again\.$/);
  assert.equal(plainError("Type the 6 digits from the e-mail."), "Type the 6 digits from the e-mail.");
  assert.equal(plainError(undefined), "");
});
