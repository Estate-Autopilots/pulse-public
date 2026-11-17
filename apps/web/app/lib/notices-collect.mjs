// EST-1197 review: the sentences a page may show as they are when its data did not load. Trust is explicit: a sentence
// is shown only if Pulse's own source code wrote it, word for word. This script collects them into notices.mjs:
// - the API's sign-in, permission and not-found refusals: `fail(401|403|404, "…")` with a fixed sentence (never one built
//   from values at run time), the switched-off module lines (MODULE_OFF) and the error handler's line for a denied
//   database permission (42501);
// - the SQL functions' fixed refusals the API passes on as 403 or 404 (app.ts: errcode 42501 or P0002), such as ERP's
//   "ERP is for leadership, Finance and the Accountant": `raise exception '…' using errcode = '42501'`, or '%' with a
//   CASE whose every branch is a fixed sentence;
// - the web app's own words: every fixed sentence a page passes to `<Message text=…>` and every `error: "…"` the web app
//   sets itself (lib/api.ts, the client portal).
// Anything else (a 400 or 409 body, a 5xx body, text built at run time, another service's answer) shows "This didn't
// load" with Try again. A page that builds its sentence at run time passes it as `<Message notice=…>` instead.
// Regenerate after changing one of those sentences: `node apps/web/app/lib/notices-collect.mjs` (notices.test.mjs fails
// until the list matches the source).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const unescape = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) =>
  e[0] === "u" ? String.fromCodePoint(parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16)) : e[0] === "x" ? String.fromCharCode(parseInt(e.slice(1), 16))
    : e === "n" ? "\n" : e === "t" ? "\t" : e);
const LITERAL = String.raw`"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'`;
const literals = (text) => [...text.matchAll(new RegExp(LITERAL, "g"))].map((m) => unescape(m[1] ?? m[2]));

function files(dir, keep, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, keep, out); else if (keep(path)) out.push(path);
  }
  return out.sort();
}

/** The end (exclusive) of a `{…}` JSX expression that starts at `start`, skipping strings and template literals. */
function expressionEnd(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; }
    else if (c === "`") {
      for (i++; i < src.length && src[i] !== "`"; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "{") i = expressionEnd(src, i + 1) - 1;
      }
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return src.length;
}

// The codes app.ts answers 403 (42501) or 404 (P0002), by number or by condition name.
const REFUSAL_CODES = new Set(["42501", "insufficient_privilege", "p0002", "no_data_found"]);

/**
 * The fixed sentences a migration's PL/pgSQL raises with a 403 or 404 code. app.ts passes such a message on as it is
 * when it has a space and none of `{}()"`. A message built from values (a % placeholder, `||`, a variable) stays out.
 * @param {string} sql
 */
function sqlRefusals(sql) {
  const found = [];
  for (const m of sql.matchAll(/\braise\s+(exception|insufficient_privilege|no_data_found)\b/gi)) {
    // The statement runs to the first ; outside a string; its strings become \0n\0 so commas and words in them never count.
    let end = m.index + m[0].length, quoted = false;
    for (; end < sql.length && (quoted || sql[end] !== ";"); end++) if (sql[end] === "'") quoted = !quoted;
    const strings = [];
    const bare = sql.slice(m.index + m[0].length, end)
      .replace(/'((?:[^']|'')*)'/g, (_, s) => `\0${strings.push(s.replace(/''/g, "'")) - 1}\0`);
    const at = bare.search(/\busing\b/i);
    const [message, options] = at < 0 ? [bare, ""] : [bare.slice(0, at), bare.slice(at)];
    const code = options.match(/\berrcode\s*=\s*\0(\d+)\0/i);
    if (!REFUSAL_CODES.has((code ? strings[code[1]] : m[1]).toLowerCase())) continue;
    const named = options.match(/\bmessage\s*=\s*\0(\d+)\0\s*(?:,|$)/i);
    if (named) found.push(strings[named[1]]);
    const head = message.match(/^\s*\0(\d+)\0\s*(?:,([\s\S]*))?$/);
    if (!head) continue;
    const format = strings[head[1]], rest = head[2];
    if (rest === undefined) { if (!format.includes("%")) found.push(format); continue; }
    if (format !== "%" || rest.includes("||") || !/^\s*case\b[\s\S]*\bend\s*$/i.test(rest)) continue;
    const results = [...rest.matchAll(/\b(?:then|else)\s+(\S+)/gi)].map((r) => r[1].match(/^\0(\d+)\0$/)?.[1]);
    if (results.length && results.every((r) => r !== undefined)) results.forEach((r) => found.push(strings[r]));
  }
  return found.filter((s) => /\s/.test(s) && !/[{}()"]/.test(s));
}

/** @param {string} root the repository root */
export function collectNotices(root) {
  const notices = new Set(), dynamic = [];
  const api = files(join(root, "services/api/src"), (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
  for (const path of api) {
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(new RegExp(String.raw`\bfail\(\s*40[134]\s*,\s*(?:${LITERAL})\s*\)`, "g"))) notices.add(unescape(m[1] ?? m[2]));
    const off = src.match(/\bMODULE_OFF\s*:\s*Record<[^>]*>\s*=\s*\{([^}]*)\}/);
    if (off) literals(off[1]).filter((s) => /\s/.test(s)).forEach((s) => notices.add(s));
    for (const m of src.matchAll(/'42501'\s*:\s*'([^']+)'/g)) notices.add(m[1]);
  }
  for (const path of files(join(root, "db/migrations"), (p) => p.endsWith(".sql"))) {
    sqlRefusals(readFileSync(path, "utf8")).forEach((s) => notices.add(s));
  }
  const web = files(join(root, "apps/web/app"), (p) => /\.tsx?$/.test(p) && !p.endsWith(".d.ts") && !p.includes(`${sep}api${sep}`));
  for (const path of web) {
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/<Message\s[^>]*?\btext=/g)) {
      const at = m.index + m[0].length;
      if (src[at] === '"') { notices.add(src.slice(at + 1, src.indexOf('"', at + 1))); continue; }
      if (src[at] !== "{") continue;
      const expr = src.slice(at, expressionEnd(src, at));
      literals(expr).forEach((s) => notices.add(s));
      for (const t of expr.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
        if (t[1].includes("${")) dynamic.push(`${relative(root, path).split(sep).join("/")}: ${t[0]}`);
        else notices.add(unescape(t[1]));
      }
    }
    for (const m of src.matchAll(new RegExp(String.raw`\berror\s*:\s*(?:${LITERAL})`, "g"))) notices.add(unescape(m[1] ?? m[2]));
  }
  // A sentence has a space; "Not Found" is the switched-off module's signal to module-off.tsx, never shown as words.
  return { notices: [...notices].filter((s) => /\S\s+\S/.test(s) && s !== "Not Found").sort(), dynamic };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const { notices, dynamic } = collectNotices(root);
  if (dynamic.length) { console.error(`Pass run-time text as <Message notice=…>:\n${dynamic.join("\n")}`); process.exit(1); }
  writeFileSync(new URL("./notices.mjs", import.meta.url), `// Generated by notices-collect.mjs (EST-1197): the sentences a page may show as they are. Do not edit by hand.
export const NOTICES = new Set(${JSON.stringify(notices, null, 1).replace(/\n /g, "\n  ").replace(/\n\]$/, ",\n]")});
`);
  console.log(`notices.mjs: ${notices.length} sentences`);
}
