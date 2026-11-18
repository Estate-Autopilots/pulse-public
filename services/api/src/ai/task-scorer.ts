/** UX-TASKS-2 / TASKS-4B / UX-5B: Pip proposes importance, value points and effort for a task, with a one-line reason and (v2) a
 *  breakdown that says how much each signal added. UX-5B reads the value as a cost of delay (business value + time
 *  criticality + what it unlocks) and adds its priority, weighted shortest job first (cost of delay ÷ size), with the
 *  company's own estimate accuracy and a confidence; see docs/ops/VALUE.md for the research behind it. Pulse has no language-model seam today, so the scorer behind this
 *  interface is a transparent heuristic: every number comes from the task's size, kind of work, project and client, its
 *  deadline, what it unlocks, how similar finished work went and was valued, and how leadership has adjusted Pip before.
 *  The same inputs always give the same answer. The method is written down in docs/ops/VALUE.md. A model-backed scorer
 *  can implement TaskScorer later; nothing here reads keys or calls out. */

export type Importance = 'low' | 'normal' | 'high' | 'urgent';
export type ScoreInput = {
  title: string;
  category: string | null;
  categoryLabel?: string | null;
  priority?: string | null;                 // what the creator chose, if anything other than normal
  dueOn: string | null;
  today: string;
  project: { name: string; kind: 'internal' | 'fulfilment' | null; packageBand: number | null } | null;  // band 1–4: quartile of package value
  similar: { n: number; minutes: number | null; minutesN: number; cycleDays: number | null; value: number | null; points: number | null } | null;
  /** TASKS-4B: the estimate someone gave, the work waiting on this task (how many tasks, their value), the kind of work's
   *  accepted value (median, how many) and leadership's past changes to Pip's value for it (median chosen ÷ suggested). */
  estimateMinutes?: number | null;
  unlocks?: { tasks: number; value: number } | null;
  baseline?: { n: number; value: number | null } | null;
  learning?: { n: number; ratio: number | null } | null;
  /** UX-5B: how long estimated work here really took: the median of captured ÷ estimated minutes over finished tasks. */
  calibration?: { n: number; ratio: number | null } | null;
};
/** UX-5B: the priority, weighted shortest job first. Cost of delay (= the value points) split into business value, time
 *  criticality and enablement (what it unlocks), the size in hours, and the score (points per hour) work is ordered by. */
export type Priority = { method: 'wsjf'; version: '1'; businessValue: number; timeCriticality: number; enablement: number; costOfDelay: number; sizeHours: number;
  score: number; confidence: 'low' | 'medium' | 'high'; confidenceScore: number; why: string };
/** One line of "how was this worked out": the signal, what it saw, and the points it added (or took away). */
export type Step = { signal: 'size' | 'baseline' | 'similar' | 'client' | 'deadline' | 'unlocks' | 'learning'; label: string; detail: string; points: number };
export type Suggestion = { importance: Importance; valuePoints: number; effortMinutes: number; reason: string; confidence: 'low' | 'medium' | 'high';
  basis: string[]; model: string; version: string; breakdown?: Step[]; priority?: Priority };
export interface TaskScorer { readonly name: string; readonly version: string; suggest(input: ScoreInput): Promise<Suggestion> }

/** Typical hands-on minutes per kind of work when nothing similar has been finished yet. */
export const TYPICAL_MINUTES: Record<string, number> = {
  video_shoot: 300, video_edit: 180, design: 90, scripting: 60, meta_ads: 90, google_ads: 90, social: 45, onboarding: 60, setup_admin: 60, client_service: 30,
  sales: 45, web: 240, engineering: 240, qa: 120, hr: 60, finance: 60, operations: 45, research: 120,
};
const BIG = /\b(full|complete|whole|series|campaign|launch|set of|all|end[- ]to[- ]end|overhaul|redesign|rebuild|migrate|brand film)\b/i;
// "check" is a quick look; a check-in is Pulse's attendance ("test arrival check-in with 2 people" is not small work).
const SMALL = /\b(quick|small|minor|tiny|typo|rename|resend|re-?share|reminder|check(?![- ]?ins?\b)|confirm|follow[- ]?up|call)\b/i;
const URGENT = /\b(urgent|asap|immediately|right away|today|tonight|by eod)\b/i;
const LOW = /\b(someday|nice to have|idea|maybe|explore|when free|backlog)\b/i;

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const roundMinutes = (m: number) => m < 60 ? Math.max(5, Math.round(m / 5) * 5) : m < 240 ? Math.round(m / 15) * 15 : Math.round(m / 30) * 30;
export function hoursLabel(m: number) { return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`.replace('.0 h', ' h'); }

/** Value points: about 1 point for half an hour of routine work, 10 for a solid day's deliverable, 25 or more for
 *  client-critical multi-day work. Size sets the base; the kind of work's usual value and what similar work was valued
 *  at pull it toward precedent; client work, the deadline and the work it unlocks raise it; leadership's past
 *  adjustments for this kind of work correct Pip's habit. Each step is kept in `breakdown`. */
export const heuristicScorer: TaskScorer = {
  name: 'pip-heuristic',
  version: '2',
  async suggest(x: ScoreInput): Promise<Suggestion> {
    const basis: string[] = []; const why: string[] = []; const steps: Step[] = [];
    const label = (x.categoryLabel ?? x.category ?? 'task').toLowerCase();
    // Effort: an estimate someone gave, else what similar finished work took, else the usual for this kind of work.
    let effort: number; let confidence: Suggestion['confidence'] = 'low'; let sizeWhy: string;
    const s = x.similar;
    let sizeSure = 0.3;
    if (x.estimateMinutes && x.estimateMinutes >= 5) {
      effort = x.estimateMinutes; confidence = 'medium'; sizeWhy = `the estimate: about ${hoursLabel(roundMinutes(effort))}`; sizeSure = 0.65;
      basis.push(`Estimated at about ${hoursLabel(roundMinutes(effort))}`);
      // UX-5B: estimates run short (the planning fallacy); the company's own record says by how much. Fewer finished
      // tasks pull the correction toward none (shrinkage), and it stays between half and three times.
      const cal = x.calibration;
      if (cal && cal.n >= 3 && cal.ratio) {
        const k = 1 + (clamp(cal.ratio, 0.5, 3) - 1) * (cal.n / (cal.n + 5));
        if (Math.abs(k - 1) >= 0.05) {
          effort *= k; sizeSure = 0.8;
          sizeWhy += `, ×${round2(k)} for how long estimated work here really takes (${cal.n} tasks)`;
          basis.push(`Estimates here run ${k > 1 ? 'short' : 'long'}: ×${round2(k)} from ${cal.n} finished tasks with time`);
        }
      }
    } else if (s && s.minutesN >= 2 && s.minutes) {
      effort = s.minutes; confidence = s.minutesN >= 4 ? 'high' : 'medium'; sizeSure = s.minutesN >= 4 ? 0.85 : 0.7; sizeWhy = `${s.minutesN} similar finished tasks took about ${hoursLabel(roundMinutes(s.minutes))}`;
      basis.push(`${s.minutesN} similar finished tasks took about ${hoursLabel(roundMinutes(s.minutes))} (median)`);
      why.push(`about ${hoursLabel(roundMinutes(s.minutes))} like ${s.minutesN} past ${label} tasks`);
    } else {
      effort = TYPICAL_MINUTES[x.category ?? ''] ?? 60; if (x.category) { confidence = 'medium'; sizeSure = 0.5; }
      sizeWhy = x.category ? `usual for ${label}: about ${hoursLabel(effort)}` : 'no kind of work recognised: an hour as a start';
      basis.push(x.category ? `Usual for ${label}: about ${hoursLabel(effort)}` : 'No kind of work recognised: an hour as a start');
    }
    if (!x.estimateMinutes) {
      if (BIG.test(x.title)) { effort *= 1.6; basis.push('The title reads as a large piece of work'); sizeWhy += ', a large piece of work'; }
      else if (SMALL.test(x.title)) { effort *= 0.5; basis.push('The title reads as a small piece of work'); sizeWhy += ', a small piece of work'; }
      const count = x.title.match(/\b([2-9]|1[0-2])\s+(reels?|videos?|posts?|creatives?|ads?|banners?|carousels?|scripts?|edits?)\b/i);
      if (count) { effort *= Math.min(6, Number(count[1])) * 0.7; basis.push(`${count[1]} pieces named in the title`); sizeWhy += `, ${count[1]} pieces`; }
    }
    effort = clamp(roundMinutes(effort), 5, 20000);
    // "About 3 h of video editing"; with no kind recognised just "About 1 h" ("of task" read oddly in the create dialog).
    if (!why.length) why.push(x.category ? `about ${hoursLabel(effort)} of ${label}` : `about ${hoursLabel(effort)}`);

    // Importance: the deadline, the words used, what the creator already said, client work.
    let importance: Importance = 'normal';
    const due = x.dueOn ? days(x.today, x.dueOn) : null;
    if (URGENT.test(x.title) || (due !== null && due <= 0)) importance = 'urgent';
    else if (due !== null && due <= 2) importance = 'high';
    else if (LOW.test(x.title) && (due === null || due > 14)) importance = 'low';
    if (x.project?.kind === 'fulfilment' && importance === 'normal' && (x.project.packageBand ?? 0) >= 4) importance = 'high';
    if (x.priority && x.priority !== 'normal' && ['low', 'normal', 'high', 'urgent'].includes(x.priority)) { importance = x.priority as Importance; basis.push('Kept the importance the creator chose'); }
    let dueWords: string | null = null;
    if (due !== null) { dueWords = due < 0 ? `${-due} day${due === -1 ? '' : 's'} late` : due === 0 ? 'due today' : `due in ${due} day${due === 1 ? '' : 's'}`; basis.push(`Deadline: ${dueWords}`); why.push(dueWords); }

    // Value, step by step.
    let value = (effort / 60) * 1.25;
    steps.push({ signal: 'size', label: 'Size', detail: `${sizeWhy} (about 1¼ points an hour)`, points: round1(value) });
    const b = x.baseline;
    if (b && b.n >= 3 && b.value) {
      const before = value; value = value * 0.6 + b.value * 0.4;
      steps.push({ signal: 'baseline', label: 'Kind of work', detail: `${x.categoryLabel ?? 'This kind of work'} is usually valued at ${Math.round(b.value)} points (${b.n} accepted)`, points: round1(value - before) });
      basis.push(`${x.categoryLabel ?? 'This kind of work'} is usually valued at about ${Math.round(b.value)} points (${b.n} accepted)`);
      if (confidence === 'low') confidence = 'medium';
    }
    const precedent = s?.value ?? s?.points ?? null;
    if (precedent && s && s.n >= 2) {
      const before = value; value = value * 0.5 + precedent * 0.5;
      steps.push({ signal: 'similar', label: 'Similar past tasks', detail: `${s.n} similar finished tasks were valued at about ${Math.round(precedent)} points`, points: round1(value - before) });
      basis.push(`Similar work was valued at about ${Math.round(precedent)} points`);
    }
    if (x.project?.kind === 'fulfilment') {
      const band = x.project.packageBand; const before = value;
      value *= band === 4 ? 1.6 : band === 3 ? 1.35 : 1.25;
      const quarter = band ? ` (package in the ${['', 'lowest', 'second', 'third', 'top'][band]} quarter by value)` : '';
      steps.push({ signal: 'client', label: 'Client and revenue', detail: `Client work for ${x.project.name}${quarter}`, points: round1(value - before) });
      basis.push(`Client work for ${x.project.name}${quarter}`);
      why.push(`client work for ${x.project.name}`);
    } else if (x.project) { basis.push(`Internal project ${x.project.name}`); }
    const factor = importance === 'urgent' ? 1.3 : importance === 'high' ? 1.15 : importance === 'low' ? 0.7 : 1;
    let urgencyPts = 0, unlockPts = 0;
    if (factor !== 1) { const before = value; value *= factor; urgencyPts = value - before; steps.push({ signal: 'deadline', label: 'Deadline and urgency', detail: `${importance[0].toUpperCase()}${importance.slice(1)}${dueWords ? `: ${dueWords}` : ''}`, points: round1(value - before) }); }
    const u = x.unlocks;
    if (u && u.tasks > 0) {
      const before = value; const add = u.value > 0 ? Math.min(value * 0.5, u.value * 0.25) : Math.min(value * 0.5, u.tasks * 0.5);
      value += add; unlockPts = add;
      steps.push({ signal: 'unlocks', label: 'What it unlocks', detail: `${u.tasks} task${u.tasks === 1 ? '' : 's'} wait${u.tasks === 1 ? 's' : ''} on it${u.value ? `, worth ${u.value} points` : ''}`, points: round1(value - before) });
      basis.push(`Unlocks ${u.tasks} task${u.tasks === 1 ? '' : 's'}${u.value ? ` worth ${u.value} points` : ''}`);
      why.push(`unlocks ${u.tasks} task${u.tasks === 1 ? '' : 's'}`);
    }
    const l = x.learning; let learnt = 1;
    if (l && l.n >= 3 && l.ratio && Math.abs(l.ratio - 1) >= 0.05) {
      const ratio = clamp(l.ratio, 0.5, 2); const before = value; value *= ratio; learnt = ratio;
      steps.push({ signal: 'learning', label: 'Leadership’s past changes', detail: `Leadership changed Pip’s value for ${label} ${l.n} times, by ${ratio > 1 ? '+' : ''}${Math.round((ratio - 1) * 100)} % (median)`, points: round1(value - before) });
      basis.push(`Leadership's past changes for ${label}: ${ratio > 1 ? '+' : ''}${Math.round((ratio - 1) * 100)} %`);
      if (confidence === 'medium' && l.n >= 5) confidence = 'high';
    }
    const valuePoints = clamp(Math.round(value), 1, 100);
    const reason = `${why.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()).slice(0, 180);
    // UX-5B: the same number read as a cost of delay, and the priority it gives for its size.
    const evidence = Math.min(1, (b?.n ?? 0) / 10) * 0.1 + Math.min(1, (l?.n ?? 0) / 10) * 0.1 + (precedent && s && s.n >= 2 ? 0.05 : 0);
    const priority = wsjf({ costOfDelay: valuePoints, timeCriticality: urgencyPts * learnt, enablement: unlockPts * learnt, effortMinutes: effort, sure: Math.min(1, sizeSure + evidence),
      client: x.project?.kind === 'fulfilment' ? x.project.name : null, dueWords, unlocks: u?.tasks ?? 0 });
    return { importance, valuePoints, effortMinutes: effort, reason, confidence, basis, model: this.name, version: this.version, breakdown: steps, priority };
  },
};

/** UX-5B: weighted shortest job first (Reinertsen's CD3; SAFe's WSJF; Smith's rule for the least weighted delay).
 *  Cost of delay is split into what it is worth, how much of that is lost by waiting (time criticality: the deadline)
 *  and what it unlocks (enablement); priority = cost of delay ÷ size in hours. Points per hour: about 1¼ is routine
 *  work, 3 or more is work to do early. */
export function wsjf(x: { costOfDelay: number; timeCriticality: number; enablement: number; effortMinutes: number; sure: number; client?: string | null; dueWords?: string | null; unlocks?: number }): Priority {
  const timeCriticality = round1(x.timeCriticality), enablement = round1(Math.max(0, x.enablement));
  const businessValue = round1(Math.max(0, x.costOfDelay - timeCriticality - enablement));
  const sizeHours = Math.max(0.25, Math.round((x.effortMinutes / 60) * 100) / 100);
  const score = round1(x.costOfDelay / sizeHours);
  const confidenceScore = round2(clamp(x.sure, 0, 1));
  const parts: string[] = [];
  if (x.client) parts.push(`client work for ${x.client}`);
  if (x.dueWords && timeCriticality > 0) parts.push(x.dueWords);
  if (x.unlocks) parts.push(`unlocks ${x.unlocks} task${x.unlocks === 1 ? '' : 's'}`);
  parts.push(`about ${hoursLabel(Math.round(sizeHours * 60))}`);
  const verdict = score >= 3 ? 'worth doing early' : score >= 1 ? 'steady value for its size' : 'a big job for its value: split it or schedule it';
  return { method: 'wsjf', version: '1', businessValue, timeCriticality, enablement, costOfDelay: x.costOfDelay, sizeHours, score,
    confidence: confidenceScore >= 0.75 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low', confidenceScore, why: `${parts.join(', ')}: ${verdict}.`.replace(/^./, (c) => c.toUpperCase()) };
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The seam: one scorer for the API. An LLM-backed scorer can be returned here when Pulse has one. */
export function taskScorer(): TaskScorer { return heuristicScorer; }
