// BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane: "purepower 5", "Pure Power 5.0" and "pure power5.0" must all
// find Pure Power 5.0, and a code or a number finds its item). One forgiving match for Billing's searches: case, spaces and
// punctuation never matter, every word typed may sit anywhere, digits find a code, a model number or a phone, and the
// closest match comes first. The database's pulse.search_score (1500) scores clients, contacts and leads the same way.

/** Lower case, letters and digits only: "Pure Power 5.0" and "pure-power 50" are both "purepower50". */
export function squash(text) {
  return String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The words typed, each squashed ("pure power5.0" → ["pure", "power50"]). */
export function words(query) {
  return String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}.]+/u).map(squash).filter(Boolean);
}

/** How well `query` matches any of `fields` (0 = not at all): whole field 100, its start 85, inside it 70, every word
 *  somewhere in the fields together 50. */
export function score(query, fields) {
  const q = squash(query);
  if (!q) return 0;
  let best = 0;
  for (const f of fields) {
    const h = squash(f);
    if (!h) continue;
    if (h === q) return 100;
    if (h.startsWith(q)) best = Math.max(best, 85);
    else if (h.includes(q)) best = Math.max(best, 70);
  }
  if (best) return best;
  const all = squash(fields.filter(Boolean).join(" "));
  const ws = words(query);
  return ws.length && ws.every((w) => all.includes(w)) ? 50 : 0;
}

/** The items that match, best first; a tie goes to the shorter (closer) name, then the original order. */
export function rank(items, query, fieldsOf, limit = Infinity) {
  if (!squash(query)) return items.slice(0, limit);
  return items.map((item, at) => ({ item, at, s: score(query, fieldsOf(item)), n: squash(fieldsOf(item)[0]).length }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.n - b.n || a.at - b.at).slice(0, limit).map((x) => x.item);
}
