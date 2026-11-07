// EST-1542 (B, Pulse CEO on EST-1520): sender names and counts from WhatsApp exports read in the browser. The files
// never leave the device; only each sender's name, messages and groups are sent. Pure, so it is tested on its own.

/** The group (or contact) a file is the export of: "WhatsApp Chat with Site Team (2).txt" is "Site Team". A file
 *  without the usual name counts under the folder that holds it. */
export function exportGroup(name, path = "") {
  const base = String(name ?? "").replace(/\.txt$/i, "").replace(/^WhatsApp Chat (?:with|-)\s*/i, "").replace(/\s*\(\d+\)$/, "").trim();
  if (base && !/^_?chat$/i.test(base)) return base;
  const parts = String(path ?? "").split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : base || String(name ?? "");
}

/** A name the server refuses as a phone number (0680): 7 or more digits anywhere in it, in any script (fullwidth,
 *  Devanagari, Arabic-Indic and every other Unicode decimal digit, as the server counts them). */
export const looksLikePhone = (label) => (String(label ?? "").match(/\p{Nd}/gu) ?? []).length >= 7;

/** After a reload: the server's rows decide counts, order and the most-important mark; an answer this screen is still
 *  saving stays on top of its row, so a refresh never undoes a tap. `pending` holds the ids being saved. */
export function reconcileRows(server, local, pending) {
  const mine = new Map(local.map((r) => [r.id, r]));
  return server.map((r) => {
    const m = pending.has(r.id) ? mine.get(r.id) : undefined;
    return m ? { ...r, decision: m.decision, person: m.person, decidedBy: m.decidedBy } : r;
  });
}

/** One row per sender name, most messages first: messages summed over groups (within a group the largest export
 *  counts, so a second export of the same chat is not counted twice) and the number of groups they write in. Senders
 *  shown as a phone number, or with one in their name, are left out and only counted; a name is kept to 80 characters. */
export function senderTotals(files) {
  const perGroup = new Map(), phones = new Set();
  for (const f of files) for (const p of f.participants ?? []) {
    if (p.phone || looksLikePhone(p.label)) { phones.add(p.label); continue; }
    const label = String(p.label ?? "").trim().slice(0, 80);
    if (!label) continue;
    const key = JSON.stringify([f.group, label]);
    perGroup.set(key, Math.max(perGroup.get(key) ?? 0, p.messages));
  }
  const names = new Map();
  for (const [key, messages] of perGroup) {
    const label = JSON.parse(key)[1], row = names.get(label) ?? { label, messages: 0, groups: 0 };
    row.messages += messages; row.groups += 1; names.set(label, row);
  }
  return { names: [...names.values()].sort((a, b) => b.messages - a.messages || a.label.localeCompare(b.label)), phoneSenders: phones.size };
}
