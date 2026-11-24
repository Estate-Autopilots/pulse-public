// PM-BUILD-4 (23 Nov 2026): under load the bug kit walk's sign-in form was sent before the page's script took over, as a
// GET with the password in the address (/login?username=…&password=…). Every sign-in form that carries a password or a
// code says method="post", so an early press never puts them in the address, history or logs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const file of ["../login/form.tsx", "../login/account-links.tsx", "../login/code-sign-in.tsx"]) {
  test(`${file.slice(3)}: every <form> posts`, () => {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const forms = src.match(/<form\b[^>]*>/g) ?? [];
    assert.ok(forms.length > 0, "the file has a form");
    for (const f of forms) assert.match(f, /method="post"/, f);
  });
}
