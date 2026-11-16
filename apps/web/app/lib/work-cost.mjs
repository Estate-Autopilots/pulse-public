// FIX-PEOPLE-MONEY C5 (owner, 10 Nov 2026: "Cost per task should also be calculated for humans: their hourly rate
// from salary, then cost per task and project. People cost and AI cost should sit side by side."): the arithmetic for
// People → Work and cost. Pure, so it is unit-tested.
//   * A person's rate: the month's payroll from the finance model (the cost sheet) ÷ the people on it ÷ 176 working
//     hours (22 days × 8 hours). It is the team's average rate: nobody's own salary is shown or worked out here.
//   * A person's cost per task: their share of payroll for the period ÷ the tasks others accepted from them in it.
//   * An AI employee's cost per task: the tokens it used on tasks ÷ the tasks accepted (in rupees once the platform has
//     a price for its model; until then in tokens).
export const HOURS_A_MONTH = 176;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const NOT_PEOPLE = /\b(ramis|synthetic)\b/i;

/** The latest month of payroll the finance model has: total, people and the average rate. Null without one. */
export function payRate(payroll) {
  const p = (payroll ?? []).filter((x) => num(x.total) && num(x.people)).at(-1);
  if (!p) return null;
  const monthly = p.total / p.people;
  return { month: p.month, total: p.total, people: p.people, monthly, hourly: monthly / HOURS_A_MONTH };
}

/** People's side for the last `weeks` weeks (this one included) from Outcomes' weekly counts of accepted tasks. */
export function peopleCost(people, rate, weeks) {
  const share = rate ? rate.monthly * (weeks * 7) / 30 : null;
  const rows = (people ?? []).filter((p) => !NOT_PEOPLE.test(`${p.name} ${p.role ?? ""}`)).map((p) => {
    const tasks = (p.values ?? []).slice(-weeks).reduce((n, v) => n + (num(v) ?? 0), 0);
    return { id: p.id, name: p.name, role: p.role ?? null, pod: p.pod ?? null, photoAt: p.photoAt ?? null, tasks, perTask: share !== null && tasks ? share / tasks : null };
  }).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name));
  const tasks = rows.reduce((n, r) => n + r.tasks, 0);
  const busy = rows.filter((r) => r.tasks).length;
  const cost = rate ? rate.total * (weeks * 7) / 30 : null;
  // The average over the people who finished tasks (their shares ÷ their tasks), so it sits among their own rows.
  return { rows, tasks, cost, busy, perTask: share !== null && tasks ? share * busy / tasks : null, idle: rows.length - busy };
}

/** AI employees' side from the throughput: accepted tasks, tokens on tasks, tokens (and rupees, with a price) per task. */
export function aiCost(agents, inrPerToken = null) {
  const rows = (agents ?? []).map((a) => {
    const tasks = num(a.accepted) ?? 0, tokens = num(a.tokens) ?? 0;
    return { id: a.id, name: a.name, role: a.title ?? null, tasks, given: num(a.given) ?? 0, returned: num(a.returned) ?? 0, tokens,
      perTask: tasks ? tokens / tasks : null, inr: inrPerToken !== null ? tokens * inrPerToken : null, inrPerTask: inrPerToken !== null && tasks ? tokens * inrPerToken / tasks : null };
  }).sort((a, b) => b.tasks - a.tasks || b.tokens - a.tokens || a.name.localeCompare(b.name));
  const tasks = rows.reduce((n, r) => n + r.tasks, 0), tokens = rows.reduce((n, r) => n + r.tokens, 0);
  return { rows, tasks, tokens, perTask: tasks ? tokens / tasks : null, inr: inrPerToken !== null ? tokens * inrPerToken : null };
}

/** Each project's cost from the finished tasks (GET work/cost/projects): a person's task costs their share of pay for
 *  the period over every task they finished in it, with or without a project (as on the People card); an AI task costs
 *  the tokens it used. Tasks without a project count for that split but make no row.
 *  `scope` (the page's People and AI cards) keeps the two in step: only tasks by the people and AI employees shown
 *  there count (Outcomes leaves out the viewer, QA robots and anyone not in the work roster), and a person's task
 *  costs their own pay per task from the People card when it has one. */
export function projectCost(tasks, rate, days, scope = null) {
  const share = rate ? rate.monthly * days / 30 : null;
  if (scope) tasks = (tasks ?? []).filter((t) => (t.ai ? scope.ai.has(t.who) : scope.people.has(t.who)));
  const perPerson = new Map();
  for (const t of tasks ?? []) if (!t.ai) perPerson.set(t.who, (perPerson.get(t.who) ?? 0) + 1);
  const byProject = new Map();
  for (const t of tasks ?? []) {
    if (!t.projectId) continue;
    const p = byProject.get(t.projectId) ?? { id: t.projectId, name: t.project ?? "A project", people: 0, ai: 0, cost: share === null ? null : 0, tokens: 0 };
    if (t.ai) { p.ai += 1; p.tokens += num(t.tokens) ?? 0; }
    else { p.people += 1; if (share !== null) p.cost += scope?.people.get(t.who) ?? share / perPerson.get(t.who); }
    byProject.set(t.projectId, p);
  }
  return [...byProject.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (b.people + b.ai) - (a.people + a.ai) || a.name.localeCompare(b.name));
}

/** Tokens as people read them: 1.2 M, 85 k, 900 (a no-break space, so a number never wraps away from its unit). */
export function tokensText(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}\u00a0M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}\u00a0k`;
  return String(Math.round(n));
}
