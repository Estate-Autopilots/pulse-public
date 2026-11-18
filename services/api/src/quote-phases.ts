// QUOTE-STRUCT (Kazuk, 16 Nov 2026: "VitalsOS Quotations: Phase-wise Package Editing: Build Guide"; migration 2252): the
// phases a company sells in, in order. Catalogue items name one (and optionally one of its sub-groups); a quotation's
// lines and its PDF group by them. Each business sets its own; a business with none keeps one flat list. Pure, so
// test/quote-phases.test.mjs covers what a list of phases accepts.

export type Phase = { key: string; name: string; groups: string[] };
export class PhaseError extends Error { statusCode = 400; }
const bad = (m: string): never => { throw new PhaseError(m); };
const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A key from a name: "Phase 2: Creative Assets™" → "phase-2-creative-assets". */
export function phaseKey(name: string, taken: Set<string> = new Set()): string {
  const base = (name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(\d)/, "p$1").slice(0, 36) || "phase").replace(/-+$/g, "");
  let k = base, n = 2;
  while (taken.has(k)) k = `${base}-${n++}`;
  return k;
}

/** The company's phases as saved: up to 20, each named once, with up to 8 sub-groups. A phase keeps its key when renamed
 *  (items point at the key); a new one gets a key from its name. `lenient` reads what is stored without refusing. */
export function cleanPhases(raw: unknown, { lenient = false } = {}): Phase[] {
  if (!Array.isArray(raw)) return lenient ? [] : bad("Phases are a list");
  if (raw.length > 20 && !lenient) bad("A company has up to 20 phases");
  const out: Phase[] = [];
  const keys = new Set<string>(), names = new Set<string>();
  for (const [i, x] of raw.slice(0, 20).entries()) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const name = clean(o.name, 120);
    if (!name) { if (lenient) continue; bad(`Phase ${i + 1}: name it`); }
    if (names.has(name.toLowerCase())) { if (lenient) continue; bad(`Two phases are called ${name}`); }
    const given = typeof o.key === "string" && KEY.test(o.key) && !keys.has(o.key) ? o.key : null;
    const key = given ?? phaseKey(name, keys);
    const groups: string[] = [];
    for (const g of Array.isArray(o.groups) ? o.groups : []) {
      const t = clean(g, 60);
      if (t && !groups.some((y) => y.toLowerCase() === t.toLowerCase())) groups.push(t);
    }
    if (groups.length > 8 && !lenient) bad(`${name}: up to 8 sub-groups`);
    keys.add(key); names.add(name.toLowerCase());
    out.push({ key, name, groups: groups.slice(0, 8) });
  }
  return out;
}

/** Where an item prints on a quotation: its phase's name and order and its sub-group, or nothing. */
export function phaseOfItem(phases: Phase[], item: { phase?: string | null; phaseGroup?: string | null }) {
  const at = phases.findIndex((p) => p.key === item.phase);
  if (at < 0) return { phase: null, phaseOrder: null, phaseGroup: null };
  const p = phases[at];
  return { phase: p.name, phaseOrder: at, phaseGroup: item.phaseGroup && p.groups.includes(item.phaseGroup) ? item.phaseGroup : null };
}
