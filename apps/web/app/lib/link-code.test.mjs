import assert from "node:assert/strict";
import test from "node:test";
import { linkSignInBody, pastedToken, typedCode } from "./link-code.mjs";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

test("a pasted sign-in link or its token alone is the link's token", () => {
  assert.equal(TOKEN.length, 43);
  for (const v of [TOKEN, ` ${TOKEN}\n`, `https://app.vitalsos.ai/login/link#${TOKEN}`, `pulse.example.com/login/link#${TOKEN}`]) assert.equal(pastedToken(v), TOKEN, v);
  for (const v of ["", "7KQM-2RXD", TOKEN.slice(1), `${TOKEN}x`, `https://evil.example/#${TOKEN}`, `/login/set-password#${TOKEN}`, null, undefined])
    assert.equal(pastedToken(v), "", String(v));
});

test("a code is 8 of the unambiguous letters and digits, any case, spaces and dashes ignored", () => {
  for (const [v, want] of [["7KQM-2RXD", "7KQM2RXD"], ["7kqm 2rxd", "7KQM2RXD"], [" 7KQM2RXD ", "7KQM2RXD"], ["ab-cd-ef-gh", "ABCDEFGH"]]) assert.equal(typedCode(v), want, v);
  // 0, 1, I, L, O and U are never in a code (too easy to misread); 7 or 9 characters are not a code.
  for (const v of ["7KQM-2RX0", "7KQM-2RX1", "IKQM2RXD", "LKQM2RXD", "OKQM2RXD", "UKQM2RXD", "7KQM2RX", "7KQM2RXD9", "", null]) assert.equal(typedCode(v), "", String(v));
});

test("Sign in sends the link's token alone, or the username with the code; otherwise it says what is missing", () => {
  assert.deepEqual(linkSignInBody({ username: "", entry: `https://app.vitalsos.ai/login/link#${TOKEN}` }), { body: { token: TOKEN, code: "" } });
  assert.deepEqual(linkSignInBody({ username: " qa.seller ", entry: "7kqm-2rxd", otp: "123456" }), { body: { username: "qa.seller", signInCode: "7KQM2RXD", code: "123456" } });
  assert.match(linkSignInBody({ username: "", entry: "7KQM-2RXD" }).error, /username/);
  assert.match(linkSignInBody({ username: "qa.seller", entry: "hello" }).error, /8-character code/);
});
