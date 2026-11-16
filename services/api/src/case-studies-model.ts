// CASE-STUDIES (owner, 10 Nov 2026): the case-study journey's fixed protocol and the suggested-goal rules, kept apart
// from the routes so they are tested on their own (test/case-studies-model.test.mjs).
// - The protocol: every company goes through the same 8 stages with the same checklist (Yin's "case study protocol":
//   the same steps for each case, so cases can be compared; reports/CASE-STUDIES-research.md). A stage is done when its
//   checklist is done; the app never asks for a judgement call.
// - Suggested goals: typed decision rules, no LLM (DECISION-MODELS.md: a deterministic rule with an enum verdict,
//   numbers, plain reasons and an engine version). The Goals app and a case file use the same rules: Goals reads the
//   company's own Finance and Clients; a case file reads the starting numbers typed in it.

export const JOURNEY_DAYS = 45;

export type StageKey = 'convince' | 'data' | 'understand' | 'podcasts' | 'own_ai' | 'insights' | 'onboarding' | 'price';
export type Check = { key: string; label: string };
export type Stage = { n: number; key: StageKey; label: string; what: string; checks: readonly Check[] };

export const STAGES: readonly Stage[] = [
  { n: 1, key: 'convince', label: 'Convince', what: 'Show them something that makes them say "this is amazing".', checks: [
    { key: 'offer', label: 'Write the offer and the words for it' },
    { key: 'demo', label: 'Show them a demo they love' },
    { key: 'yes', label: 'They agree to start the 45 days' }] },
  { n: 2, key: 'data', label: 'Trust & data', what: 'Put an AI employee in their business to collect data.', checks: [
    { key: 'agree', label: 'Agree in writing what data we take and keep' },
    { key: 'agent', label: 'Link the AI employee that collects their data' },
    { key: 'exports', label: 'Get their exports: accounts, bank, leads, chats' },
    { key: 'numbers', label: 'Enter 3 months of starting numbers' }] },
  { n: 3, key: 'understand', label: 'Understand', what: 'Learn the business, its pain points and its offer, in meetings.', checks: [
    { key: 'flow', label: 'Map their client flow, from first call to repeat sale' },
    { key: 'pains', label: 'Write down their top pain points' },
    { key: 'meeting', label: 'Link the meeting where we talked it through' },
    { key: 'problem', label: 'Agree on the one biggest problem to fix' }] },
  { n: 4, key: 'podcasts', label: 'Podcasts', what: 'Record talks with the owner. Clips become their content and our proof.', checks: [
    { key: 'consent', label: 'They say yes to recording and sign the release' },
    { key: 'record', label: 'Record a podcast and link its meeting' },
    { key: 'clips', label: 'Cut clips they can post' }] },
  { n: 5, key: 'own_ai', label: 'Their own AI', what: 'They get their own Claude or ChatGPT, and our agents run on their server.', checks: [
    { key: 'workbench', label: 'Run their data on the test workbench for a day' },
    { key: 'account', label: 'They buy their own Claude or ChatGPT' },
    { key: 'server', label: 'Our agents run on their server and fill their dashboard' }] },
  { n: 6, key: 'insights', label: 'Insights & goals', what: 'Show what we found and set goals from their real numbers.', checks: [
    { key: 'insights', label: 'Show them what we found' },
    { key: 'goals', label: 'Set goals from their real numbers' },
    { key: 'projects', label: 'Make a project for each goal' }] },
  { n: 7, key: 'onboarding', label: 'Onboarding', what: 'Train their team to run the business on Vitals.', checks: [
    { key: 'hr', label: 'Train the team on check-in and leave' },
    { key: 'catalogue', label: 'Set up their catalogue and prices' },
    { key: 'connect', label: 'Each person connects Claude or ChatGPT' },
    { key: 'ask', label: 'Show the team how to get answers by asking' }] },
  { n: 8, key: 'price', label: 'Price', what: 'Agree the price from the results: a one-time fee and a revenue share.', checks: [
    { key: 'baseline', label: 'Both sides sign the starting numbers' },
    { key: 'after', label: 'Enter the results after 45 days' },
    { key: 'deal', label: 'Agree the one-time fee and the revenue share' },
    { key: 'story', label: 'Write the case study and get their OK' }] },
];
export const STAGE_COUNT = STAGES.length;
/** Every checklist item's id: "<stage key>.<check key>". */
export const CHECK_IDS: readonly string[] = STAGES.flatMap((s) => s.checks.map((c) => `${s.key}.${c.key}`));

/** The archive's tags (research §6): sector, problem, what we did. Each case keeps them as fields. */
export const SECTORS = ['Interior design', 'Real estate', 'Health and wellness', 'Food', 'Education', 'Professional services', 'Retail',
  'Manufacturing', 'Agency', 'Travel', 'Other'] as const;
export const PROBLEMS = ['Revenue fell', 'Revenue stuck', 'Too few leads', 'Leads don\'t buy', 'Owner does everything', 'Slow payments',
  'Team quality', 'No systems'] as const;
export const MOVES = ['AI employee', 'Dashboard', 'Automation', 'Offer and words', 'Podcasts and content', 'Team training', 'Goals and projects',
  'Pricing'] as const;

export type Checks = Record<string, boolean>;
/** A stage's checklist with what is ticked. */
export function stageChecks(stage: Stage, done: Checks) {
  return stage.checks.map((c) => ({ id: `${stage.key}.${c.key}`, label: c.label, done: done[`${stage.key}.${c.key}`] === true }));
}
export const stageDone = (stage: Stage, done: Checks) => stage.checks.every((c) => done[`${stage.key}.${c.key}`] === true);
/** The first open item of the current stage, as "Next: …" (null when the journey is finished). */
export function nextStep(stageN: number, done: Checks): string | null {
  const s = STAGES[stageN - 1];
  if (!s) return null;
  return s.checks.find((c) => done[`${s.key}.${c.key}`] !== true)?.label ?? `Mark "${s.label}" done`;
}
/** Day of the journey (1 on the start day) in the company's time zone's calendar, and how many days past 45. */
export function journeyDay(startedOn: string, today: string) {
  const d = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startedOn}T00:00:00Z`)) / 86_400_000) + 1;
  const day = Math.max(1, d);
  return { day, of: JOURNEY_DAYS, over: Math.max(0, day - JOURNEY_DAYS) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Suggested goals: typed rules (engine goal-rules-v1).

export const ENGINE = 'goal-rules-v1';
export type Metric = 'revenue' | 'clients' | 'leads';
export type Verdict = 'grow' | 'recover' | 'steady' | 'need_data';
export type MonthValue = { month: string; value: number | null };
export type Suggestion = {
  metric: Metric; verdict: Verdict;
  /** Average of the last 3 months with numbers. */ baseline: number | null;
  /** The suggested monthly target, low to high. */ low: number | null; high: number | null;
  /** Best month in the last 12. */ peak: number | null;
  /** Last 3 vs the 3 before, as a fraction (-0.2 = 20% down). */ trend: number | null;
  monthsUsed: number; reasons: string[]; engine: typeof ENGINE;
};
/** The owner's example (10 Nov 2026): "you're at ₹10 L a month; next year's month-1 goal is ₹10–15 L", so a growing business
 *  aims for its baseline to 1.5 times it. A business at less than half its best month aims to win back toward the best. A
 *  business falling 10% or more first stops the slide. These are starting rules, not industry benchmarks (there is no
 *  research data per industry yet); they change only with a new engine version. */
export const RULES = { minMonths: 3, stretch: 0.5, recoverWhenPeakOver: 2, recoverLow: 1.5, recoverCap: 3, fallingAt: -0.1, steadyHigh: 1.2 } as const;

const WHAT: Record<Metric, { one: string; unit: (n: number) => string }> = {
  revenue: { one: 'revenue', unit: (n) => rupees(n) },
  clients: { one: 'new clients', unit: (n) => `${fmt(n)} new client${n === 1 ? '' : 's'}` },
  leads: { one: 'new leads', unit: (n) => `${fmt(n)} lead${n === 1 ? '' : 's'}` },
};
const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
/** ₹ in lakh and crore, as the Goals app writes it (₹4.2 L, ₹1.1 Cr, ₹85,000). */
export function rupees(n: number): string {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '')} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(1).replace(/\.0$/, '')} L`;
  return `${s}₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(a))}`;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const roundTo = (metric: Metric, n: number) => metric === 'revenue' ? Math.round(n / 1000) * 1000 : Math.round(n);

/** One metric's suggestion from its monthly numbers (oldest first; only the last 12 count; months without a number are skipped). */
export function suggest(metric: Metric, months: readonly MonthValue[]): Suggestion {
  const vals = months.slice(-12).map((m) => m.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const w = WHAT[metric];
  const base = { metric, baseline: null, low: null, high: null, peak: null, trend: null, monthsUsed: vals.length, engine: ENGINE } as const;
  if (vals.length < RULES.minMonths)
    return { ...base, verdict: 'need_data', reasons: [`We need at least ${RULES.minMonths} months of ${w.one} numbers; we have ${vals.length}.`] };
  const last3 = vals.slice(-3), baseline = mean(last3), peak = Math.max(...vals);
  const prev3 = vals.length >= 6 ? vals.slice(-6, -3) : null;
  const trend = prev3 && mean(prev3) > 0 ? baseline / mean(prev3) - 1 : null;
  if (baseline <= 0)
    return { ...base, verdict: 'need_data', peak, trend, reasons: [`The last 3 months show no ${w.one}, so there is nothing to grow from yet.`] };
  const avg = `Your last 3 months averaged ${w.unit(roundTo(metric, baseline))} a month.`;
  let verdict: Verdict, low: number, high: number; const reasons = [avg];
  if (peak >= RULES.recoverWhenPeakOver * baseline) {
    verdict = 'recover'; low = baseline * RULES.recoverLow; high = Math.min(peak, baseline * RULES.recoverCap);
    reasons.push(`Your best month was ${w.unit(roundTo(metric, peak))}, more than double that.`, 'Aim to win back toward your best month.');
  } else if (trend !== null && trend <= RULES.fallingAt) {
    verdict = 'steady'; low = baseline; high = baseline * RULES.steadyHigh;
    reasons.push(`That is ${Math.round(-trend * 100)}% less than the 3 months before.`, 'First stop the fall, then grow.');
  } else {
    verdict = 'grow'; low = baseline; high = baseline * (1 + RULES.stretch);
    reasons.push('Aim to keep this and grow it by up to half.');
  }
  low = roundTo(metric, low); high = Math.max(roundTo(metric, high), metric === 'revenue' ? low : low + 1);
  return { ...base, verdict, baseline: roundTo(metric, baseline), low, high, peak: roundTo(metric, peak), trend: trend === null ? null : Math.round(trend * 1000) / 1000, reasons };
}

/** All three, with the lead rule: to reach the clients target at today's rate of leads to clients, you need this many leads. */
export function suggestAll(series: Record<Metric, readonly MonthValue[]>): Suggestion[] {
  const revenue = suggest('revenue', series.revenue), clients = suggest('clients', series.clients), leads = suggest('leads', series.leads);
  if (clients.high !== null && clients.baseline && leads.baseline && leads.high !== null && leads.verdict !== 'need_data') {
    const perClient = leads.baseline / clients.baseline;            // leads it takes to win one client
    const needed = Math.ceil(clients.high * perClient);
    if (needed > leads.high) leads.high = needed;
    leads.reasons.push(`To win ${clients.high} new clients a month at your rate (about ${fmt(Math.round(perClient * 10) / 10)} leads for each client), you need about ${needed} leads a month.`);
  }
  return [revenue, clients, leads];
}

/** Turns typed months ([{ month: "2026-08", revenue, clients, leads }]) into the three series. */
export type CaseMonth = { month: string; revenue: number | null; clients: number | null; leads: number | null };
export function seriesOf(months: readonly CaseMonth[]): Record<Metric, MonthValue[]> {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  return {
    revenue: sorted.map((m) => ({ month: m.month, value: m.revenue })),
    clients: sorted.map((m) => ({ month: m.month, value: m.clients })),
    leads: sorted.map((m) => ({ month: m.month, value: m.leads })),
  };
}
