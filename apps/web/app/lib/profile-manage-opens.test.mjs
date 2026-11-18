// WL-RESCUE-2 (Sakobe, Willow Lane, 18 Nov 2026: "manage is not opening", on Adunor's page): the profile header clipped
// everything inside it (overflow: hidden), so the Manage panel opened but was cut off under the button. The header must
// not clip; the cover keeps the rounded corners itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the profile header does not clip the Manage panel", () => {
  const css = read("profile-header.module.css");
  const header = css.match(/^\.header \{[^}]*\}/m)?.[0] ?? "";
  assert.ok(header, "the .header rule is there");
  assert.doesNotMatch(header, /overflow\s*:\s*(hidden|clip)/, "the header clips what opens from it");
  assert.match(css, /\.header:has\(details\[open\]\)\s*\{[^}]*z-index/, "an open panel lifts the header over the page");
  assert.match(css, /^\.cover \{[^}]*border-radius: inherit/m, "the cover keeps the card's rounded top");
  const page = read("people/[id]/page.tsx");
  assert.match(page, /<details className=\{css\.manage\}>/, "Manage is still the header's disclosure");
  const people = read("people/people.module.css");
  assert.match(people, /\.managePanel \{ position: absolute; top: calc\(100% \+ 6px\)/, "the panel opens below the button");
});
