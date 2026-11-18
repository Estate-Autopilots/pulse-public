/** PM-BUILD-1 (17 Nov 2026; KAZUK-PM-2 phase 1): read a delivery timeline written as a document (a Google Doc exported
 *  as plain text) into the steps of a delivery template, format 3. A company writes how it delivers as tables of rows
 *  (ID · Step · Owner · Day · Depends on · Type · Packages, and optionally Hours); each row becomes one step. Nothing here
 *  names a company: the package names, the clocks and which step records each clock come from the caller.
 *
 *  Format 3 of a step (the template keeps offsets; dates are worked out when a clock is recorded):
 *    id, stage (the phase's number), title, owner (the role in the document's words), type (task · approval · gate ·
 *    milestone · ongoing · repeating · auto), kind (= type, read by older screens), from (the clock it counts from:
 *    start · day0 · live · bought), start / end (days on that clock; end null = runs on), after (step ids it waits on),
 *    packages ({key: yes|optional|no}), clientInput, hours [min, max], when (a condition key), byPackage (other days per
 *    package), gateInputs (a gate's or milestone's inputs, when they differ from `after`), note (what the row said that the
 *    fields do not hold). */

export type Clock = { key: 'start' | 'day0' | 'live' | 'bought'; label: string; day?: number; step?: string; inputs?: string[] };
export type ImportOptions = {
  /** The company's packages: key and the words the document uses for it ("Sell-Out"). */
  packages: { key: string; label: string }[];
  /** The clocks: start (where the plan begins, at `day` on the document's scale), day0 (recorded by `step`), live
   *  (recorded by `step`; days after it count from it), bought (add-ons, days from the purchase). */
  clocks: Clock[];
  /** Days of the live clock in the document's scale (the live step's planned day), so "Day 21" after it is live + 0. */
  liveDay?: number;
};
export type ImportedStep = {
  id: string; stage: number; title: string; owner: string; type: string; kind: string; from: Clock['key']; start: number; end: number | null;
  after: string[]; packages: Record<string, 'yes' | 'optional' | 'no'>; clientInput: boolean; hours?: [number, number]; when?: string;
  byPackage?: Record<string, { start: number; end: number | null }>; gateInputs?: string[]; note?: string; match: string[];
};
export type ImportResult = { stages: { n: number; key: string; label: string }[]; steps: ImportedStep[]; warnings: string[] };

const ID = /^[A-Z]{1,3}\d{1,3}$/;
const MINUS = /[−–—]/g;
const HEADERS = new Set(['ID', 'Step', 'Owner', 'Day', 'Day from purchase', 'Depends on', 'Type', 'Packages', 'Hours']);

/** "−7" · "−7 to −6" · "2–4" · "12" · "28 onward" · "Monthly from 30" · "+0 to +40" · "45 onward" · "With the shoot". */
export function parseDays(raw: string): { start: number | null; end: number | null; repeat?: string } {
  const s = raw.trim().replace(/[−]/g, '-');
  const n = (x: string) => Number(x.replace(/^\+/, ''));
  let m = s.match(/^(monthly|weekly)\s+from\s+(-?\d+)$/i);
  if (m) return { start: n(m[2]), end: null, repeat: m[1].toLowerCase() };
  m = s.match(/^([+-]?\d+)\s+onward$/i);
  if (m) return { start: n(m[1]), end: null };
  m = s.match(/^([+-]?\d+)\s*(?:to|–|—|-(?=\s*[+\d]))\s*([+-]?\d+)$/);
  if (m) return { start: n(m[1]), end: n(m[2]) };
  m = s.match(/^([+-]?\d+)$/);
  if (m) return { start: n(m[1]), end: n(m[1]) };
  return { start: null, end: null };
}

const TYPES: Record<string, string> = { task: 'task', approval: 'approval', gate: 'gate', milestone: 'milestone', ongoing: 'ongoing', recurring: 'repeating',
  auto: 'auto', 'client input': 'task', 'add-on': 'task', 'add-on chain': 'task' };

/** The packages a row belongs to, from the document's words ("All", "Growth, Sell-Out", "Sell-Out, add-on", "As V1",
 *  "Bonus on Sell-Out; paid on request in Growth and Starter", "Optional"). */
export function parsePackages(raw: string, pkgs: ImportOptions['packages'], earlier: Map<string, ImportedStep>): { packages: Record<string, 'yes' | 'optional' | 'no'>; when?: string; note?: string } {
  const s = raw.trim();
  const all = (v: 'yes' | 'optional' | 'no') => Object.fromEntries(pkgs.map((p) => [p.key, v])) as Record<string, 'yes' | 'optional' | 'no'>;
  const as = s.match(/^As ([A-Z]{1,3}\d{1,3})$/);
  if (as && earlier.has(as[1])) { const e = earlier.get(as[1])!; return { packages: { ...e.packages }, when: e.when }; }
  if (!s || /^optional$/i.test(s)) return { packages: all('optional') };
  const out = all('no');
  const named = (part: string) => pkgs.filter((p) => new RegExp(`\\b${p.label.replace(/[-]/g, '[- ]?')}\\b`, 'i').test(part));
  // "Bonus on Sell-Out; paid on request in Growth and Starter": the first part is in the package, the rest optional.
  const [main, ...rest] = s.split(/;\s*/);
  if (/^all\b/i.test(main)) Object.assign(out, all('yes'));
  for (const p of named(main)) out[p.key] = 'yes';
  for (const part of rest) for (const p of named(part)) if (out[p.key] === 'no') out[p.key] = /request|add-?on|paid/i.test(part) ? 'optional' : 'yes';
  // "Sell-Out, add-on": the others may buy it as an add-on.
  if (/add-?on/i.test(main)) for (const p of pkgs) if (out[p.key] === 'no') out[p.key] = 'optional';
  const when = /real buyers/i.test(s) ? 'realBuyers' : undefined;
  const note = Object.values(out).every((v) => v === 'no') ? `Packages: ${s}` : /;|tier|basic|professional/i.test(s) && !rest.length ? undefined : rest.length ? `Packages: ${s}` : undefined;
  return { packages: out, when, note };
}

/** The tables of a document's text export: a table starts at a line "ID"; its other cells are tab-indented lines. */
function tables(text: string): { heading: string; phase: string; cells: string[] }[] {
  const lines = text.split(/\r?\n/);
  const out: { heading: string; phase: string; cells: string[] }[] = [];
  let heading = '', phase = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], line = raw.trim();
    if (line === 'ID' && !raw.startsWith('\t')) {
      const cells: string[] = ['ID'];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('\t')) { cells.push(lines[j].trim()); j++; }
      out.push({ heading, phase, cells });
      i = j - 1; continue;
    }
    if (!raw.startsWith('\t') && line && line.length <= 90 && !/[.:]$/.test(line) && !/^\d+\./.test(line) && !/^[*☒☐]/.test(line)) {
      heading = line;
      if (/^(stage|phase)\s+\d/i.test(line) || /^(training|paid add-ons|brand identity)/i.test(line)) phase = line;
    }
  }
  return out;
}

/** The phase a heading names, as a short label ("Phase 2 — Creative Assets™, Curiosity Assets (Day 3–80)" → "Phase 2 ·
 *  Creative Assets™"). Two tables under the same phase with different sub-groups ("Trust Assets") keep the phase's words. */
function phaseLabel(h: string) {
  const [head, rest] = h.split(/\s+[—–-]\s+/, 2);
  const words = (rest ?? '').replace(/\s*\(.*\)\s*$/, '').split(/,\s*/)[0];
  return rest ? `${head} · ${words}` : head.replace(/\s*\(.*\)\s*$/, '');
}

export function importTimeline(text: string, o: ImportOptions): ImportResult {
  const warnings: string[] = [];
  const stages: ImportResult['stages'] = [];
  const steps: ImportedStep[] = [];
  const byId = new Map<string, ImportedStep>();
  const clock = (k: Clock['key']) => o.clocks.find((c) => c.key === k);
  for (const t of tables(text)) {
    const head: string[] = [];
    let k = 0;
    while (k < t.cells.length && HEADERS.has(t.cells[k])) head.push(t.cells[k++]);
    if (!head.includes('Step') || !head.includes('Owner')) { warnings.push(`A table under "${t.heading}" has no Step and Owner columns; skipped`); continue; }
    const label = phaseLabel(t.phase || t.heading);
    let stage = stages.find((s) => s.label === label);
    if (!stage) { stage = { n: stages.length, key: `s${stages.length}`, label }; stages.push(stage); }
    const bought = head.includes('Day from purchase');
    for (let r = k; r + head.length <= t.cells.length; r += head.length) {
      const row = Object.fromEntries(head.map((h, i) => [h, t.cells[r + i] ?? ''])) as Record<string, string>;
      if (!ID.test(row.ID)) { warnings.push(`Row "${row.ID}" under "${t.heading}" is not a step id; the table was read up to it`); break; }
      const days = parseDays(row.Day ?? row['Day from purchase'] ?? '');
      const typeWord = (row.Type ?? 'Task').trim().toLowerCase();
      const type = TYPES[typeWord] ?? (days.repeat ? 'repeating' : 'task');
      const depText = (row['Depends on'] ?? '').replace(MINUS, '-');
      // "K3, or K2 where no shoot is needed": the first is what it waits on; the alternative stays in the note.
      const after = [...new Set((depText.split(/,?\s+or\s+/i)[0].match(/\b[A-Z]{1,3}\d{1,3}\b/g) ?? []))].filter((x) => x !== row.ID);
      const pk = bought ? { packages: Object.fromEntries(o.packages.map((p) => [p.key, 'optional' as const])) } : parsePackages(row.Packages ?? 'All', o.packages, byId);
      const hours = (row.Hours ?? '').match(/(\d+)(?:\s*[–-]\s*(\d+))?/);
      const notes: string[] = [];
      if (/accepted|first draft|confirmation|or |plus|where/i.test(depText)) notes.push(`Waits on: ${depText}`);
      const months = [...(row.Day ?? '').matchAll(/month\s+(\d+)\s+on\s+([^;]+)/gi)];
      if (days.start === null && (row.Day ?? row['Day from purchase'])) notes.push(`Days: ${row.Day ?? row['Day from purchase']}`);
      if (pk.note) notes.push(pk.note);
      if (days.repeat) notes.push(`Repeats ${days.repeat}`);
      const step: ImportedStep = {
        id: row.ID, stage: stage.n, title: row.Step.replace(/\s+/g, ' ').trim(), owner: row.Owner.trim(), type, kind: type,
        from: bought ? 'bought' : 'day0', start: days.start ?? 0, end: days.repeat ? null : days.end, after,
        packages: pk.packages, clientInput: typeWord === 'client input', match: [],
        ...(hours ? { hours: [Number(hours[1]), Number(hours[2] ?? hours[1])] as [number, number] } : {}), ...(pk.when ? { when: pk.when } : {}),
        ...(notes.length ? { note: notes.join(' · ') } : {}),
      };
      // "J3 plus 30 days": starts that many days after the step it names.
      const plus = depText.match(/\b([A-Z]{1,3}\d{1,3})\s+plus\s+(\d+)\s+days?/i);
      if (plus) { step.after = [plus[1]]; (step as ImportedStep & { plus?: number }).plus = Number(plus[2]); }
      // "Month 2 on Starter; month 4 on Growth and Sell-Out": days per package, counted in months of 30 days.
      if (months.length) {
        step.byPackage = {};
        for (const [, mo, who] of months) for (const p of o.packages) if (new RegExp(`\\b${p.label.replace(/[-]/g, '[- ]?')}\\b`, 'i').test(who)) step.byPackage[p.key] = { start: (Number(mo) - 1) * 30, end: Number(mo) * 30 };
        const first = Object.values(step.byPackage)[0]; if (first) { step.start = first.start; step.end = first.end; }
      }
      if (byId.has(step.id)) { warnings.push(`Step ${step.id} appears twice; the second row was skipped`); continue; }
      byId.set(step.id, step); steps.push(step);
    }
  }
  // Waits on a step the document does not have (a typo such as LG6 when the chain ends at LG5): dropped and named.
  for (const s of steps) {
    const gone = s.after.filter((x) => !byId.has(x));
    if (gone.length) { warnings.push(`${s.id} waits on ${gone.join(', ')}, which the document does not have`); s.after = s.after.filter((x) => byId.has(x)); }
  }
  // The clocks. A step that (through what it waits on) follows the live step counts from going live; one that starts on
  // a negative day (before everything is in) counts from the plan's start; add-ons from the purchase; the rest from day 0.
  const live = clock('live'), start = clock('start'), day0 = clock('day0');
  const afterLive = new Set<string>();
  if (live?.step) {
    let grew = true;
    while (grew) { grew = false; for (const s of steps) if (!afterLive.has(s.id) && s.id !== live.step && s.after.some((a) => a === live.step || afterLive.has(a))) { afterLive.add(s.id); grew = true; } }
  }
  const liveDay = o.liveDay ?? (live?.step ? byId.get(live.step)?.end ?? 0 : 0);
  for (const s of steps) {
    const plus = (s as ImportedStep & { plus?: number }).plus;
    if (s.from === 'bought') continue;
    if (afterLive.has(s.id) && live) {
      s.from = 'live';
      if (plus !== undefined) { const len = s.end === null ? null : s.end - s.start; s.start = plus; s.end = len === null ? null : plus + len; }
      else if (!s.byPackage) { s.start = s.start - liveDay; s.end = s.end === null ? null : s.end - liveDay; }
    } else if (start && (s.start < 0 || (day0?.step && s.stage === byId.get(day0.step)?.stage && s.id !== day0.step && s.start <= 0))) {
      s.from = 'start'; const at = start.day ?? 0; s.start -= at; s.end = s.end === null ? null : s.end - at;
    } else if (start && day0?.step === s.id) {
      // The step that records day 0 is planned on the start clock (it is expected when the inputs are due).
      s.from = 'start'; const at = start.day ?? 0; s.start -= at; s.end = s.end === null ? null : s.end - at;
    }
    delete (s as ImportedStep & { plus?: number }).plus;
  }
  for (const c of o.clocks) {
    if (!c.step) continue;
    const s = byId.get(c.step);
    if (!s) { warnings.push(`The ${c.label} clock names step ${c.step}, which the document does not have`); continue; }
    if (c.inputs?.length) {
      const missing = c.inputs.filter((x) => !byId.has(x));
      if (missing.length) warnings.push(`${c.label} lists inputs ${missing.join(', ')} the document does not have`);
      s.gateInputs = c.inputs.filter((x) => byId.has(x));
    }
  }
  return { stages, steps, warnings };
}
