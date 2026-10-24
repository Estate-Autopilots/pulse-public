// COMP-B (owner, 13 Oct 2026): the monthly payroll run, payslips, the bank file and the people-cost ledger on COMP-A's
// pay records. The database decides who may have which sealed values and logs every look (0450_payroll.sql); this module
// opens them, works the month out (payroll-model.ts), seals what it saves and draws the payslips. Pulse never pays: a
// founder downloads the bank file and uploads it in the bank's portal. docs/ops/PAYROLL.md.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { buildLetterModel, financialYear, letterMoney, renderLetterPdf } from "@pulse/invoice-doc";
import { bankContext, open as unseal, payContext, payrollContext, requireKeyring, type Keyring } from "./document-keys.js";
import { fonts, letterhead, openBytes, openValue, ringOrNull, sealBytes, sealValue, sha, today, who } from "./comp.js";
import { isDay, type Figures, type Line, type PayType } from "./comp-model.js";
import { bankFile, correction, ledgerFor, monthLabel, payrollLine, payslipLetter, runTotals, type Adjustment, type Payslip, type PtSlab, type Statutory } from "./payroll-model.js";
import { fail, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (v: unknown, what: string) => (typeof v === "string" && UUID.test(v) ? v : fail(404, `${what} not found`));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const CATEGORY: Record<string, string> = { travel: "travel", meals: "meals", internet: "internet and phone", equipment: "equipment", shoot: "shoot expenses", other: "other" };
const lineContext = (org: string, person: string, run: string) => payContext(org, person, "payroll", run);
const RUN_EXCEPTIONS: Record<string, string> = { before_cutoff: "The attendance cut-off for this month has not passed", attendance_off: "Attendance tracking is off: no loss of pay is read" };

/** HR (and leadership) or a founder, before anything else is read (the access matrix posts empty bodies). */
async function need(c: PoolClient, what: "read" | "write" | "approve" | "writeOrApprove", text = "Payroll is for founders and HR") {
  const w = await who(c);
  const ok = what === "read" ? w.reader || w.approver : what === "write" ? w.writer : what === "approve" ? w.approver : w.writer || w.approver;
  if (!ok) fail(403, text);
  return w;
}

/** Works out every person's month for a run and saves it as the run's next calculation. */
export async function computeRun(c: PoolClient, v: Viewer, runId: string) {
  const inp = (await c.query("select pulse.pay_run_inputs($1) d", [runId])).rows[0].d as Row;
  if (!["draft", "checked"].includes(inp.run.status)) fail(400, "A locked payroll is corrected with a new run, not recalculated");
  const ring = await requireKeyring("pay");
  const sealed = (await c.query("select kind,id,person_id,seq,kid,dkey,data from pulse.pay_run_sealed($1)", [runId])).rows as Row[];
  const figures = new Map<string, Figures>(), amounts = new Map<string, number>(), settlements = new Map<string, Row>(), adjust = new Map<string, number>();
  const previous = new Map<string, { seq: number; slip: Payslip }>(), carries = new Map<string, { runId: string; month: string; amount: number }[]>();
  for (const r of sealed) {
    if (r.kind === "change") figures.set(r.id, openValue<Figures>(ring, r, payContext(v.org, r.person_id, "change", r.id)));
    else if (r.kind === "item" || r.kind === "claim") amounts.set(r.id, openValue<{ amount: number }>(ring, r, payContext(v.org, r.person_id, r.kind, r.id)).amount);
    else if (r.kind === "settlement") settlements.set(r.id, openValue<Row>(ring, r, payContext(v.org, r.person_id, "settlement")));
    else if (r.kind === "adjustment") adjust.set(r.id, openValue<{ amount: number }>(ring, r, payContext(v.org, r.person_id, "pay-adjustment", r.id)).amount);
    else if (r.kind === "previous") {
      const slip = openValue<Payslip>(ring, r, lineContext(v.org, r.person_id, r.id));
      if (!previous.has(r.person_id) || previous.get(r.person_id)!.seq < r.seq) previous.set(r.person_id, { seq: r.seq, slip });
    } else if (r.kind === "carry") {
      const slip = openValue<Payslip>(ring, r, lineContext(v.org, r.person_id, r.id));
      if ((slip.difference ?? 0) < 0) carries.set(r.person_id, [...(carries.get(r.person_id) ?? []), { runId: r.id, month: slip.month, amount: -(slip.difference ?? 0) }]);
    }
  }
  const correcting = inp.run.kind === "correction", month = String(inp.run.month).slice(0, 10);
  const slips: Payslip[] = [], lines: Row[] = [];
  for (const p of inp.people as Row[]) {
    const versions = (p.versions as Row[]).filter((x) => figures.has(x.id)).map((x) => ({ effectiveOn: x.effectiveOn, payType: x.payType as PayType, figures: figures.get(x.id)! }));
    const s = p.settlement && settlements.has(p.settlement.id) ? settlements.get(p.settlement.id)! : null;
    let slip = payrollLine({
      month, person: { id: p.id, name: p.name, role: p.role ?? null, pod: p.pod ?? null, department: p.department ?? null },
      start: p.record?.startOn ?? null, end: p.record?.endOn ?? null, versions, pauses: p.pauses,
      items: (p.items as Row[]).filter((i) => amounts.has(i.id)).map((i) => ({ ...i, amount: amounts.get(i.id)! })) as never,
      claims: (p.claims as Row[]).filter((k) => amounts.has(k.id)).map((k) => ({ id: k.id, amount: amounts.get(k.id)!, forMonth: k.forMonth, label: `Reimbursement: ${k.vendor || CATEGORY[k.category] || k.category}` })),
      settlement: s ? { id: p.settlement.id, lines: s.lines as Line[], net: s.net, preparedOn: p.settlement.preparedOn ?? null } : null,
      attendance: p.attendance, rules: inp.settings.attendance, statutory: inp.settings.statutory as Statutory, dayBasis: inp.policy.dayBasis, template: inp.policy.components,
      pt: p.pt ?? null, ptSlabs: (inp.ptRule?.slabs ?? null) as PtSlab[] | null,
      adjustments: (p.adjustments as Row[]).map((a) => ({ ...a, amount: a.kind === "amount" ? adjust.get(a.id) ?? 0 : null })) as Adjustment[],
      carries: correcting ? [] : carries.get(p.id) ?? [], bank: p.bank ?? { onFile: false, status: "pending" }, pendingClaims: p.pendingClaims,
    });
    if (correcting) { const c2 = correction(slip, previous.get(p.id)?.slip ?? null); if (!c2) continue; slip = c2; }
    slips.push(slip);
    lines.push({ person: p.id, payType: slip.payType, pod: p.pod ?? null, department: p.department ?? null, exceptions: slip.exceptions, hold: slip.hold,
      settlementId: slip.settlementId, recover: correcting && (slip.difference ?? 0) < 0, sealed: sealValue(ring, slip, lineContext(v.org, p.id, runId)) });
  }
  const runExceptions = [...(inp.cutoffPassed ? [] : ["before_cutoff"]), ...(inp.attendanceEnabled ? [] : ["attendance_off"])];
  const calc = (await c.query("select pulse.pay_run_save($1,$2) n", [runId, { lines, runExceptions, totals: sealValue(ring, runTotals(slips), payrollContext(v.org, "totals", runId)) }])).rows[0].n as number;
  return { calc, people: lines.length };
}

/** A run's checked (or latest) calculation, opened: one payslip per person. */
async function slipsOf(c: PoolClient, ring: Keyring, org: string, runId: string, calc: number | null) {
  const rows = (await c.query("select person_id,kid,dkey,data from pulse.pay_run_lines($1,$2)", [runId, calc])).rows as Row[];
  return new Map(rows.map((r) => [r.person_id as string, openValue<Payslip>(ring, r, lineContext(org, r.person_id, runId))]));
}

export function registerPayrollRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: "object" } as const;

  // ------------------------------------------------------------------------------------------- the runs
  app.get("/api/v0/comp/payroll", (req) => tx(req, async (c, v) => {
    await need(c, "read");
    const d = (await c.query("select pulse.pay_runs() d")).rows[0].d as Row;
    d.payDay = (await c.query("select pulse.pay_settings_read() s")).rows[0].s.payDay;
    const ring = d.can.read && (d.runs as Row[]).length ? await requireKeyring("pay") : null;
    if (ring) for (const r of d.runs as Row[]) {
      if (!["locked", "checked", "draft"].includes(r.status) || !r.calc) continue;
      const t = (await c.query("select kid,dkey,data from pulse.pay_run_totals($1)", [r.id])).rows[0];
      r.totals = t ? openValue<Row>(ring, t, payrollContext(v.org, "totals", r.id)) : null;
    }
    return d;
  }));
  app.post<{ Body: Body }>("/api/v0/comp/payroll", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await need(c, "write", "HR starts payroll");
    const m = /^\d{4}-\d{2}$/.test(String(req.body?.month)) ? `${req.body.month}-01` : fail(400, "Choose the month");
    const runId = (await c.query("select pulse.pay_run_open($1,$2) id", [m, str(req.body?.note, 1000)])).rows[0].id as string;
    return { id: runId, ...(await computeRun(c, v, runId)) };
  }));
  app.get<{ Params: { id: string }; Querystring: { figures?: string; calc?: string } }>("/api/v0/comp/payroll/:id", (req) => tx(req, async (c, v) => {
    await need(c, "read");
    const run = (await c.query("select pulse.pay_run_get($1) d", [id(req.params.id, "Payroll run")])).rows[0].d as Row;
    run.runExceptions = [];
    const ev = (run.events as Row[]).find((e) => ["computed", "recomputed"].includes(e.kind));
    run.runExceptions = ((ev?.detail?.runExceptions ?? []) as string[]).map((k) => ({ key: k, text: RUN_EXCEPTIONS[k] ?? k }));
    if (!run.can.figures) return run;
    const ring = await requireKeyring("pay");
    const t = (await c.query("select kid,dkey,data from pulse.pay_run_totals($1)", [run.id])).rows[0];
    run.totals = t ? openValue<Row>(ring, t, payrollContext(v.org, "totals", run.id)) : null;
    if (req.query.figures === "1") {
      const calc = /^\d+$/.test(req.query.calc ?? "") ? Number(req.query.calc) : run.checkedCalc ?? run.calc;
      const slips = await slipsOf(c, ring, v.org, run.id, calc);
      for (const l of run.lines as Row[]) l.slip = slips.get(l.person) ?? null;
      run.figuresCalc = calc;
    }
    return run;
  }));
  app.post<{ Params: { id: string } }>("/api/v0/comp/payroll/:id/compute", (req) => tx(req, async (c, v) => {
    await need(c, "write", "HR calculates payroll");
    return computeRun(c, v, id(req.params.id, "Payroll run"));
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/payroll/:id/adjust", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await need(c, "write", "HR adjusts payroll");
    const runId = id(req.params.id, "Payroll run"), b = req.body ?? {}, kind = ["lop_days", "amount", "hold"].includes(String(b.kind)) ? String(b.kind) : fail(400, "Choose loss-of-pay days, an amount or a hold");
    const person = id(b.person, "Person"), reason = str(b.reason, 500);
    if (reason.length < 3) fail(400, "Say why");
    const p: Row = { person, kind, reason, id: randomUUID() };
    if (kind === "lop_days") { const d = Number(b.days); if (!Number.isFinite(d) || d < 0 || d > 31 || Math.round(d * 2) !== d * 2) fail(400, "Loss-of-pay days are 0 to 31, in half days"); p.days = d; }
    if (kind === "amount") {
      const n = Number(String(b.amount ?? "").replace(/,/g, ""));
      if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1e8) fail(400, "Give the amount (negative to deduct)");
      p.label = str(b.label, 80) || fail(400, "Name the line, as the payslip will show it");
      p.sealed = sealValue(await requireKeyring("pay"), { amount: Math.round(n * 100) }, payContext(v.org, person, "pay-adjustment", p.id));
    }
    await c.query("select pulse.pay_adjust($1,$2)", [runId, p]);
    return computeRun(c, v, runId);
  }));
  app.post<{ Params: { id: string } }>("/api/v0/comp/payroll/adjustments/:id/remove", (req) => tx(req, async (c, v) => {
    await need(c, "write", "HR adjusts payroll");
    const runId = (await c.query("select pulse.pay_adjust_remove($1) r", [id(req.params.id, "Adjustment")])).rows[0].r as string;
    return computeRun(c, v, runId);
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/payroll/:id/check", { schema: { body } }, (req) => tx(req, async (c) => {
    await need(c, "write", "HR checks payroll");
    return { status: (await c.query("select pulse.pay_run_check($1,$2,$3) s", [id(req.params.id, "Payroll run"), Number(req.body?.calc) || null, str(req.body?.note, 1000)])).rows[0].s };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/payroll/:id/return", { schema: { body } }, (req) => tx(req, async (c) => {
    await need(c, "writeOrApprove", "Founders and HR send payroll back");
    return { status: (await c.query("select pulse.pay_run_return($1,$2) s", [id(req.params.id, "Payroll run"), str(req.body?.note, 1000)])).rows[0].s };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/payroll/:id/withdraw", { schema: { body } }, (req) => tx(req, async (c) => {
    await need(c, "write", "HR withdraws payroll");
    return { status: (await c.query("select pulse.pay_run_withdraw($1,$2) s", [id(req.params.id, "Payroll run"), str(req.body?.note, 1000)])).rows[0].s };
  }));

  // Approve and lock: payslips drawn and filed, the bank file made, the ledger posted, one transaction.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/payroll/:id/approve", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await need(c, "approve", "The approver named in the pay policy approves payroll");
    const runId = id(req.params.id, "Payroll run");
    const chk = (await c.query("select pulse.pay_lock_check($1) d", [runId])).rows[0].d as Row;
    const ring = await requireKeyring("pay");
    const slips = [...(await slipsOf(c, ring, v.org, runId, chk.calc)).values()];
    const settings = (await c.query("select pulse.pay_settings_read() s", [])).rows[0].s as Row;
    const bank = new Map<string, Row>();
    for (const r of (await c.query("select person_id,key_id,data_key,sealed,status from pulse.pay_bank_sealed($1)", [runId])).rows as Row[]) {
      const a = JSON.parse(unseal(ring, { keyId: r.key_id, dataKey: r.data_key, data: r.sealed }, bankContext(v.org, r.person_id)).toString("utf8")) as Row;
      if (a.account && a.ifsc) bank.set(r.person_id, a);
    }
    const h = await letterhead(c), on = await today(c), f = await fonts(), month = String(chk.month).slice(0, 10), fy = financialYear(month).short;
    const payslips: Row[] = [];
    for (const s of slips) {
      const pid = randomUUID(), acct = bank.get(s.person.id), money = (p: number) => letterMoney(p);
      const letter = payslipLetter(s, { company: h.company.name, payOn: chk.payOn ?? null, bankLast4: acct ? String(acct.account).slice(-4) : null, version: 1, money });
      const model = buildLetterModel(h.design, { ...letter, date: on, reference: `PAYSLIP/${fy}/${month.slice(0, 7)}${chk.kind === "correction" ? `-R${chk.seq}` : ""}`,
        to: { name: s.person.name, lines: [s.person.role, s.person.pod].filter(Boolean) as string[] }, company: h.company, accepted: null, draft: false }, { logo: h.logo, signature: null });
      const pdf = await renderLetterPdf(model, { fonts: f });
      payslips.push({ id: pid, person: s.person.id, sealed: sealValue(ring, { slip: s, letter }, payContext(v.org, s.person.id, "payslip", pid)),
        pdf: sealBytes(ring, pdf.bytes, payContext(v.org, s.person.id, "payslip-pdf", pid)), sha256: sha(pdf.bytes), pages: pdf.pages });
    }
    // The bank file: everyone paid something, not held, with bank details; the rest are listed on the run's page.
    const toPay = slips.map((s) => ({ s, amount: Math.max(0, s.difference ?? s.net) })).filter((x) => x.amount > 0);
    const rows = toPay.filter((x) => !x.s.hold && bank.has(x.s.person.id)).map((x, i) => {
      const a = bank.get(x.s.person.id)!;
      return { name: String(a.holder || x.s.person.name), account: String(a.account), ifsc: String(a.ifsc), amount: x.amount, reference: `PAY${month.slice(0, 4)}${month.slice(5, 7)}${chk.kind === "correction" ? `R${chk.seq}` : ""}-${String(i + 1).padStart(3, "0")}` };
    });
    let payout: Row | null = null;
    if (rows.length) {
      const csv = Buffer.from(bankFile(settings.bankFormat, rows, { payOn: chk.payOn ?? on, narration: String(settings.narration).replace(/\{\{\s*month\s*\}\}/g, monthLabel(month).replace(/^(\w{3})\w*/, "$1")), debitAccount: settings.debitAccount }), "utf8");
      payout = { format: settings.bankFormat, rows: rows.length, leftOut: toPay.length - rows.length, sealed: sealBytes(ring, csv, payrollContext(v.org, "payout", runId)), sha256: sha(csv) };
    }
    const led = ledgerFor(slips.map((s) => ({ slip: s, pod: s.person.pod, department: s.person.department, paid: s.previous ?? null })));
    const entries = led.entries.map((e) => { const eid = randomUUID(); return { id: eid, account: e.account, side: e.side, pod: e.pod, department: e.department, people: e.people, sealed: sealValue(ring, { amount: e.amount }, payrollContext(v.org, "ledger", eid)) }; });
    const totals = led.totals.map((t) => ({ account: t.account, side: t.side, people: t.people, sealed: sealValue(ring, { amount: t.amount }, payrollContext(v.org, "ledger-total", `${runId}/${t.account}`)) }));
    const paid = { items: [...new Set(slips.flatMap((s) => s.items))], claims: [...new Set(slips.flatMap((s) => s.claims))], carries: [...new Set(slips.flatMap((s) => s.carries))] };
    const status = (await c.query("select pulse.pay_run_lock($1,$2) s", [runId, { payslips, payout, ledger: { entries, totals }, paid, note: str(req.body?.note, 1000) }])).rows[0].s;
    return { status, payslips: payslips.length, payout: payout ? { rows: payout.rows, leftOut: payout.leftOut } : null };
  }));

  // The bank file, for the approver or HR to upload in the bank's portal (each download logged).
  app.get<{ Params: { id: string } }>("/api/v0/comp/payroll/:id/bank-file", async (req, reply) => {
    const out = await tx(req, async (c, v) => {
      await need(c, "writeOrApprove", "The bank file is for founders and HR");
      const runId = id(req.params.id, "Payroll run");
      const r = (await c.query("select month::text,seq,format,kid,dkey,data from pulse.pay_payout_sealed($1)", [runId])).rows[0];
      return { name: `payroll-${String(r.month).slice(0, 7)}${r.seq > 1 ? `-${r.seq}` : ""}-${r.format}.csv`, bytes: openBytes(await requireKeyring("pay"), r, payrollContext(v.org, "payout", runId)) };
    });
    reply.header("cache-control", "private, no-store").header("content-disposition", `attachment; filename="${out.name}"`);
    return reply.type("text/csv; charset=utf-8").send(out.bytes);
  });

  // ----------------------------------------------------------------------------------------------- payslips
  app.get<{ Params: { id: string } }>("/api/v0/comp/payslips/:id/pdf", async (req, reply) => {
    const out = await tx(req, async (c, v) => {
      if (!v.person) fail(403, "Sign in as a person to see payslips");
      const pid = id(req.params.id, "Payslip");
      const r = (await c.query("select person_id,month::text,version,kid,dkey,data from pulse.pay_payslip_sealed($1,'pdf')", [pid])).rows[0];
      return { name: `payslip-${String(r.month).slice(0, 7)}${r.version > 1 ? `-v${r.version}` : ""}.pdf`, bytes: openBytes(await requireKeyring("pay"), r, payContext(v.org, r.person_id, "payslip-pdf", pid)) };
    });
    reply.header("cache-control", "private, no-store").header("content-disposition", `inline; filename="${out.name}"`);
    return reply.type("application/pdf").send(out.bytes);
  });
  app.get<{ Params: { id: string } }>("/api/v0/comp/payslips/:id", (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, "Sign in as a person to see payslips");
    const pid = id(req.params.id, "Payslip");
    const r = (await c.query("select person_id,month::text,version,kid,dkey,data from pulse.pay_payslip_sealed($1,'content')", [pid])).rows[0];
    const s = openValue<Row>(await requireKeyring("pay"), r, payContext(v.org, r.person_id, "payslip", pid));
    return { id: pid, month: r.month, version: r.version, slip: { ...s.slip, previous: undefined } };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/comp/people/:id/payslips", (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, "Sign in as a person to see payslips");
    return { payslips: (await c.query("select pulse.pay_payslips($1) l", [id(req.params.id, "Person")])).rows[0].l };
  }));

  // ----------------------------------------------------------------------------------------------- settings
  app.get("/api/v0/comp/payroll/settings", (req) => tx(req, async (c) => { await need(c, "read"); return (await c.query("select pulse.pay_settings_read() s")).rows[0].s; }));
  app.post<{ Body: Body }>("/api/v0/comp/payroll/settings", { schema: { body } }, (req) => tx(req, async (c) => {
    await need(c, "write", "HR sets up payroll");
    const b = req.body ?? {}, p: Row = {};
    if (b.statutory && typeof b.statutory === "object") {
      const s = b.statutory as Row, out: Row = {};
      const num = (x: unknown, lo: number, hi: number, what: string) => { const n = Number(x); return Number.isFinite(n) && n >= lo && n <= hi ? n : fail(400, `Check ${what}`); };
      if (s.pf) out.pf = { on: s.pf.on === true, employeePct: num(s.pf.employeePct ?? 12, 0, 25, "the PF rate"), employerPct: num(s.pf.employerPct ?? 12, 0, 25, "the PF rate"),
        wageCap: Math.round(num(s.pf.wageCap ?? 15000, 0, 1e7, "the PF wage ceiling") * 100), capped: s.pf.capped !== false };
      if (s.esi) out.esi = { on: s.esi.on === true, employeePct: num(s.esi.employeePct ?? 0.75, 0, 10, "the ESI rate"), employerPct: num(s.esi.employerPct ?? 3.25, 0, 10, "the ESI rate"),
        grossLimit: Math.round(num(s.esi.grossLimit ?? 21000, 0, 1e7, "the ESI limit") * 100) };
      if (s.pt) out.pt = { on: s.pt.on === true, state: s.pt.state === "other" ? "other" : "MH" };
      if (s.tds) out.tds = { on: s.tds.on === true, contractorPct: num(s.tds.contractorPct ?? 10, 0, 30, "the TDS rate on fees") };
      p.statutory = out;
    }
    if (b.attendance && typeof b.attendance === "object") {
      const a = b.attendance as Row;
      p.attendance = { unpaidLeave: a.unpaidLeave === "none" ? "none" : "pay", halfDays: a.halfDays === "pay" ? "pay" : "none", lateMarks: a.lateMarks === "pay" ? "pay" : "leave", absent: a.absent === "pay" ? "pay" : "none" };
    }
    if (b.payDay !== undefined) { const d = Number(b.payDay); if (!Number.isInteger(d) || d < 1 || d > 28) fail(400, "The pay day is a day from 1 to 28"); p.payDay = d; }
    if (b.bankFormat !== undefined) p.bankFormat = b.bankFormat === "generic" ? "generic" : "axis";
    if (b.debitAccount !== undefined) { const a = String(b.debitAccount ?? "").replace(/\s/g, ""); if (a && !/^\d{6,20}$/.test(a)) fail(400, "The company account number is 6 to 20 digits"); p.debitAccount = a; }
    if (b.narration !== undefined) p.narration = str(b.narration, 60);
    // TDS slabs and limits are the year's law: kept from the template, merged part by part.
    if (p.statutory?.tds) { const cur = (await c.query("select pulse.pay_settings_read() s")).rows[0].s.statutory.tds as Row; p.statutory.tds = { ...cur, ...p.statutory.tds }; }
    return (await c.query("select pulse.pay_settings_save($1) s", [p])).rows[0].s;
  }));

  // ---------------------------------------------------------------------------------------------- ledger
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/v0/comp/ledger", (req) => tx(req, async (c, v) => {
    await need(c, "read", "The people-cost ledger is for founders and HR");
    const from = isDay(`${req.query.from}-01`) ? `${req.query.from}-01` : null, to = isDay(`${req.query.to}-01`) ? `${req.query.to}-01` : null;
    const rows = (await c.query("select id,run_id,month::text,kind,account,side,pod,department,people,kid,dkey,data from pulse.pay_ledger($1,$2)", [from, to])).rows as Row[];
    const ring = rows.length ? await requireKeyring("pay") : null;
    return { entries: rows.map((r) => ({ runId: r.run_id, month: String(r.month).slice(0, 7), kind: r.kind, account: r.account, side: r.side, pod: r.pod, department: r.department, people: r.people,
      amount: openValue<{ amount: number }>(ring!, r, payrollContext(v.org, "ledger", r.id)).amount })) };
  }));
}

/** Monthly totals by account from locked payroll (founders, HR and the Accountant): the CA desk's payroll register. */
export async function ledgerTotals(c: PoolClient, org: string) {
  await c.query("savepoint pay_totals");
  try {
    const rows = (await c.query("select run_id,month::text,kind,account,side,people,kid,dkey,data from pulse.pay_ledger_totals(null,null)")).rows as Row[];
    await c.query("release savepoint pay_totals");
    if (!rows.length) return [];
    const ring = await ringOrNull();
    if (!ring) return null; // no keyring: the desk keeps the workbook totals
    return rows.map((r) => ({ runId: r.run_id as string, month: String(r.month).slice(0, 7), kind: r.kind as string, account: r.account as string, side: r.side as string, people: r.people as number,
      amount: openValue<{ amount: number }>(ring, r, payrollContext(org, "ledger-total", `${r.run_id}/${r.account}`)).amount }));
  } catch (e) {
    await c.query("rollback to savepoint pay_totals");
    if ((e as { code?: string }).code === "42501") return null;
    throw e;
  }
}
