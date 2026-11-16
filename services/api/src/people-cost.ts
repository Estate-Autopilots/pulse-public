// COMP-B: Finance → People cost. The running budget (by month and pod: budget against actual payroll, committed pay
// records and planned roles), the cash forecast with people cost from the pay records, runway, and leadership's
// what-if scenarios, which never touch a record. The database checks and logs every read (0450, 0451); amounts are
// opened here. docs/ops/PAYROLL.md.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { payContext, payrollContext, requireKeyring, type Keyring } from "./document-keys.js";
import { openValue, sealValue, setBudgetHook, today, who } from "./comp.js";
import { isDay, monthEnd, monthStart, nextMonth, type Figures, type PayType } from "./comp-model.js";
import { applySteps, budgetCheck, budgetView, cashWithPeople, costByMonth, fyMonths, monthLabel, monthsFrom, personCost, runway,
  type BudgetCell, type CashMonth, type Pending, type Person, type Role, type Step } from "./payroll-model.js";
import { fail, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const rupeesIn = (v: unknown, what: string) => { const n = Number(String(v ?? "").replace(/[,₹\s]/g, "")); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) : fail(400, `${what} is not an amount`); };
const month = (v: unknown, what: string) => (typeof v === "string" && /^\d{4}-\d{2}$/.test(v) && isDay(`${v}-01`) ? `${v}-01` : fail(400, `Choose ${what}`));

// ----------------------------------------------------------------------------------------------- loading
/** The keyring, loaded only when there is something sealed to open (an empty company needs none). */
export type Ring = () => Promise<Keyring>;
export const lazyRing = (): Ring => { let p: Promise<Keyring> | null = null; return () => (p ??= requireKeyring("pay")); };

/** Everyone's pay records as the projection reads them, with offers and changes still waiting. */
export async function peopleModel(c: PoolClient, v: Viewer, ring: Ring) {
  const inp = (await c.query("select pulse.pay_projection_inputs() d")).rows[0].d as Row;
  const figures = new Map<string, Figures>(), amounts = new Map<string, number>();
  for (const r of (await c.query("select kind,id,person_id,kid,dkey,data from pulse.pay_projection_sealed()")).rows as Row[]) {
    if (r.kind === "change") figures.set(r.id, openValue<Figures>(await ring(), r, payContext(v.org, r.person_id, "change", r.id)));
    else amounts.set(r.id, openValue<{ amount: number }>(await ring(), r, payContext(v.org, r.person_id, "item", r.id)).amount);
  }
  const people: Person[] = [], pending: Pending[] = [];
  for (const p of inp.people as Row[]) {
    people.push({ id: p.id, name: p.name, pod: p.pod ?? null, department: p.department ?? null, status: p.status ?? null, start: p.start ?? null, end: p.end ?? null,
      versions: (p.versions as Row[]).filter((x) => figures.has(x.id)).map((x) => ({ effectiveOn: x.effectiveOn, payType: x.payType as PayType, figures: figures.get(x.id)! })),
      pauses: p.pauses ?? [], items: ((p.items ?? []) as Row[]).filter((i) => amounts.has(i.id)).map((i) => ({ kind: i.kind, amount: amounts.get(i.id)!, forMonth: i.forMonth, payout: i.payout })) });
    for (const q of (p.pending ?? []) as Row[]) if (figures.has(q.id)) pending.push({ id: q.id, person: p.id, pod: p.pod ?? null, kind: q.kind, from: q.from, payType: q.payType, figures: figures.get(q.id)!, label: q.label });
  }
  return { today: inp.today as string, people, pending, template: inp.components, planner: !!inp.planner, writer: !!inp.writer, raw: inp.people as Row[] };
}
export async function rolesOf(c: PoolClient, v: Viewer, ring: Ring) {
  const rows = (await c.query("select id,job_id,job,job_status,title,pod,count,from_month::text,status,note,created_by,updated_at,kid,dkey,data from pulse.pay_roles_sealed()")).rows as Row[];
  const k = rows.length ? await ring() : null;
  return rows.map((r) => ({
    id: r.id as string, jobId: r.job_id as string | null, job: r.job as string | null, jobStatus: r.job_status as string | null, title: r.title as string, pod: r.pod as string | null, count: r.count as number,
    from: String(r.from_month).slice(0, 10), status: r.status as string, note: r.note as string | null, by: r.created_by as string | null,
    monthly: openValue<{ monthly: number }>(k!, r, payrollContext(v.org, "role", r.id)).monthly }));
}
export async function budgetOf(c: PoolClient, v: Viewer, ring: Ring, from: string, to: string) {
  const rows = (await c.query("select month::text,pod,source,set_by,set_at,kid,dkey,data from pulse.pay_budget_sealed($1,$2)", [from, to])).rows as Row[];
  const k = rows.length ? await ring() : null;
  return rows.map((r) => ({
    month: String(r.month).slice(0, 10), pod: r.pod || null, source: r.source as string, by: r.set_by as string | null, at: r.set_at,
    amount: openValue<{ amount: number }>(k!, r, payrollContext(v.org, "budget", `${String(r.month).slice(0, 7)}/${r.pod}`)).amount }));
}
/** People cost of locked payroll by month and pod: salaries and employer contributions from the ledger. */
export async function actualsOf(c: PoolClient, v: Viewer, ring: Ring, from: string, to: string) {
  const rows = (await c.query("select id,month::text,account,pod,kid,dkey,data from pulse.pay_ledger($1,$2) where account in ('salaries','employer_contributions')", [from, to])).rows as Row[];
  const out = new Map<string, { month: string; pod: string | null; amount: number }>();
  for (const r of rows) {
    const k = `${String(r.month).slice(0, 10)}|${r.pod ?? ""}`, x = out.get(k) ?? { month: String(r.month).slice(0, 10), pod: r.pod ?? null, amount: 0 };
    x.amount += openValue<{ amount: number }>(await ring(), r, payrollContext(v.org, "ledger", r.id)).amount; out.set(k, x);
  }
  return [...out.values()];
}
/** The financial year's budget view, with what it is made of. */
async function budgetFor(c: PoolClient, v: Viewer, ring: Ring, day: string) {
  const months = fyMonths(day), from = months[0], to = months[11];
  const model = await peopleModel(c, v, ring), roles = await rolesOf(c, v, ring);
  const cells = await budgetOf(c, v, ring, from, to), actual = await actualsOf(c, v, ring, from, to);
  const cost = costByMonth(months, model.people, { roles: roles as Role[], pending: model.pending });
  return { months, model, roles, cells, actual, view: budgetView(months, { budget: cells as BudgetCell[], actual, cost, today: model.today }) };
}

/** FIN-LIVE's forecast and last bank balance, if the viewer has finance access (else null: the page says so). */
async function cashOf(c: PoolClient) {
  await c.query("savepoint pay_cash");
  try {
    const s = (await c.query("select pulse.finance_live_state() d")).rows[0].d as Row;
    await c.query("release savepoint pay_cash");
    const m = s?.model as Row | null;
    if (!m?.forecast?.months?.length) return { access: true, model: null };
    const p = (x: number) => Math.round(Number(x) * 100);
    const months: CashMonth[] = (m.forecast.months as Row[]).map((x) => ({ month: `${String(x.month).slice(0, 7)}-01`, label: x.label,
      base: { inflow: p(x.base.inflow), outflow: p(x.base.outflow) }, downside: { inflow: p(x.downside.inflow), outflow: p(x.downside.outflow) }, upside: { inflow: p(x.upside.inflow), outflow: p(x.upside.outflow) } }));
    const b = m.burn?.balance ?? null;
    return { access: true, model: { months, assumptions: (m.forecast.assumptions ?? []) as string[], confidence: m.forecast.confidence as string, basis: m.forecast.basis as string,
      balance: b ? { amount: p(b.amount), asOf: String(b.asOf), ageDays: Number(b.ageDays) } : null, computedAt: s.computedAt } };
  } catch (e) {
    await c.query("rollback to savepoint pay_cash");
    if (["42501", "P0001"].includes(String((e as { code?: string }).code))) return { access: false, model: null };
    throw e;
  }
}

// ------------------------------------------------------------------------------------------- the outlook
const KINDS = ["hire", "raise", "pause", "drop_role", "bonus", "exit"];
/** A scenario's steps from what leadership typed (rupees in, paise kept), refusing what does not make sense. */
export function readSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 40) fail(400, "A scenario has at most 40 steps");
  return (raw as Row[]).map((s): Step => {
    const kind = KINDS.includes(String(s.kind)) ? String(s.kind) : fail(400, "Choose what the step does");
    const scope = ["all", "pod", "person"].includes(String(s.scope)) ? (s.scope as "all" | "pod" | "person") : "all";
    const who = typeof s.person === "string" && UUID.test(s.person) ? s.person : null;
    if (kind === "hire") { const n = Number(s.count); if (!Number.isInteger(n) || n < 1 || n > 50) fail(400, "Hire 1 to 50 people");
      return { kind, count: n, role: str(s.role, 80) || "New hire", pod: str(s.pod, 80) || null, monthly: rupeesIn(s.monthly, "The pay a month") || fail(400, "Give the pay a month"), from: month(s.from, "the month they start") }; }
    if (kind === "raise") { const pct = s.percent === "" || s.percent == null ? null : Number(s.percent);
      if (pct !== null && (!Number.isFinite(pct) || pct < -50 || pct > 200)) fail(400, "A raise is between −50% and 200%");
      const amount = pct === null ? rupeesIn(s.amount, "The raise") : null;
      if (pct === null && !amount) fail(400, "Give the raise as a percent or an amount");
      if (scope === "person" && !who) fail(400, "Choose the person"); if (scope === "pod" && !str(s.pod, 80)) fail(400, "Choose the pod");
      return { kind, scope, pod: str(s.pod, 80) || null, person: who, percent: pct, amount, from: month(s.from, "the month it starts") }; }
    if (kind === "pause") { if (!who) fail(400, "Choose the person");
      const from = isDay(s.from) ? String(s.from) : fail(400, "Give the first day"), to = isDay(s.to) ? String(s.to) : fail(400, "Give the last day");
      if (to < from) fail(400, "The pause ends after it starts");
      const paid = Math.max(0, Math.min(99, Math.round(Number(s.paidPercent) || 0)));
      return { kind, person: who!, from, to, paidPercent: paid }; }
    if (kind === "drop_role") return { kind, role: typeof s.role === "string" && UUID.test(s.role) ? s.role : fail(400, "Choose the planned role") };
    if (kind === "bonus") { if (scope === "person" && !who) fail(400, "Choose the person");
      return { kind, scope, pod: str(s.pod, 80) || null, person: who, amount: rupeesIn(s.amount, "The bonus") || fail(400, "Give the bonus"), month: month(s.month, "the month it is paid"), each: s.each === true }; }
    if (!who) fail(400, "Choose the person");
    return { kind: "exit", person: who!, on: isDay(s.on) ? String(s.on) : fail(400, "Give the last day") };
  });
}

/** Base and scenario side by side: people cost, budget, burn, cash and runway, month by month. */
function outlook(m: Awaited<ReturnType<typeof peopleModel>>, roles: Role[], cells: BudgetCell[], cash: Awaited<ReturnType<typeof cashOf>>["model"], opening: number | null, steps: Step[] | null) {
  const thisMonth = monthStart(m.today), months = monthsFrom(nextMonth(thisMonth), 12);
  const baseline = costByMonth([thisMonth], m.people)[0].committed;
  const base = costByMonth(months, m.people, { roles, pending: m.pending });
  const applied = steps ? applySteps(m.people, roles, steps, m.template) : null;
  const scen = applied ? costByMonth(months, applied.people, { roles: applied.roles, pending: m.pending, extra: applied.extra }) : null;
  const budget = (mm: string) => { const x = cells.filter((b) => b.month === mm); return x.length ? x.reduce((a, b) => a + b.amount, 0) : null; };
  const cashBase = cash ? cashWithPeople(months, cash.months, base, baseline, opening) : null;
  const cashScen = cash && scen ? cashWithPeople(months, cash.months, scen, baseline, opening) : null;
  const rows = months.map((mm, i) => ({ month: mm, label: monthLabel(mm), budget: budget(mm),
    base: { cost: base[i].committed, planned: base[i].planned, burn: cashBase ? -cashBase[i].base.net : null, downsideBurn: cashBase ? -cashBase[i].downside.net : null, cash: cashBase?.[i].base.cash ?? null, held: cashBase?.[i].held ?? null },
    scenario: scen ? { cost: scen[i].committed, planned: scen[i].planned, burn: cashScen ? -cashScen[i].base.net : null, cash: cashScen?.[i].base.cash ?? null } : null }));
  const over = (k: "base" | "scenario") => rows.filter((r) => r.budget !== null && r[k] && r[k]!.cost + r[k]!.planned > r.budget).map((r) => r.month);
  return { thisMonth, baseline, months: rows,
    runway: { base: cashBase ? runway(cashBase, "base", opening) : null, downside: cashBase ? runway(cashBase, "downside", opening) : null, scenario: cashScen ? runway(cashScen, "base", opening) : null },
    overBudget: { base: over("base"), scenario: scen ? over("scenario") : null },
    yearCost: { base: base.reduce((a, x) => a + x.committed, 0), scenario: scen ? scen.reduce((a, x) => a + x.committed, 0) : null } };
}

/** What changes in the next months, dated (no amounts beyond the change in cost). */
function events(m: Awaited<ReturnType<typeof peopleModel>>, horizonEnd: string) {
  const out: { on: string; kind: string; person: string; label: string; change: number | null; until?: string }[] = [];
  const t = m.today;
  for (const p of m.raw) {
    const person = m.people.find((x) => x.id === p.id);
    if (!person) continue;
    const vs = [...person.versions].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
    for (let i = 0; i < vs.length; i++) if (vs[i].effectiveOn > t && vs[i].effectiveOn <= horizonEnd) {
      const before = i ? personCost({ ...person, versions: vs.slice(0, i), items: [] }, vs[i].effectiveOn) : 0, after = personCost({ ...person, versions: vs.slice(0, i + 1), items: [] }, vs[i].effectiveOn);
      out.push({ on: vs[i].effectiveOn, kind: i ? "change" : "start", person: p.name, label: i ? "Scheduled change" : "Starts", change: after - before });
    }
    if (p.probationTo && p.probationTo >= t && p.probationTo <= horizonEnd) out.push({ on: p.probationTo, kind: "probation", person: p.name, label: "Probation ends", change: null });
    if (p.end && p.end >= t && p.end <= horizonEnd) out.push({ on: p.end, kind: "exit", person: p.name, label: "Last day", change: -personCost({ ...person, end: null, items: [] }, nextMonth(p.end)) });
    for (const z of (p.pauses ?? []) as Row[]) if (z.to >= t && z.from <= horizonEnd) out.push({ on: z.from > t ? z.from : t, kind: "pause", person: p.name, label: "Paused", until: z.to, change: null });
  }
  for (const q of m.pending) if (q.from <= horizonEnd) out.push({ on: q.from, kind: q.kind === "offer" ? "offer" : "pending", person: m.raw.find((x) => x.id === q.person)?.name ?? "", label: q.kind === "offer" ? "Offer not yet accepted" : "Change waiting for approval", change: null });
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

async function scenariosOf(c: PoolClient, v: Viewer, ring: Ring) {
  const rows = (await c.query("select id,name,note,steps,created_by,created_at,updated_by,updated_at,kid,dkey,data from pulse.pay_scenarios_sealed()")).rows as Row[];
  const k = rows.length ? await ring() : null;
  return rows.map((r) => {
    const s = openValue<{ steps: Step[]; opening: number | null }>(k!, r, payrollContext(v.org, "scenario", r.id));
    return { id: r.id as string, name: r.name as string, note: r.note as string | null, by: r.created_by as string | null, at: r.updated_at, steps: s.steps, opening: s.opening ?? null };
  });
}

// ---------------------------------------------------------------------------------------------- routes
export function registerPeopleCostRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: "object" } as const;
  const reader = async (c: PoolClient) => { const w = await who(c); if (!w.reader) fail(403, "People cost is for founders and HR"); return w; };
  const planner = async (c: PoolClient, what: string) => { await reader(c); if (!(await c.query("select pulse.pay_planner() ok")).rows[0].ok) fail(403, what); };

  // COMP-A's Change pay and offer previews: the change's cost against the pod's budget.
  setBudgetHook(async (c, v, ring, pod, from, extra) => {
    const b = await budgetFor(c, v, () => Promise.resolve(ring), from);
    return budgetCheck(b.view, pod, from, extra);
  });

  // The one page: payroll this month, budget against actual, runway, What if… (saved scenarios to compare).
  app.get<{ Querystring: { opening?: string; compare?: string } }>("/api/v0/comp/people-cost", (req) => tx(req, async (c, v) => {
    await reader(c);
    const ring = lazyRing(), day = await today(c);
    const b = await budgetFor(c, v, ring, day), cash = await cashOf(c);
    const runs = (await c.query("select pulse.pay_runs() d")).rows[0].d as Row;
    const opening = req.query.opening !== undefined && req.query.opening !== "" ? rupeesIn(req.query.opening, "The opening balance") : cash.model?.balance?.amount ?? null;
    const scenarios = await scenariosOf(c, v, ring);
    const compare = String(req.query.compare ?? "").split(",").filter((x) => UUID.test(x)).slice(0, 3);
    const base = outlook(b.model, b.roles as Role[], b.cells as BudgetCell[], cash.model, opening, null);
    const compared = compare.map((cid) => scenarios.find((s) => s.id === cid)).filter(Boolean).map((s) => ({ id: s!.id, name: s!.name, steps: s!.steps,
      outlook: outlook(b.model, b.roles as Role[], b.cells as BudgetCell[], cash.model, opening, s!.steps) }));
    const thisMonth = monthStart(day), row = b.view.rows.find((r) => r.month === thisMonth);
    return {
      today: day, thisMonth,
      payroll: { runs: (runs.runs as Row[]).slice(0, 6), can: runs.can, withRecords: runs.withRecords, staff: runs.staff },
      budget: { months: b.months, rows: b.view.rows, pods: b.view.pods, alerts: b.view.alerts, thisMonth: row ?? null, set: b.cells.length > 0 },
      cash: cash.model ? { access: true, assumptions: cash.model.assumptions, confidence: cash.model.confidence, basis: cash.model.basis, balance: cash.model.balance, computedAt: cash.model.computedAt } : { access: cash.access },
      opening, openingAssumed: req.query.opening !== undefined && req.query.opening !== "",
      outlook: base, events: events(b.model, monthEnd(monthsFrom(nextMonth(thisMonth), 12)[11])),
      scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, note: s.note, by: s.by, at: s.at, steps: s.steps })), compared,
      people: b.model.people.filter((p) => !p.end || p.end >= day).map((p) => ({ id: p.id, name: p.name, pod: p.pod })).sort((x, y) => x.name.localeCompare(y.name)),
      roles: b.roles, jobs: (await c.query("select pulse.pay_jobs() j")).rows[0].j, coverage: { withRecords: runs.withRecords, staff: runs.staff }, can: { plan: b.model.planner, write: b.model.writer },
    };
  }));

  // ------------------------------------------------------------------------------------------ the budget
  app.get<{ Querystring: { fy?: string } }>("/api/v0/comp/budget", (req) => tx(req, async (c, v) => {
    await reader(c);
    const ring = lazyRing(), day = /^\d{4}$/.test(req.query.fy ?? "") ? `${Number(req.query.fy) - 1}-04-01` : await today(c);
    const b = await budgetFor(c, v, ring, day);
    const jobs = (await c.query("select pulse.pay_jobs() j")).rows[0].j;
    const pods = [...new Set([...b.model.people.map((p) => p.pod), ...b.cells.map((x) => x.pod), ...b.roles.map((r) => r.pod)].filter(Boolean) as string[])].sort();
    return { months: b.months, view: b.view, cells: b.cells, roles: b.roles, jobs, pods, can: { plan: b.model.planner }, today: b.model.today };
  }));
  // Cells: [{month: "2026-11", pod, amount (rupees, empty clears)}], or {pod, from, to, amount} for a range.
  app.post<{ Body: Body }>("/api/v0/comp/budget", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await planner(c, "Leadership sets the people budget");
    const b = req.body ?? {};
    let cells: { month: string; pod: string; amount: number | null }[];
    if (Array.isArray(b.cells)) cells = (b.cells as Row[]).slice(0, 600).map((x) => ({ month: month(x.month, "the month"), pod: str(x.pod, 80), amount: x.amount === "" || x.amount === null ? null : rupeesIn(x.amount, "The budget") }));
    else {
      const from = month(b.from, "the first month"), to = month(b.to, "the last month");
      if (to < from) fail(400, "The last month is after the first");
      cells = monthsFrom(from, 24).filter((m) => m <= to).map((m) => ({ month: m, pod: str(b.pod, 80), amount: b.amount === "" || b.amount === null ? null : rupeesIn(b.amount, "The budget") }));
    }
    const ring = await requireKeyring("pay");
    const n = (await c.query("select pulse.pay_budget_save($1) n", [{ cells: cells.map((x) => ({ month: x.month, pod: x.pod,
      sealed: x.amount === null ? null : sealValue(ring, { amount: x.amount }, payrollContext(v.org, "budget", `${x.month.slice(0, 7)}/${x.pod}`)) })) }])).rows[0].n;
    return { saved: n };
  }));
  // Seed the rest of the year from the last three months: locked payroll by pod where there is some, else the pay records.
  app.post<{ Body: Body }>("/api/v0/comp/budget/seed", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await planner(c, "Leadership sets the people budget");
    const ring = lazyRing(), day = await today(c), thisMonth = monthStart(day);
    const back = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number), d = new Date(Date.UTC(y, mo - 1 - n, 1)); return d.toISOString().slice(0, 10); };
    const last3 = [back(thisMonth, 3), back(thisMonth, 2), back(thisMonth, 1)];
    const actual = await actualsOf(c, v, ring, last3[0], monthEnd(last3[2]));
    const locked = new Set(actual.map((a) => a.month));
    const model = await peopleModel(c, v, ring), pods = [...new Set(model.people.map((p) => p.pod ?? ""))];
    const fromRecords = last3.filter((m) => !locked.has(m));
    const avg = new Map<string, number>();
    for (const pod of pods) {
      const paid = actual.filter((a) => (a.pod ?? "") === pod).reduce((x, a) => x + a.amount, 0);
      const rec = fromRecords.reduce((x, m) => x + model.people.filter((p) => (p.pod ?? "") === pod).reduce((y, p) => y + personCost(p, m), 0), 0);
      avg.set(pod, Math.round((paid + rec) / 3));
    }
    const existing = new Set((await budgetOf(c, v, ring, fyMonths(day)[0], fyMonths(day)[11])).map((x) => `${x.month}|${x.pod ?? ""}`));
    const cells = fyMonths(day).filter((m) => m >= thisMonth).flatMap((m) => pods.filter((pod) => (avg.get(pod) ?? 0) > 0 && (req.body?.overwrite === true || !existing.has(`${m}|${pod}`)))
      .map((pod) => ({ month: m, pod, amount: avg.get(pod)! })));
    const sealedCells = [];
    for (const x of cells) sealedCells.push({ month: x.month, pod: x.pod, sealed: sealValue(await ring(), { amount: x.amount }, payrollContext(v.org, "budget", `${x.month.slice(0, 7)}/${x.pod}`)) });
    const n = sealedCells.length ? (await c.query("select pulse.pay_budget_save($1) n", [{ cells: sealedCells, source: "seeded" }])).rows[0].n : 0;
    return { saved: n, basis: locked.size === 3 ? "Locked payroll of the last three months" : locked.size ? `Locked payroll for ${locked.size} of the last three months, pay records for the rest` : "Pay records of the last three months (no payroll locked yet)" };
  }));
  app.post<{ Body: Body }>("/api/v0/comp/budget/roles", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await planner(c, "Leadership plans roles and their cost");
    const b = req.body ?? {};
    const rid = typeof b.id === "string" && UUID.test(b.id) ? b.id : randomUUID();
    const p: Row = { id: rid };
    if (b.jobId !== undefined) p.jobId = typeof b.jobId === "string" && UUID.test(b.jobId) ? b.jobId : null;
    if (b.title !== undefined) p.title = str(b.title, 120);
    if (b.pod !== undefined) p.pod = str(b.pod, 80);
    if (b.count !== undefined) { const n = Number(b.count); if (!Number.isInteger(n) || n < 1 || n > 50) fail(400, "Plan 1 to 50 people"); p.count = n; }
    if (b.from !== undefined) p.from = month(b.from, "the month they start");
    if (b.status !== undefined) p.status = ["planned", "filled", "dropped"].includes(String(b.status)) ? b.status : fail(400, "Choose planned, filled or dropped");
    if (b.note !== undefined) p.note = str(b.note, 500);
    const monthly = b.monthly !== undefined && b.monthly !== "" ? rupeesIn(b.monthly, "The cost a month") : null;
    if (typeof b.id !== "string" && (!p.title || !p.from || monthly === null)) fail(400, "Give the role, the month they start and the cost a month");
    if (monthly !== null) p.sealed = sealValue(await requireKeyring("pay"), { monthly }, payrollContext(v.org, "role", rid));
    return { id: (await c.query("select pulse.pay_role_save($1) id", [p])).rows[0].id };
  }));

  // -------------------------------------------------------------------------------------------- scenarios
  app.get("/api/v0/comp/scenarios", (req) => tx(req, async (c, v) => { await reader(c); return { scenarios: await scenariosOf(c, v, lazyRing()) }; }));
  app.post<{ Body: Body }>("/api/v0/comp/scenarios/preview", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await reader(c);
    const steps = readSteps(req.body?.steps), ring = lazyRing(), day = await today(c);
    const b = await budgetFor(c, v, ring, day), cash = await cashOf(c);
    const opening = req.body?.opening !== undefined && req.body?.opening !== "" && req.body?.opening !== null ? rupeesIn(req.body.opening, "The opening balance") : cash.model?.balance?.amount ?? null;
    return { steps, outlook: outlook(b.model, b.roles as Role[], b.cells as BudgetCell[], cash.model, opening, steps) };
  }));
  app.post<{ Body: Body }>("/api/v0/comp/scenarios", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await planner(c, "Leadership saves scenarios");
    const b = req.body ?? {}, steps = readSteps(b.steps), name = str(b.name, 80);
    if (name.length < 2) fail(400, "Name the scenario");
    const sid = typeof b.id === "string" && UUID.test(b.id) ? b.id : randomUUID();
    const opening = b.opening !== undefined && b.opening !== "" && b.opening !== null ? rupeesIn(b.opening, "The opening balance") : null;
    const sealed = sealValue(await requireKeyring("pay"), { steps, opening }, payrollContext(v.org, "scenario", sid));
    return { id: (await c.query("select pulse.pay_scenario_save($1) id", [{ id: sid, name, note: str(b.note, 500), steps: steps.length, sealed }])).rows[0].id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/comp/scenarios/:id/archive", (req) => tx(req, async (c) => {
    await planner(c, "Leadership archives scenarios");
    await c.query("select pulse.pay_scenario_archive($1)", [typeof req.params.id === "string" && UUID.test(req.params.id) ? req.params.id : fail(404, "Scenario not found")]);
    return { ok: true };
  }));
}
