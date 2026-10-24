// UX-5B: where a task sends people and how Pulse can tell it is done. Pure functions over the registry, used by the
// task page (server), the task companion and tests. Nothing here is acted on until a person confirms it: a target is a
// button, signals are a proposal the creator confirms with one tap.
import { DESTINATIONS, canSee, destination, matchDestinations, norm, placesIn } from "./registry.mjs";

const chain = (d) => { const out = []; let at = d; while (at) { out.push(at); at = destination(at.parent); } return out; };
const within = (d, root) => chain(d).some((x) => x.id === root.id);
/** The tab or page a destination sits on (itself when it is one). */
export function pageOf(d) { return chain(d).find((x) => x.kind === "tab" || x.kind === "page") ?? d; }

/** What the button says: the tab or page by its own name when that says enough ("Office presence"), else with its
 *  parent ("Policies → Documents"). */
export function buttonFor(d) {
  const page = pageOf(d); const parent = destination(page.parent);
  const name = page.label.trim().split(/\s+/).length >= 2 || !parent || parent.kind === "page" ? page.label : `${parent.label} → ${page.label}`;
  return `Go to ${name}`;
}

/** The finest destination under `place` the text names (a control beats its tab), or null. Words that only repeat
 *  the place's own name ("Check-in settings" naming "check in") refine nothing. */
function refine(place, said, text) {
  const own = norm(said);
  const best = matchDestinations(text, 12).find((m) => m.score >= 3 && within(m.dest, place) && m.dest.id !== place.id && !own.includes(norm(m.matched)));
  return best ? { dest: best.dest, via: best.matched } : null;
}

/** Where "Go there" takes this person for this task: the creator's pick, else a place in the notes, else a place in
 *  the title, else the registry's best match for the title. Null when nothing fits or the person cannot open it. */
export function targetFor(task, who) {
  const ok = (d) => !!d && canSee(d, who);
  const picked = destination(task.target);
  if (picked) return ok(picked) ? { dest: picked, button: buttonFor(picked), source: "creator", via: picked.label } : null;
  const text = `${task.title}\n${task.notes ?? ""}`;
  for (const [source, from] of [["notes", task.notes ?? ""], ["title", task.title]]) {
    for (const p of placesIn(from)) {
      if (!ok(p.dest)) continue;
      const fine = refine(p.dest, p.label, text);
      const d = fine && ok(fine.dest) ? fine.dest : p.dest;
      return { dest: d, button: buttonFor(d), source, via: p.label };
    }
  }
  const m = matchDestinations(task.title, 8).find((x) => x.score >= 3 && ok(x.dest));
  if (!m) return null;
  // "Add the guest Wi-Fi in Office presence": the page is named whole, the control by one word; the control is the place.
  const fine = refine(m.dest, m.matched, task.title);
  const d = fine && ok(fine.dest) ? fine.dest : m.dest;
  return { dest: d, button: buttonFor(d), source: "title", via: fine && d === fine.dest ? fine.via : m.matched };
}

// ---------------------------------------------------------------------------------------------------------- signals
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, both: 2 };
/** "with 2 people", "three different people", "both of them": how many different people the text asks for. */
export function peopleCount(text) {
  const m = norm(text).match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+|more\s+)?(?:people|persons|person|staff|colleagues|members|employees|team members|testers|users)\b/);
  if (m) { const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1]]; return n >= 1 && n <= 50 ? n : null; }
  return null;
}
/** Where in the text a template's words first appear, or -1 when any group is missing. */
function said(t, tpl) {
  if (!tpl.when?.length) return -1;
  let first = Infinity;
  for (const group of tpl.when) {
    const at = Math.min(...group.map((w) => { const i = t.indexOf(` ${norm(w)} `); return i < 0 ? Infinity : i; }));
    if (at === Infinity) return -1;
    first = Math.min(first, at);
  }
  return first;
}
/** "Office Wi-Fi saved" + "Office IP saved" → "Office Wi-Fi and IP saved". */
function joinLabels(labels) {
  if (labels.length < 2) return labels[0] ?? "";
  const ws = labels.map((l) => l.split(" "));
  let pre = 0; while (ws.every((w) => w[pre] !== undefined && w[pre] === ws[0][pre])) pre++;
  let suf = 0; while (ws.every((w) => w.length - suf - 1 > pre && w[w.length - 1 - suf] === ws[0][ws[0].length - 1 - suf])) suf++;
  const mids = ws.map((w) => w.slice(pre, w.length - suf).join(" "));
  return [...ws[0].slice(0, pre), mids.slice(0, -1).join(", ") + " and " + mids[mids.length - 1], ...ws[0].slice(ws[0].length - suf)].join(" ").replace(/\s+/g, " ").trim();
}

/** Pip's proposal: the signals that would show this task is done. From the task's target and the places beside it
 *  (each template's words must be in the text), plus any specific signal (two or more word groups) the text names.
 *  Signals for the same event are merged into one with every condition. Nothing is proposed on a vague match. */
export function proposeFor(task) {
  const text = `${task.title}\n${task.notes ?? ""}`; const t = ` ${norm(text)} `;
  const target = targetFor(task, { role: "Organisation owner/admin" });
  const near = new Set ();
  if (target) { const page = pageOf(target.dest); for (const d of DESTINATIONS) if (within(d, page)) near.add(d.id); for (const d of chain(target.dest)) near.add(d.id); }
  const found = [];
  for (const d of DESTINATIONS) for (const tpl of d.signals ?? []) {
    const at = said(t, tpl);
    if (at < 0) continue;
    if (!near.has(d.id) && (tpl.when?.length ?? 0) < 2) continue;
    found.push({ at, tpl, dest: d.id });
  }
  found.sort((a, b) => a.at - b.at);
  const out = []; const labels = new Map ();
  const count = peopleCount(text);
  for (const f of found) {
    const same = out.find((s) => s.event === f.tpl.event && s.distinct === f.tpl.distinct);
    if (same) {
      if (f.tpl.where) same.where = { ...(same.where ?? {}), ...f.tpl.where };
      const l = labels.get(same); if (!l.includes(f.tpl.label)) l.push(f.tpl.label);
      continue;
    }
    const need = f.tpl.distinct ? count ?? 1 : 1;
    const s = { event: f.tpl.event, label: f.tpl.label, need, dest: f.dest, ...(f.tpl.distinct ? { distinct: f.tpl.distinct } : {}), ...(f.tpl.where ? { where: { ...f.tpl.where } } : {}) };
    out.push(s); labels.set(s, [f.tpl.label]);
  }
  for (const s of out) {
    const label = joinLabels(labels.get(s));
    s.label = s.distinct ? (s.need === 1 ? `1 ${label.replace(/^people\b/, "person")}` : `${s.need} ${label}`) : label;
  }
  return out;
}

/** The shell's role label for an account's role (as the layout names it for the rail). */
export function shellRole(role) {
  return { admin: "Organisation owner/admin", hr: "HR", leadership: "Leadership", finance: "Finance", manager: "Manager / PGS", pgs: "Manager / PGS" }[role] ?? "Member";
}
