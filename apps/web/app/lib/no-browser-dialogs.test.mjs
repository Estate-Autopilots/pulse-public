// UI-DIALOGS (owner, 8 Nov 2026): the web app never opens the browser's own prompt, confirm or alert ("app.vitalsos.ai
// says…"). It uses useConfirm(), usePrompt() and toast() from kit/dialogs.tsx. ESLint refuses them too
// (eslint.config.mjs); this reads every source file, so a file the lint skips cannot bring one back either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".next", "public", "out"]);
function* sources(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) yield* sources(join(dir, e.name)); }
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name) && !/\.test\.mjs$|\.d\.m?ts$/.test(e.name)) yield join(dir, e.name);
  }
}
/** The code with comments and the words inside quotes blanked out (a string like "javascript:alert(1)" is not a call). */
const noComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
function codeOnly(text) {
  return noComments(text)
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m.at(-1));
}
// window.confirm(…), globalThis.alert(…), self.prompt(…), window["confirm"](…), and the bare globals confirm(…) / alert(…) /
// prompt(…), unless the file has its own of that name (`const confirm = useConfirm()`, `function confirm()`, `as confirm`)
// or the line defines a method of it (`confirm() {`). ESLint's no-restricted-globals sees scopes exactly.
const MEMBER = /\b(?:window|globalThis|self|top|parent)\s*\.\s*(?:prompt|confirm|alert)\s*\(/;
const INDEXED = /\b(?:window|globalThis|self|top|parent)\s*\[\s*["'`](?:prompt|confirm|alert)["'`]\s*\]\s*\(/;
const BARE = /(?:^|[^\w$.])(prompt|confirm|alert)\s*\(/g;
const METHOD = /(?:^|[{,;]|async)\s*(prompt|confirm|alert)\s*\([^)]*\)\s*\{/;
const DECLARED = /\b(?:const|let|var|function)\s+(prompt|confirm|alert)\b|\bas\s+(prompt|confirm|alert)\b/g;

/** The lines of `src` that open a browser dialog: [line number, line]. */
function browserDialogs(src) {
  const code = codeOnly(src), kept = noComments(src).split("\n");
  const own = new Set([...code.matchAll(DECLARED)].map((m) => m[1] ?? m[2]));
  const lines = [];
  code.split("\n").forEach((line, i) => {
    const bare = [...line.matchAll(BARE)].some((m) => !own.has(m[1])) && !METHOD.test(line);
    if (MEMBER.test(line) || INDEXED.test(kept[i] ?? "") || bare) lines.push(i + 1);
  });
  return lines;
}

// Files allowed to keep a few browser dialogs for now (name -> at most how many). Empty: DOCS-DRIVE's Docs page landed
// with none (LAND-CAPTAIN-7, 9 Nov 2026), so no file keeps any.
const WAITING = new Map();

test("no window.prompt, window.confirm or window.alert anywhere in apps/web", () => {
  const found = [];
  let files = 0;
  for (const file of sources(join(web, "app"))) {
    files += 1;
    const raw = readFileSync(file, "utf8");
    if (!/prompt|confirm|alert/.test(raw)) continue;
    const quoted = raw.split("\n");
    const name = relative(web, file).split("\\").join("/"), lines = browserDialogs(raw);
    if (lines.length && lines.length <= (WAITING.get(name) ?? 0)) continue;
    for (const n of lines) found.push(`${name}:${n}: ${quoted[n - 1].trim().slice(0, 140)}`);
  }
  assert.ok(files > 500, `read the app's sources (${files} files)`);
  assert.deepEqual(found, [], `use useConfirm / usePrompt / toast from app/kit/dialogs.tsx instead:\n${found.join("\n")}`);
});

test("the check itself finds each form it is meant to find", () => {
  const hits = (src) => browserDialogs(src).length > 0;
  for (const bad of ['if (!window.confirm("Delete?")) return;', 'const v = window.prompt("Name")', "window.alert(e.message)", 'globalThis.confirm("x")',
    'if (confirm("Make a new team code?")) go();', 'alert("Saved")', 'window["prompt"]("x")', "onClick={() => { if (confirm(`Withdraw ${x}?`)) run(); }}",
    'const ask = usePrompt();\nif (confirm("x")) go();']) {
    assert.equal(hits(bad), true, bad);
  }
  for (const fine of ['async function confirm() { await post("x"); }', "const confirm = useConfirm();\nif (!(await confirm({ title: 'Delete?', confirmLabel: 'Delete' }))) return;",
    "import { confirmDialog as confirm } from './kit/dialogs';\nconfirm({ title: 'x' });",
    'assert.equal(safeHref("javascript:alert(1)"), null);', "// window.confirm used to ask here", "card.confirm ? x : y", "props.onConfirm()", "ui.confirm({ title })",
    "  confirm() {", "/* alert( */", "const s = `window.confirm(${x})`;"]) {
    assert.equal(hits(fine), false, fine);
  }
});
