// TWO-STEP-GUIDE (owner, 30 Oct 2026): the authenticator link names Pulse, the person and the organisation, so one
// person's entries for two organisations stay apart; a code typed as the apps show it ("123 456") is the code.
import assert from "node:assert/strict";
import test from "node:test";
import { otpCode, otpUri } from "../dist/auth-policy.js";

test("the authenticator link names the person and the organisation", () => {
  const uri = otpUri("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "datup.example", "Northwind Studio");
  assert.equal(uri, "otpauth://totp/Pulse:datup.example%20(Northwind%20Studio)?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Pulse&algorithm=SHA1&digits=6&period=30");
  assert.ok(uri.length < 271, "fits the QR code drawn in the browser");
  assert.match(otpUri("KEY", "staff", null), /^otpauth:\/\/totp\/Pulse:staff\?secret=KEY&/);
});

test("a code typed with a space or a dash is the code", () => {
  assert.equal(otpCode("123 456"), "123456");
  assert.equal(otpCode(" 123-456 "), "123456");
  assert.equal(otpCode("0a1b-2c3d 4e5f6a7b"), "0a1b2c3d4e5f6a7b");
});
