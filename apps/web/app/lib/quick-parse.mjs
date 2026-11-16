// TASKS-3: the quick-add line, read while it is typed: `Fix login on phone @Datup #Pulse fri !high`. The same rules as
// the API's services/api/src/task-quick.ts (a parity test keeps them equal), plus what a live input needs: a #word that
// names no project is a tag, every recognised part knows where it sits in the text (so a chip can remove it), and the
// part being typed at the caret drives the suggestions. Pure; the caller supplies today (IST), people and projects.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const PRIORITY = { "!": "high", "!!": "urgent", "!!!": "urgent", "!h": "high", "!high": "high", "!u": "urgent", "!urgent": "urgent", "!l": "low", "!low": "low", "!n": "normal", "!normal": "normal", "!p1": "urgent", "!p2": "high", "!p3": "normal", "!p4": "low" };
const fold = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const words = (s) => s.toLowerCase().replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(/[^a-z0-9]+/).filter(Boolean);

export function addDays(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

function future(today, month, day, used) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = Number(today.slice(0, 4));
  const make = (y) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (Number.isNaN(Date.parse(make(year))) || new Date(`${make(year)}T00:00:00Z`).getUTCDate() !== day) return null;
  if (make(year) < today) year += 1;
  return { day: make(year), used };
}
/** A due phrase starting at token i: the date and how many tokens it used. */
function dueAt(tokens, i, today) {
  const t = tokens[i].toLowerCase().replace(/[.,]$/, ""), next = (tokens[i + 1] ?? "").toLowerCase().replace(/[.,]$/, "");
  if (["today", "tod", "tdy"].includes(t)) return { day: today, used: 1 };
  if (["tomorrow", "tmr", "tmrw", "tom"].includes(t)) return { day: addDays(today, 1), used: 1 };
  if (t === "eow") return { day: addDays(today, (5 - weekday(today) + 7) % 7), used: 1 };
  if (t === "next" && next === "week") return { day: addDays(today, ((1 - weekday(today) + 7) % 7) || 7), used: 2 };
  if (t === "in" && /^\d{1,3}$/.test(next) && /^(day|days|d)$/.test((tokens[i + 2] ?? "").toLowerCase())) return { day: addDays(today, Number(next)), used: 3 };
  const wd = WEEKDAYS.findIndex((w) => t.length >= 3 && w.startsWith(t) && (t.length === 3 || w === t || t === w.slice(0, 4) || t === "tues" || t === "thur" || t === "thurs"));
  if (wd >= 0) return { day: addDays(today, (wd - weekday(today) + 7) % 7), used: 1 };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t))) return { day: t, used: 1 };
  const dm = t.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (dm) return future(today, Number(dm[2]), Number(dm[1]), 1);
  const num = t.match(/^(\d{1,2})(st|nd|rd|th)?$/), mon = MONTHS.findIndex((m) => next.startsWith(m) && next.length <= 9);
  if (num && mon >= 0) return future(today, mon + 1, Number(num[1]), 2);
  const mon2 = MONTHS.findIndex((m) => t.startsWith(m) && t.length <= 9), num2 = next.match(/^(\d{1,2})(st|nd|rd|th)?$/);
  if (mon2 >= 0 && num2) return future(today, mon2 + 1, Number(num2[1]), 2);
  return null;
}

/** People whose name or username fits what was typed, best first. Twin records of one name count as one person. */
export function findPeople(query, people, me = null) {
  const q = query.toLowerCase(); if (q === "me" && me) return [me];
  const f = fold(q);
  const tiers = [(p) => (p.username ?? "").toLowerCase() === q || fold(p.name) === f, (p) => words(p.name)[0] === q, (p) => words(p.name).some((w) => w === q),
    (p) => fold(p.name).startsWith(f) || words(p.name).some((w) => w.startsWith(q)) || (p.username ?? "").toLowerCase().startsWith(q)];
  const out = [], seen = new Set();
  for (const tier of tiers) for (const p of people) if (tier(p) && !seen.has(p.id) && !out.some((x) => fold(x.name) === fold(p.name))) { out.push(p); seen.add(p.id); }
  return out;
}
export function matchPerson(token, people, me = null) {
  const q = token.toLowerCase();
  if (q === "me" && me) return { person: me };
  const f = fold(q);
  const tiers = [(p) => (p.username ?? "").toLowerCase() === q || fold(p.name) === f, (p) => words(p.name)[0] === q, (p) => words(p.name).some((w) => w === q),
    (p) => fold(p.name).startsWith(f) || words(p.name).some((w) => w.startsWith(q))];
  for (const tier of tiers) {
    const hits = people.filter(tier);
    if (hits.length === 1) return { person: hits[0] };
    if (hits.length > 1 && hits.every((h) => fold(h.name) === fold(hits[0].name))) return { person: hits[0] };
    if (hits.length > 1) return { person: null, problem: `@${token} matches ${hits.slice(0, 4).map((p) => p.name).join(", ")}${hits.length > 4 ? "…" : ""}: pick one`, hits };
  }
  return { person: null, problem: `Nobody called @${token} is in the team list` };
}
export function matchProject(token, projects) {
  const f = fold(token);
  const tiers = [(p) => fold(p.name) === f, (p) => fold(p.name).startsWith(f), (p) => fold(p.name).includes(f)];
  for (const tier of tiers) {
    const hits = projects.filter(tier);
    if (hits.length === 1) return { project: hits[0] };
    if (hits.length > 1) return { project: null, problem: `#${token} matches ${hits.length} projects: pick one`, hits };
  }
  return { project: null };
}
const cleanTag = (t) => t.replace(/^#+/, "").toLowerCase().replace(/[^\p{L}\p{N}_&-]/gu, "").slice(0, 40);

/** Read a line. Tokens carry their place in the text ([start, end)) so one can be taken out again. */
export function parseLine(text, { today, people = [], projects = [], me = null }) {
  const spans = [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  const tokens = spans.map((s) => s.text);
  const keep = [], found = [], problems = [], tags = [];
  let assignee = null, project = null, dueOn = null, priority = "normal";
  for (let i = 0; i < spans.length; i++) {
    const raw = tokens[i], bare = raw.replace(/[.,;:]+$/, ""), at = spans[i];
    if (/^@[\p{L}\p{N}._-]+$/u.test(bare) && bare.length > 1) {
      const r = matchPerson(bare.slice(1), people, me);
      if (r.person) {
        const rest = words(r.person.name); let k = rest.findIndex((w) => w.startsWith(bare.slice(1).toLowerCase())) + 1, used = 0;
        while (k > 0 && k < rest.length && (tokens[i + 1 + used] ?? "").toLowerCase().replace(/[.,;:]+$/, "") === rest[k]) { used++; k++; }
        assignee = r.person; found.push({ kind: "person", text: tokens.slice(i, i + 1 + used).join(" "), label: r.person.name, id: r.person.id, start: at.start, end: spans[i + used].end }); i += used;
      } else { problems.push({ kind: "person", text: r.problem, start: at.start, end: at.end }); keep.push(raw); }
      continue;
    }
    if (/^#[\p{L}\p{N}._&-]+$/u.test(bare) && bare.length > 1) {
      const r = matchProject(bare.slice(1).replace(/[-_]/g, " "), projects);
      if (r.project) { project = r.project; found.push({ kind: "project", text: raw, label: r.project.name, id: r.project.id, start: at.start, end: at.end }); }
      else if (r.problem) { problems.push({ kind: "project", text: r.problem, start: at.start, end: at.end }); keep.push(raw); }
      else { const tag = cleanTag(bare); if (tag && !tags.includes(tag)) tags.push(tag); found.push({ kind: "tag", text: raw, label: tag, start: at.start, end: at.end }); }
      continue;
    }
    if (PRIORITY[bare.toLowerCase()]) { priority = PRIORITY[bare.toLowerCase()]; found.push({ kind: "priority", text: raw, label: priority, start: at.start, end: at.end }); continue; }
    // A date phrase is the due date only at the end of the line, after the title ("Monday review" stays a title).
    const due = keep.length ? dueAt(tokens, i, today) : null;
    if (due && !tokens.slice(i + due.used).every((x) => /^[@#!]/.test(x))) { keep.push(raw); continue; }
    if (due && !dueOn) { dueOn = due.day; found.push({ kind: "due", text: tokens.slice(i, i + due.used).join(" "), label: due.day, start: at.start, end: spans[i + due.used - 1].end }); i += due.used - 1; continue; }
    keep.push(raw);
  }
  const title = keep.join(" ").replace(/\s+([,.;:])/g, "$1").trim();
  return { title, assignee, project, dueOn, priority, tags, tokens: found, problems };
}

/** The @person, #project or !priority being typed at the caret, for suggestions. */
export function activeToken(text, caret) {
  const before = text.slice(0, caret), m = before.match(/(^|\s)([@#!])([\p{L}\p{N}._&-]{0,40})$/u);
  if (!m) return null;
  const after = text.slice(caret).match(/^[\p{L}\p{N}._&-]*/u)?.[0] ?? "";
  const start = before.length - m[2].length - m[3].length;
  return { kind: m[2] === "@" ? "person" : m[2] === "#" ? "project" : "priority", query: m[3] + after, start, end: caret + after.length };
}

/** Take [start, end) out of the text and tidy the spaces it leaves. */
export function cut(text, start, end) { return `${text.slice(0, start)}${text.slice(end)}`.replace(/\s{2,}/g, " ").replace(/^\s+/, ""); }
