// UX-5A: Ctrl+K's matching, ranking and Pip's understanding of a question. Pure and fast (no React, no fetch): the
// palette prepares its items once and scores every one on each keystroke (a few thousand in well under 100 ms).
//
// Matching is per word: a whole word, the start of a word, a word inside another (three letters or more), the words run
// together ("wifi" finds "Wi-Fi") and one typo ("ofice"). Labels count most, then synonyms (the destinations registry's,
// and Pip's words below), then the breadcrumb path and the detail line. A plain search needs every word to match;
// Pip's reading of a question ("where do I add the office internet?") drops the question words, adds what the words
// mean (internet → Wi-Fi, network, IP) and lets the best partial matches through.

/** Lower case, accents off, punctuation to spaces. */
export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

/** Pip's words: what people type, and what Pulse calls it. Both ways where it makes sense. */
export const PIP_WORDS = {
  internet: ["wi fi", "wifi", "network", "ip", "broadband"], wifi: ["wi fi", "internet", "network", "ssid"], "wi fi": ["wifi", "internet", "network"],
  network: ["wi fi", "internet", "ip"], ip: ["network", "internet", "public ip"], router: ["wi fi", "network"], broadband: ["internet", "wi fi"],
  office: ["presence", "workplace", "site"], workplace: ["office"], geofence: ["office", "arrival", "presence"], location: ["office", "place", "map"],
  leave: ["time off", "holiday", "absence", "day off"], "time off": ["leave"], vacation: ["leave"], holiday: ["leave", "holidays"], sick: ["leave", "sick leave"], absent: ["leave"],
  salary: ["pay", "payslip", "payroll"], pay: ["payslip", "salary", "payroll"], payslip: ["pay", "salary"], payroll: ["salary", "payslip", "cut off"],
  attendance: ["check in", "presence", "punch"], punch: ["check in", "attendance"], checkin: ["check in"], "check in": ["attendance", "checkin"], late: ["attendance", "grace"],
  wfh: ["from home", "work from home"], "work from home": ["wfh", "from home"], remote: ["from home", "wfh"],
  task: ["work", "to do"], tasks: ["work"], todo: ["task", "to do"], assign: ["who does it", "give"], review: ["accept", "reviews"], accept: ["review", "reviews"],
  request: ["ticket", "hr request", "ask hr"], ticket: ["request"], complaint: ["request", "grievance"], grievance: ["request"],
  boss: ["manager", "pod head"], manager: ["pod head", "head"], team: ["people", "pod", "staff"], employee: ["people", "staff"], staff: ["people", "team"],
  bank: ["bank details", "ifsc", "account number"], phone: ["contact", "mobile"], address: ["contact", "my info"],
  password: ["sign in", "security", "account"], login: ["sign in", "password"], "sign in": ["login", "password", "devices"],
  logo: ["brand"], colour: ["accent", "brand"], color: ["accent", "brand"], theme: ["dark", "light", "appearance"],
  invoice: ["bill", "billing", "erp"], bill: ["invoice"], expense: ["reimbursement"], reimbursement: ["expense"],
  policy: ["policies", "rules", "handbook"], policies: ["policy"], handbook: ["policy"], rules: ["policy", "working rules"],
  sop: ["procedure", "process", "workflow"], procedure: ["sop"], process: ["sop", "workflow"],
  notification: ["bell", "alerts", "notices"], alerts: ["notifications"], skills: ["skill", "cv"], cv: ["skills", "resume"], resume: ["cv"],
};
const STOP = new Set("where what which who whom how when why do does did i we you my our your me us can could would should please is are am be the a an to of in on at for from with and or it its this that there here find show tell get go open want need let lets take see look know use".split(" "));
/** Words that ask to change or create something ("add", "set up"): settings sections and actions rank first. */
const CHANGE = new Set("add set change edit update put enter configure turn switch enable disable remove create new make save upload".split(" "));

/** Pip's reading of a query: whether it is a question, what the person wants to do, the words that carry meaning and,
 *  for each, what it means in Pulse (`groups`: a word and its stand-ins; `expanded`: all of them, for the server). */
export function understand(query) {
  const raw = String(query ?? "").trim(), all = words(raw);
  const question = /\?\s*$/.test(raw) || (all.length >= 3 && /^(where|what|how|can|who|which|when|why|is|do|does|i want|i need)\b/.test(norm(raw)));
  const intent = all.some((w) => CHANGE.has(w)) ? "change" : null;
  const keywords = all.filter((w) => !STOP.has(w) && !CHANGE.has(w) && w.length > 1);
  const text = ` ${keywords.join(" ")} `;
  const groups = []; const used = new Set();
  // Two-word meanings first ("time off", "check in"), then single words.
  for (const k of Object.keys(PIP_WORDS).filter((k) => k.includes(" "))) if (text.includes(` ${k} `)) { groups.push({ word: k, alts: PIP_WORDS[k] }); for (const w of k.split(" ")) used.add(w); }
  for (const w of keywords) if (!used.has(w)) groups.push({ word: w, alts: PIP_WORDS[w] ?? [] });
  return { question, intent, keywords, groups, expanded: [...new Set(groups.flatMap((g) => [g.word, ...g.alts]))] };
}

/** One typo (a letter added, missing, changed or two swapped), for words of four letters or more. */
export function near(a, b) {
  if (a === b) return true;
  if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Prepares an item for scoring: { label, synonyms?, path?, sub?, keywords? } gains `_m` (its words, normalized). */
export function prepare(item) {
  const field = (s) => { const n = norm(s); return { n, w: n.split(" ").filter(Boolean), c: n.replace(/ /g, "") }; };
  return { ...item, _m: { label: field(item.label), syn: (item.synonyms ?? []).map(field), path: field((item.path ?? []).join(" ")), sub: field(`${item.sub ?? ""} ${item.keywords ?? ""}`) } };
}

/** How well one query word matches one field (0 to 1). */
function wordIn(t, f) {
  if (!f.n) return 0;
  let best = 0;
  for (const w of f.w) {
    if (w === t) return 1;
    if (w.startsWith(t)) best = Math.max(best, t.length >= 2 ? 0.9 : 0.5);
    else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 0.65);
    else if (near(t, w)) best = Math.max(best, 0.55);
  }
  if (best < 0.75 && t.length >= 3 && f.c.includes(t)) best = Math.max(best, 0.75);
  return best;
}
/** A phrase ("wi fi", "check in") inside a field. */
const phraseIn = (p, f) => f.n && (` ${f.n} `.includes(` ${p} `) || f.c.includes(p.replace(/ /g, ""))) ? 1 : 0;

/** Scores a prepared item against the query. `groups` (Pip's reading) score each meaning word by itself or its best
 *  stand-in and let partial matches through; a plain search needs every word. Returns 0 for no match. */
export function score(item, query, { groups } = {}) {
  const m = item._m; if (!m) return 0;
  const q = norm(query); if (!q) return 0;
  const one = (t) => { const phrase = t.includes(" "); const f = (x) => phrase ? phraseIn(t, x) : wordIn(t, x);
    return Math.max(f(m.label), 0.85 * Math.max(0, ...m.syn.map(f)), 0.6 * f(m.path), 0.5 * f(m.sub)); };
  const loose = !!groups?.length;
  const parts = loose ? groups.map((g) => Math.max(one(g.word), 0.9 * Math.max(0, ...g.alts.map(one)))) : q.split(" ").filter(Boolean).map(one);
  if (!parts.length) return 0;
  const missing = parts.filter((x) => x <= 0).length;
  if (missing === parts.length || (missing && !loose)) return 0;
  let s = parts.reduce((a, b) => a + b, 0) / parts.length;
  if (loose) s *= 0.6 + 0.4 * (1 - missing / parts.length);
  if (m.label.n === q) s += 0.6; else if (m.label.n.startsWith(q)) s += 0.3;
  if (m.syn.some((x) => x.n === q)) s += 0.25;
  return s;
}

/** Recent picks, newest first: { key, at, n } (kept in localStorage by the palette). */
export function recentBoost(key, recent, now = Date.now()) {
  const r = recent.find((x) => x.key === key); if (!r) return 0;
  const days = Math.max(0, (now - r.at) / 86400000);
  return Math.min(0.35, 0.12 * Math.log2(1 + r.n)) * Math.exp(-days / 21) + (days < 1 ? 0.05 : 0);
}

/** Ranks prepared items: [{ item, score }] best first, above `min` (`groups`: Pip's reading, see understand()). `boost(item)` adds context (recent use, the page
 *  the person is on, the kind of thing). */
export function rank(items, query, { groups, boost, min = 0.3, limit = 200 } = {}) {
  const out = [];
  for (const item of items) {
    const s = score(item, query, { groups });
    if (s > 0) { const total = s + (boost ? boost(item) : 0); if (total >= min) out.push({ item, score: total }); }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
