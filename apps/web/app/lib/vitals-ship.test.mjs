// VITALS-SHIP (owner, 24 Nov 2026: "Nothing is actually shipped"): the owner-asks bugs from the tutorial and quote lanes,
// fixed in small batches. Source-level, like the other app/lib tests; each one pins what its fix changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const repo = (rel) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");
/** The words a person sees: string and JSX text in a TSX file, without comments. */
const visibleText = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("a quotation or invoice prints the company's logo when it was saved as a PNG or JPEG with no e-mail copy", () => {
  const erp = repo("services/api/src/erp.ts");
  const sql = erp.match(/export const ORG_LOGO_SQL = `([\s\S]*?)`;/);
  assert.ok(sql, "one shared query for the organisation's printable logo");
  assert.match(sql[1], /coalesce\(logo_png,logo\) bytes/);
  assert.match(sql[1], /logo_mime in \('image\/png','image\/jpeg'\)/, "an SVG or WebP logo is never sent to the PDF as it is");
  // The PDF, the template list's "Organisation logo", the logo picture itself and the document page all ask the same.
  assert.equal(erp.match(/c\.query\(ORG_LOGO_SQL\)/g)?.length, 4);
  assert.doesNotMatch(erp, /org_brand where org_id=pulse\.current_org\(\) and logo_png is not null/, "no place still asks only for the e-mail copy");
});

test("Catalogue: a new part and a new item suggest no agency words in every company", () => {
  const ui = visibleText(read("erp/catalog/part-drawer.tsx")) + visibleText(read("erp/catalog/table.tsx"));
  for (const word of ["Meta Advertising Engine", "month, video", "Performance Marketer", "ad account", "next month's ads", "real-estate marketing", "Model-led brand film"]) {
    assert.ok(!ui.includes(word), `"${word}" is still a catalogue placeholder`);
  }
  assert.match(read("erp/catalog/part-drawer.tsx"), /placeholder="Nos, month, visit…"/);
});

test("Docs on a phone: the New menu opens from the New button's right edge, inside the screen", () => {
  const css = read("docs/drive/drive.module.css");
  const phone = css.match(/@media \(max-width: 640px\) \{ \.menu\[aria-label="New"\] \{([^}]*)\} \}/);
  assert.ok(phone, "the phone rule for the New menu is still there");
  assert.match(phone[1], /left: auto; right: 0;/, "a right-hand button's menu is anchored to its right edge");
  assert.match(phone[1], /max-width: calc\(100vw - 32px\)/);
  assert.match(css, /\.top > \.menuWrap \{ margin-left: auto; \}/, "the New button still sits at the right (else re-check the anchor)");
});

test("Vitals OS: the first screens a new person sees name the product of the address, not Pulse", () => {
  const shell = repo("packages/ui-shell/src/shell.tsx");
  assert.equal(shell.match(/<ProductNameContext\.Provider value=\{productName\}><ThemeProvider>/g)?.length, 3, "every way the shell renders a page provides the name");
  assert.match(repo("packages/ui-shell/src/index.ts"), /export \{ useProductName \} from "\.\/product-name";/);
  assert.match(shell, /p\.label\.replace\(\/\\bPulse\\b\/g, productName\)/, "menus say Learn Vitals OS on Vitals OS's addresses");
  const screens = ["welcome/wizard.tsx", "login/set-password/form.tsx", "hr/desk/policies.tsx", "hr/pay-policy-strip.tsx", "learn/how-do-i.tsx"];
  for (const f of screens) {
    const words = visibleText(read(f)).replace(/^\s*(already_linked|provider_error):.*$/gm, "");
    for (const said of ["Welcome to Pulse", "Open Pulse", "Pulse has no holidays", "Pulse writes it", "Learn Pulse", "Set your Pulse password", "Pulse keeps only", "What Pulse does"]) {
      assert.ok(!words.includes(said), `${f} still says "${said}"`);
    }
  }
  assert.match(read("welcome/wizard.tsx"), /title=\{`Welcome to \$\{product\}, \$\{s\.person\.firstName\}`\}/);
  assert.doesNotMatch(visibleText(read("create.tsx")), /is told in Pulse/);
});
