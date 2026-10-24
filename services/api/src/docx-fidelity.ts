// R41: the Word → browser editor → Word round-trip check for policy documents. Owner errand E11 supplies the files:
//   1. --word     a company policy written and saved in Microsoft Word (no personal data);
//   2. --browser  the same file after it was opened, edited (or just saved) and saved in the browser editor;
//   3. --back     that file opened and saved again in Microsoft Word.
// It compares what a policy's layout depends on (text, tables, headers/footers and page numbers, lists, page breaks,
// fonts) from the original to each later file and writes a receipt. The verdict is "pass" only when every category is
// unchanged AND the files really came from Word, the browser editor and Word again (docProps/app.xml): a file made
// by a generator (python-docx, docx.js, Pulse's own fixtures) or a missing leg can never pass. A passing receipt,
// installed as PULSE_POLICY_EDITOR_FIDELITY_RECEIPT after the owner's sign-off, turns the editor's "trial" label off.
//   node services/api/dist/docx-fidelity.js --word a.docx --browser b.docx --back c.docx [--editor ONLYOFFICE] [--out receipt.json]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { checkDocx, compareFidelity, docxFeatures, type Comparison, type Features } from "./policy-docx.js";

export type Leg = { role: "word" | "browser" | "back"; name: string; sha256: string; application: string | null };
export type Receipt = {
  tool: "pulse-docx-fidelity/1"; checkedAt: string; editor: string; files: Leg[];
  comparisons: { from: string; to: string; categories: Comparison }[];
  verdict: "pass" | "fail" | "cannot_pass"; reasons: string[];
};
const WORD = /^Microsoft Office Word\b/i;

/** The receipt for up to three files; `editor` names the approved browser editor as it writes docProps/app.xml. */
export function fidelityReceipt(files: { role: Leg["role"]; name: string; bytes: Buffer }[], editor = "ONLYOFFICE", now = new Date()): Receipt {
  const legs: (Leg & { features: Features })[] = files.map((f) => {
    const features = docxFeatures(checkDocx(f.bytes));
    return { role: f.role, name: f.name, sha256: createHash("sha256").update(f.bytes).digest("hex"), application: features.application, features };
  });
  const by = (role: Leg["role"]) => legs.find((l) => l.role === role);
  const reasons: string[] = [];
  const word = by("word"), browser = by("browser"), back = by("back");
  if (!word || !browser || !back) reasons.push("A representative round trip needs all three files: Word, then the browser editor, then Word again.");
  if (word && !WORD.test(word.application ?? "")) reasons.push(`The original was not saved by Microsoft Word (it says “${word.application ?? "nothing"}”): generator output cannot pass.`);
  if (browser && !new RegExp(`^${editor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(browser.application ?? "")) reasons.push(`The browser leg was not saved by ${editor} (it says “${browser.application ?? "nothing"}”).`);
  if (back && !WORD.test(back.application ?? "")) reasons.push(`The last file was not saved again by Microsoft Word (it says “${back.application ?? "nothing"}”).`);
  if (word && browser && word.sha256 === browser.sha256) reasons.push("The browser leg is byte-for-byte the original: it was not saved by the editor.");
  const comparisons = word ? legs.filter((l) => l !== word).map((l) => ({ from: word.role, to: l.role, categories: compareFidelity(word.features, l.features) })) : [];
  const failed = comparisons.some((c) => Object.values(c.categories).some((k) => !k.ok));
  return {
    tool: "pulse-docx-fidelity/1", checkedAt: now.toISOString(), editor,
    files: legs.map(({ features: _features, ...leg }) => leg), comparisons,
    verdict: reasons.length ? "cannot_pass" : failed ? "fail" : "pass", reasons,
  };
}

async function main() {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const files = [];
  for (const role of ["word", "browser", "back"] as const) { const path = arg(role); if (path) files.push({ role, name: basename(path), bytes: await readFile(path) }); }
  if (!files.length) { console.error("usage: docx-fidelity.js --word a.docx --browser b.docx --back c.docx [--editor ONLYOFFICE] [--out receipt.json]"); process.exit(2); }
  const receipt = fidelityReceipt(files, arg("editor") ?? "ONLYOFFICE");
  const out = arg("out");
  if (out) await writeFile(out, JSON.stringify(receipt, null, 2) + "\n");
  for (const c of receipt.comparisons) for (const [k, v] of Object.entries(c.categories)) console.log(`${c.from} → ${c.to}  ${k.padEnd(15)} ${v.ok ? "same" : "CHANGED: " + v.differences.join("; ")}`);
  for (const r of receipt.reasons) console.log(`cannot pass: ${r}`);
  console.log(`verdict: ${receipt.verdict}`);
  process.exit(receipt.verdict === "pass" ? 0 : 1);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
