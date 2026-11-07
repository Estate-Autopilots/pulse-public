// FINANCE-TRUTH (owner, 4 Nov 2026; Kazuk: "the finance dashboard is wrong because GST is paid into a separate
// account"): Finance → Numbers and a salesperson's own numbers. The database works out each month's parts and who may
// see them (db/migrations/1480_finance_truth.sql); the payroll keyring stays in the API, so HR cost from locked payroll
// is added here (ledgerTotals: null when the viewer may not read pay, and the page says the Cash book was used).
//   GET  /api/v0/finance/numbers?period=month|last|quarter|fy|lastfy (or from=YYYY-MM&to=YYYY-MM)
//   POST /api/v0/finance/numbers/gst-account { account }      leadership names the GST account (one of the Cash book's)
//   POST /api/v0/erp/payments/:id/account { account }         which account a recorded payment arrived in (Billing writers)
//   GET  /api/v0/sales-numbers?person=&period=                the viewer's own; leadership and Finance may pick anyone
import type { FastifyInstance } from "fastify";
import { fail, work, type Tx } from "./routes.js";
import { orgZone, zoneDay } from "./org-time.js";
import { ledgerTotals } from "./payroll.js";
import { buildNumbers, payrollMonths, periodRange, type NumbersRaw } from "./finance-truth-model.js";

type Q = { period?: string; from?: string; to?: string; person?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const account = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 80) : x === null || x === undefined ? "" : fail(400, "Choose an account"));

export function registerFinanceTruthRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: Q }>("/api/v0/finance/numbers", (req) => tx(req, async (c, v) => {
    const today = zoneDay(await orgZone(c)), p = periodRange(req.query.period, today, req.query.from, req.query.to);
    const raw = (await c.query("select pulse.finance_numbers($1,$2) n", [`${p.from}-01`, `${p.to}-01`])).rows[0].n as NumbersRaw;
    const payroll = payrollMonths(await ledgerTotals(c, v.org));
    return { period: p.period, ...buildNumbers(raw, payroll) };
  }));
  app.post<{ Body: { account?: unknown } }>("/api/v0/finance/numbers/gst-account", (req) => tx(req, async (c) => {
    return { gstAccount: (await c.query("select pulse.finance_gst_account_set($1) a", [account(req.body?.account) || null])).rows[0].a };
  }));
  app.post<{ Params: { id: string }; Body: { account?: unknown } }>("/api/v0/erp/payments/:id/account", (req) => tx(req, async (c) => {
    if (!UUID.test(req.params.id)) fail(400, "Choose a payment");
    await c.query("select pulse.erp_payment_account($1,$2)", [req.params.id, account(req.body?.account) || null]);
    return { ok: true };
  }));
  app.get<{ Querystring: Q }>("/api/v0/sales-numbers", (req) => tx(req, async (c, v) => {
    work(v);
    if (!v.person || v.role === "accountant") fail(403, "Sales numbers belong to a staff person");
    const person = req.query.person ? (UUID.test(req.query.person) ? req.query.person : fail(400, "Choose a person")) : null;
    const today = zoneDay(await orgZone(c)), p = periodRange(req.query.period ?? "month", today, req.query.from, req.query.to);
    const data = (await c.query("select pulse.sales_numbers($1,$2,$3) s", [person, `${p.from}-01`, `${p.to}-01`])).rows[0].s as Record<string, unknown>;
    return { period: p.period, ...data };
  }));
}
