// QUOTE-STRUCT (Kazuk, 16 Nov 2026: "VitalsOS Quotations: Phase-wise Package Editing: Build Guide"): a package added to a
// quotation opens into its parts, one editable line each, under the company's phases. Pure, so quote-phases.test.mjs
// covers how a package opens, what counts as changed from its default, and how lines group. The catalogue package itself
// never changes; the lines belong to this quotation only.
//
// Pricing rules (the guide): a part's price comes from the package (per unit), else from its catalogue item; a part
// priced at nothing whose item has a price is a bonus (its value struck through); one with no price anywhere is "To be
// quoted" (never priced silently at zero) unless its item is marked Included; a monthly service's quantity is its months.

/** Where an item prints: its phase's name and order and its sub-group (null when the company has no such phase). */
export function phaseOf(phases, item) {
  const at = (phases ?? []).findIndex((p) => p.key === item?.phase);
  if (at < 0) return { phase: null, phaseOrder: null, phaseGroup: null };
  const p = phases[at];
  return { phase: p.name, phaseOrder: at, phaseGroup: item.phaseGroup && (p.groups ?? []).includes(item.phaseGroup) ? item.phaseGroup : null };
}

/** "Growth Package · your calling team…": the package's name and, when it is short, its description. */
export function packageLabel(pkg) {
  const name = String(pkg?.name ?? "").trim() || "Package";
  const note = String(pkg?.description ?? "").replace(/\s+/g, " ").trim();
  return (note && note.length <= 160 && !/^includes:/i.test(note) ? `${name} · ${note}` : name).slice(0, 400);
}

/** Whether a package opens into parts on a quotation: it has parts, and at least one of them is priced (a package of
 *  unpriced deliverables stays one line, as before). */
export function opensIntoParts(parts) {
  return (parts ?? []).some((p) => (p.price ?? null) !== null || Number(p.itemPrice) > 0);
}

/** The quotation lines a package opens into, in the package's order, each with its phase and the package's default. */
export function packageLines(pkg, parts, phases) {
  const pkgPhase = phaseOf(phases, pkg);
  // A package sold at nothing ("Bonuses included (₹0)") gives its parts free: a part with no price there is a bonus.
  const free = pkg.price !== undefined && pkg.price !== null && Number(pkg.price) === 0;
  return (parts ?? []).map((part) => {
    const own = part.price === null || part.price === undefined ? null : Number(part.price);
    const itemPrice = Number(part.itemPrice) > 0 ? Number(part.itemPrice) : null;
    const price = own ?? itemPrice;
    const role = part.included ? "included" : price === null ? (free ? "bonus" : "to_quote") : price === 0 ? (itemPrice || free ? "bonus" : "included") : null;
    const where = part.phase ? phaseOf(phases, part) : pkgPhase;
    const qty = Number(part.quantity) > 0 ? Number(part.quantity) : 1;
    return {
      itemId: part.itemId ?? null, description: String(part.label || part.itemName || "Part").slice(0, 300), details: "", sac: part.sac ?? pkg.sac ?? null,
      unit: part.unit ?? part.itemUnit ?? null, qty, rate: role ? 0 : price, discount: 0, discountPercent: null, gstRate: Number(part.gstRate ?? pkg.gstRate ?? 18),
      open: false, notNeeded: false, ...where, role, packageId: pkg.id, packageLabel: packageLabel(pkg),
      packageDefault: { qty, rate: role ? 0 : price, itemId: part.itemId ?? null }, listRate: role === "bonus" ? itemPrice : null,
    };
  });
}

/** What changed on a part line from its package's default: added, removed, +1 / −2, price changed, swapped. */
export function changes(line) {
  if (!line?.packageId) return [];
  const d = line.packageDefault;
  if (!d) return ["added"];
  if (line.notNeeded) return ["removed"];
  const out = [];
  if ((d.itemId ?? null) !== (line.itemId ?? null)) out.push("swapped");
  const dq = Number(line.qty) - Number(d.qty);
  if (Math.abs(dq) > 1e-9) out.push(`${dq > 0 ? "+" : "−"}${Math.round(Math.abs(dq) * 1000) / 1000}`);
  if (d.rate !== null && d.rate !== undefined && Number(line.rate) !== Number(d.rate) && !line.role) out.push("price changed");
  return out;
}

/** A package's price on this quotation: the sum of its kept, priced lines (quantity × price). */
export function packageTotal(lines, packageId) {
  return (lines ?? []).filter((l) => l.packageId === packageId && !l.notNeeded && !l.role && Number(l.qty) > 0)
    .reduce((n, l) => n + Math.round(Number(l.rate) * Number(l.qty)), 0);
}

/** Lines grouped the way the quotation prints them: phases in their order (sub-groups inside), then lines with no phase
 *  ("Other items" once any line has a phase), then bonuses. `key` stays stable while lines change. */
export function groupLines(lines) {
  const groups = [];
  const find = (key, make) => groups.find((g) => g.key === key) ?? (groups.push(make()), groups.at(-1));
  const anyPhase = (lines ?? []).some((l) => l.phase);
  for (const [i, l] of (lines ?? []).entries()) {
    const g = l.role === "bonus" ? find("bonus", () => ({ key: "bonus", name: "Bonuses included", order: 10000, first: i, lines: [] }))
      : l.phase ? find(`p:${l.phase}`, () => ({ key: `p:${l.phase}`, name: l.phase, order: Number.isFinite(Number(l.phaseOrder)) && l.phaseOrder !== null ? Number(l.phaseOrder) : 1000, first: i, lines: [] }))
      : find("other", () => ({ key: "other", name: anyPhase ? "Other items" : null, order: 5000, first: i, lines: [] }));
    g.lines.push(l);
  }
  for (const g of groups) if (g.key === "other" && anyPhase) g.name = "Other items";
  return groups.sort((a, b) => a.order - b.order || a.first - b.first).map((g) => ({ key: g.key, name: g.name, lines: g.lines,
    subGroups: [...new Set(g.lines.map((l) => l.phaseGroup ?? ""))] }));
}

/** Variants a part can be swapped for: other active catalogue items in the same phase and sub-group (Standard → Luxury). */
export function swapOptions(line, items) {
  const me = (items ?? []).find((i) => i.id === line?.itemId);
  if (!me?.phase) return [];
  return (items ?? []).filter((i) => i.id !== me.id && i.kind !== "package" && i.status !== "archived" && i.phase === me.phase && (i.phaseGroup ?? null) === (me.phaseGroup ?? null));
}

/** A line moved to another catalogue item (a swap): its name, price, tax and unit follow the new item; quantity, phase and
 *  package stay. A variant with no price is To be quoted; an Included one prints Included. */
export function swapTo(line, item) {
  const price = Number(item.price) > 0 ? Number(item.price) : null;
  const role = item.included ? "included" : price === null ? "to_quote" : null;
  return { ...line, itemId: item.id, description: String(item.name).slice(0, 300), sac: item.sac ?? line.sac ?? null, unit: item.unit ?? line.unit ?? null,
    gstRate: Number(item.gstRate ?? line.gstRate ?? 18), rate: role ? 0 : price, role, open: false, listRate: null };
}
