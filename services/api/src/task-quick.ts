/** One-line task entry: `Fix login on phone @Datup #Pulse fri !high`. Pure: the caller supplies today's date (the company's),
 *  the people and the projects; nothing is guessed when a name matches more than one record. */
export type QuickPerson = { id: string; name: string; username?: string | null; isAgent?: boolean };
export type QuickProject = { id: string; name: string };
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type QuickToken = { kind: 'person' | 'project' | 'due' | 'priority'; text: string; label: string };
export type QuickResult = { title: string; assignee: QuickPerson | null; project: QuickProject | null; dueOn: string | null; priority: Priority; tokens: QuickToken[]; problems: string[] };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRIORITY: Record<string, Priority> = { '!': 'high', '!!': 'urgent', '!!!': 'urgent', '!h': 'high', '!high': 'high', '!u': 'urgent', '!urgent': 'urgent', '!l': 'low', '!low': 'low', '!n': 'normal', '!normal': 'normal', '!p1': 'urgent', '!p2': 'high', '!p3': 'normal', '!p4': 'low' };
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const words = (s: string) => s.toLowerCase().replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '').split(/[^a-z0-9]+/).filter(Boolean);

export function addDays(day: string, n: number) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** A due phrase starting at token i: returns the date and how many tokens it used. */
function dueAt(tokens: string[], i: number, today: string): { day: string; used: number } | null {
  const t = tokens[i].toLowerCase().replace(/[.,]$/, ''), next = (tokens[i + 1] ?? '').toLowerCase().replace(/[.,]$/, '');
  if (['today', 'tod', 'tdy'].includes(t)) return { day: today, used: 1 };
  if (['tomorrow', 'tmr', 'tmrw', 'tom'].includes(t)) return { day: addDays(today, 1), used: 1 };
  if (t === 'eow') return { day: addDays(today, (5 - weekday(today) + 7) % 7), used: 1 };
  if (t === 'next' && next === 'week') return { day: addDays(today, ((1 - weekday(today) + 7) % 7) || 7), used: 2 };
  if (t === 'in' && /^\d{1,3}$/.test(next) && /^(day|days|d)$/.test((tokens[i + 2] ?? '').toLowerCase())) return { day: addDays(today, Number(next)), used: 3 };
  const wd = WEEKDAYS.findIndex((w) => t.length >= 3 && w.startsWith(t) && (t.length === 3 || w === t || t === w.slice(0, 4) || t === 'tues' || t === 'thur' || t === 'thurs'));
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
/** Day and month without a year: the next such date from today. */
function future(today: string, month: number, day: number, used: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = Number(today.slice(0, 4));
  const make = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (Number.isNaN(Date.parse(make(year))) || new Date(`${make(year)}T00:00:00Z`).getUTCDate() !== day) return null;
  if (make(year) < today) year += 1;
  return { day: make(year), used };
}

export function matchPerson(token: string, people: QuickPerson[], me: QuickPerson | null): { person: QuickPerson | null; problem?: string; candidates?: QuickPerson[] } {
  const q = token.toLowerCase();
  if (q === 'me' && me) return { person: me };
  const f = fold(q);
  const tiers = [
    (p: QuickPerson) => (p.username ?? '').toLowerCase() === q || fold(p.name) === f,
    (p: QuickPerson) => words(p.name)[0] === q,
    (p: QuickPerson) => words(p.name).some((w) => w === q),
    (p: QuickPerson) => fold(p.name).startsWith(f) || words(p.name).some((w) => w.startsWith(q)),
  ];
  for (const tier of tiers) {
    const hits = people.filter(tier);
    if (hits.length === 1) return { person: hits[0] };
    // Twin records of one person (the same name twice) cannot be told apart by typing more: the list comes with the
    // record people sign in with first (pulse.work_people()), so that one is meant.
    if (hits.length > 1 && hits.every((h) => fold(h.name) === fold(hits[0].name))) return { person: hits[0] };
    if (hits.length > 1) return { person: null, candidates: hits, problem: `@${token} matches ${hits.slice(0, 4).map((p) => p.name).join(', ')}${hits.length > 4 ? '…' : ''}: type more of the name` };
  }
  return { person: null, problem: `Nobody called @${token} is in the team list` };
}
export function matchProject(token: string, projects: QuickProject[]): { project: QuickProject | null; problem?: string; candidates?: QuickProject[] } {
  const f = fold(token);
  const tiers = [(p: QuickProject) => fold(p.name) === f, (p: QuickProject) => fold(p.name).startsWith(f), (p: QuickProject) => fold(p.name).includes(f)];
  for (const tier of tiers) {
    const hits = projects.filter(tier);
    if (hits.length === 1) return { project: hits[0] };
    if (hits.length > 1) return { project: null, candidates: hits, problem: `#${token} matches ${hits.length} projects (${hits.slice(0, 3).map((p) => p.name).join(', ')}…): type more of the name` };
  }
  return { project: null, problem: `No project called #${token}` };
}

export function parseQuick(text: string, today: string, people: QuickPerson[], projects: QuickProject[], me: QuickPerson | null = null): QuickResult {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const keep: string[] = [], found: QuickToken[] = [], problems: string[] = [];
  let assignee: QuickPerson | null = null, project: QuickProject | null = null, dueOn: string | null = null, priority: Priority = 'normal';
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i], bare = raw.replace(/[.,;:]+$/, '');
    if (/^@[\p{L}\p{N}._-]+$/u.test(bare) && bare.length > 1) {
      const r = matchPerson(bare.slice(1), people, me);
      if (r.person) {
        // "@Sana Khan": the rest of the name belongs to the mention, not to the title.
        const rest = words(r.person.name); let at = rest.findIndex((w) => w.startsWith(bare.slice(1).toLowerCase())) + 1, used = 0;
        while (at > 0 && at < rest.length && (tokens[i + 1 + used] ?? '').toLowerCase().replace(/[.,;:]+$/, '') === rest[at]) { used++; at++; }
        found.push({ kind: 'person', text: tokens.slice(i, i + 1 + used).join(' '), label: r.person.name }); assignee = r.person; i += used;
      } else { problems.push(r.problem!); keep.push(raw); }
      continue;
    }
    if (/^#[\p{L}\p{N}._&-]+$/u.test(bare) && bare.length > 1) {
      const r = matchProject(bare.slice(1).replace(/[-_]/g, ' '), projects);
      if (r.project) { project = r.project; found.push({ kind: 'project', text: raw, label: r.project.name }); } else { problems.push(r.problem!); keep.push(raw); }
      continue;
    }
    if (PRIORITY[bare.toLowerCase()]) { priority = PRIORITY[bare.toLowerCase()]; found.push({ kind: 'priority', text: raw, label: priority }); continue; }
    // A date phrase is the due date only at the end of the line, after the title ("Monday review", "Sun city banner" stay titles).
    const due = keep.length ? dueAt(tokens, i, today) : null;
    if (due && !tokens.slice(i + due.used).every((x) => /^[@#!]/.test(x))) { keep.push(raw); continue; }
    if (due && !dueOn) { dueOn = due.day; found.push({ kind: 'due', text: tokens.slice(i, i + due.used).join(' '), label: due.day }); i += due.used - 1; continue; }
    keep.push(raw);
  }
  const title = keep.join(' ').replace(/\s+([,.;:])/g, '$1').trim();
  if (!title) problems.push('Add a few words saying what needs doing');
  return { title, assignee, project, dueOn, priority, tokens: found, problems };
}
