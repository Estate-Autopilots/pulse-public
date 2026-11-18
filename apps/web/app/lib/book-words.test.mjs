// COMPANIES-MODEL (owner, 16 Nov 2026: "When I was adding clients and contacts it was asking who is the contact:
// developer, etc."): the address book's screens (adding people, companies and clients) name no real-estate role in
// their own words. A company's own types (Developer, Channel partner, Model) still show where it has them: they come
// from its type list, never from these files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["contacts/book.tsx", "contacts/page.tsx", "contacts/tabs.tsx", "contacts/companies/page.tsx", "contacts/companies/[id]/page.tsx",
  "contacts/companies/[id]/actions.tsx", "clients/page.tsx", "clients/sort-kind.tsx"];
const WORDS = /\b(developers?|channel partners?|CPs?|builders?|brokers?|site visits?|flats?|BHK|real[- ]estate|models?)\b/i;

test("the address book's own words name no real-estate role", () => {
  for (const f of FILES) {
    const lines = readFileSync(join(APP, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      const strings = code.match(/"[^"]*"|`[^`]*`|>[^<>{}]+</g) ?? [];
      for (const s of strings) if (!/^["`]\//.test(s)) assert.ok(!WORDS.test(s), `${f}:${i + 1} says "${s.trim()}"`); // a path is not words
    });
  }
});
