import assert from "node:assert/strict";
import test from "node:test";
import { safeNext } from "./safe-next.mjs";

test("return paths that leave Pulse, or go back to sign-in or the API, are refused", () => {
  for (const next of [
    "/%09/evil.example", "/\t/evil.example", "/%0a/evil.example", "/\n/evil.example", "/%0d%0a/evil.example", "/%7f/x",
    "//evil.example", "//x", "/\\x", "/\\evil.example", "/%5cevil.example", "/%2F/evil.example", "https://evil.example",
    "evil.example", "", "/login", "/login?change=1", "/login/set-password", "/x/../login", "/api", "/api/v0/x",
    "/api/v0/auth/google/start?mode=silent", "/%6cogin", "/%61pi/v0/x", "/%E0%A4%A", undefined, null, 42, `/${"a".repeat(2048)}`,
  ]) assert.equal(safeNext(next), undefined, String(next));
});

test("deep links into Pulse return exactly where they point", () => {
  for (const next of ["/clients/2c4e6a80-1b3d-4f5a-9c7e-8d0f1a2b3c4d?tab=visits", "/tasks/t-1", "/erp/documents/d-1", "/quotes/q-1#lines",
    "/dashboard", "/search?q=synthetic%20person", "/loginless-page"]) assert.equal(safeNext(next), next, next);
});
