// COMP-A (owner, 13 Oct 2026): people's pay from offer to exit. The database decides who may read or decide what and
// logs every read (0440_comp_pay.sql); this module seals and opens the amounts with the document keyring (they never
// reach PostgreSQL in plaintext), works out previews, statements and a month's pay (comp-model.ts), and draws the letters
// with @pulse/invoice-doc's letter writer. docs/ops/COMP.md describes the model. Pulse e-mails nobody: an offer's link is
// shown once to the founder who sends it.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { buildLetterModel, financialYear, FONT_URLS, letterContent, renderLetterDocx, renderLetterPdf, toPaise, type Asset, type Fonts } from "@pulse/invoice-doc";
import { loadKeyring, open as unseal, payContext, requireKeyring, seal, type Keyring } from "./document-keys.js";
import { addDays, budgetImpact, componentRows, isDay, monthEnd, monthlyCost, monthPay, monthStart, nextEvent, normaliseFigures, PAY_TYPES, previewChange, primaryAction, recoverySchedule,
  settlement, setupPlan, type BudgetLine, type Component, type Figures, type PayType, type PeopleRow } from "./comp-model.js";
import { fail, type Open, type Tx, type Viewer } from "./routes.js";
import { companyOrigin } from "./tenant-context.js";

type Body = Record<string, unknown>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Sealed = { kid: string; key: string; data: string };
export type Who = { reader: boolean; writer: boolean; approver: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (v: unknown, what: string) => (typeof v === "string" && UUID.test(v) ? v : fail(404, `${what} not found`));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const day = (v: unknown, what: string) => (isDay(v) ? v : fail(400, `Give ${what}`));
/** Rupees as people type them ("40,000", 40000, "40000.50") to paise; null when empty. */
const money = (v: unknown, what: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const p = toPaise(typeof v === "number" ? v.toFixed(2) : String(v));
  return p === null || p < 0 ? fail(400, `${what} is not an amount`) : p;
};
export const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let fontsLoading: Promise<Fonts> | null = null;
export const fonts = () => (fontsLoading ??= Promise.all([readFile(FONT_URLS.regular), readFile(FONT_URLS.semibold)]).then(([regular, semibold]) => ({ regular, semibold })));

// --------------------------------------------------------------------------------------------- sealing
export const sealValue = (ring: Keyring, value: unknown, context: string): Sealed => {
  const s = seal(ring, Buffer.from(JSON.stringify(value), "utf8"), context);
  return { kid: s.keyId, key: s.dataKey.toString("base64"), data: s.data.toString("base64") };
};
export const sealBytes = (ring: Keyring, bytes: Uint8Array, context: string): Sealed => {
  const s = seal(ring, Buffer.from(bytes), context);
  return { kid: s.keyId, key: s.dataKey.toString("base64"), data: s.data.toString("base64") };
};
export const openBytes = (ring: Keyring, r: Row, context: string) => unseal(ring, { keyId: r.kid, dataKey: r.dkey, data: r.data }, context);
export const openValue = <T>(ring: Keyring, r: Row, context: string): T => JSON.parse(openBytes(ring, r, context).toString("utf8")) as T;
/** The keyring if it is installed (reads show "figures hidden" without one), or null. */
export const ringOrNull = async () => { const s = await loadKeyring(); return s.ok ? s.ring : null; };
/** A per-company key for duplicate bills: from the keyring's oldest key, so it survives rotation while that key is kept. */
const dupKey = (ring: Keyring, org: string, text: string) => createHmac("sha256", createHmac("sha256", [...ring.keys.values()][0]).update(`pulse.comp.dup.v1|${org}`).digest()).update(text).digest("hex");

/** COMP-B's running budget, called by the Change pay and offer previews (people-cost.ts sets it; null before). */
type BudgetHook = (c: PoolClient, v: Viewer, ring: Keyring, pod: string | null, from: string, extra: number) => Promise<BudgetLine>;
let budgetHook: BudgetHook | null = null;
export const setBudgetHook = (h: BudgetHook) => { budgetHook = h; };
const budgetLine = async (c: PoolClient, v: Viewer, ring: Keyring, pod: string | null, from: string, extra: number) => {
  if (!budgetHook) return budgetImpact();
  await c.query("savepoint comp_budget");
  try { const out = await budgetHook(c, v, ring, pod, from, extra); await c.query("release savepoint comp_budget"); return out; }
  catch { await c.query("rollback to savepoint comp_budget"); return budgetImpact(); }
};

// ------------------------------------------------------------------------------------------- reading
export const who = async (c: PoolClient) => (await c.query("select pulse.comp_reader() reader,pulse.comp_writer() writer,pulse.comp_is_approver() approver")).rows[0] as Who;
export const today = async (c: PoolClient) => (await c.query("select pulse.lifecycle_today()::text d")).rows[0].d as string;
const policy = async (c: PoolClient) => (await c.query("select pulse.comp_policy_read() p")).rows[0].p as Row;
const person = async (c: PoolClient, pid: string) => (await c.query("select pulse.comp_person($1) p", [pid])).rows[0].p as Row;
const template = (pol: Row) => (Array.isArray(pol.components) ? pol.components : []) as Component[];

/** A person's sealed history opened: change id → figures, item id → amount, claim id → amount. */
async function history(c: PoolClient, ring: Keyring | null, org: string, pid: string) {
  const figures = new Map<string, Figures>(), amounts = new Map<string, number>();
  if (!ring) return { figures, amounts, sealed: true };
  for (const r of (await c.query("select kind,id,kid,dkey,data from pulse.comp_history_sealed($1)", [pid])).rows) {
    if (r.kind === "change") figures.set(r.id, openValue<Figures>(ring, r, payContext(org, pid, "change", r.id)));
    else amounts.set(r.id, openValue<{ amount: number }>(ring, r, payContext(org, pid, r.kind, r.id)).amount);
  }
  return { figures, amounts, sealed: false };
}
/** The version in force on a day among a person's versions (approved; the latest date, then the later decision). */
function inForceOn(versions: Row[], on: string, except?: string | null) {
  return versions.filter((v) => v.status === "approved" && v.effectiveOn <= on && v.id !== except)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || String(b.decidedAt ?? "").localeCompare(String(a.decidedAt ?? "")))[0] ?? null;
}

// ------------------------------------------------------------------------------------------- letters
const LETTER_REF: Record<string, string> = { offer: "OFFER", revision: "PAY", promotion: "PROMO", role_change: "ROLE", correction: "PAY", start: "PAY", probation_confirm: "CONF",
  probation_extend: "PROB", probation_end: "EXIT", pause: "PAUSE", settlement: "FNF" };
const CHANGE_LETTER: Record<string, string> = { raise: "revision", cut: "revision", correction: "correction", promotion: "promotion", role_change: "role_change", start: "start" };
export async function letterhead(c: PoolClient) {
  const h = (await c.query("select pulse.comp_letterhead() h")).rows[0].h as Row;
  const asset = async (kind: string): Promise<Asset | null> => {
    const r = (await c.query("select bytes,mime from pulse.comp_letter_asset($1)", [kind])).rows[0];
    return r ? { bytes: new Uint8Array(r.bytes as Buffer), mime: String(r.mime) } : null;
  };
  return { design: h.design as Row, company: h.company as { name: string; lines: string[] }, letters: (h.letters ?? {}) as Row, logo: h.logo ? await asset("logo") : null, signature: h.signature ? await asset("signature") : null };
}
/** Draws a letter and files it (sealed content and PDF) against its decided subject. */
async function fileLetter(c: PoolClient, ring: Keyring, org: string, p: { person: Row; kind: string; subjectType: string; subjectId: string; data: Row }) {
  const h = await letterhead(c);
  const content = letterContent(p.kind, { ...p.data, company: h.company.name }, h.letters);
  const on = await today(c), lid = randomUUID();
  const letter = { ...content, kind: p.kind, date: on, reference: `${LETTER_REF[p.kind] ?? "PAY"}/${financialYear(on).short}/${lid.slice(0, 6).toUpperCase()}`,
    to: { name: p.person.name, lines: [p.data.role ?? p.person.role, p.person.pod].filter(Boolean) }, company: h.company, accepted: null, draft: false };
  const pdf = await renderLetterPdf(buildLetterModel(h.design, letter, { logo: h.logo, signature: h.signature }), { fonts: await fonts() });
  await c.query("select pulse.comp_letter_add($1)", [{ id: lid, subjectType: p.subjectType, subjectId: p.subjectId, kind: p.kind, title: content.title,
    sealed: sealValue(ring, { letter, design: h.design }, payContext(org, p.person.id, "letter", lid)), pdf: sealBytes(ring, pdf.bytes, payContext(org, p.person.id, "letter-pdf", lid)),
    sha256: sha(pdf.bytes), pages: pdf.pages }]);
  return lid;
}
const pp = (r: Row) => ({ id: r.person.id, name: r.person.name, role: r.person.role, pod: r.person.pod });

/** What a change's letter says (the before figures for a revision, the components for a salary). */
function changeLetter(r: Row, c: Row, figures: Figures, before: Figures | null, pol: Row, previousRole?: string | null) {
  return { name: r.person.name, role: c.role ?? r.person.role, previousRole: previousRole ?? r.person.role, payType: c.payType, currency: r.record?.currency ?? pol.currency,
    monthly: figures.monthly, yearly: figures.ctc, rate: figures.rate, hours: figures.hours, previousMonthly: c.kind === "start" ? null : before?.monthly ?? null,
    effective: c.effectiveOn, reason: c.reason ?? "", components: componentRows(figures, template(pol)).filter((x) => x.kind === "earning") };
}
function offerLetter(r: Row, o: Row, figures: Figures, pol: Row) {
  return { name: r.person.name, role: o.role, payType: o.payType, currency: r.record?.currency ?? pol.currency, monthly: figures.monthly, yearly: figures.ctc, rate: figures.rate,
    hours: figures.hours, start: o.startOn, validUntil: o.validUntil, probationDays: o.probationDays, probationEnd: o.probationDays ? addDays(o.startOn, o.probationDays - 1) : null,
    noticeProbation: o.noticeDays ?? r.policy.noticeProbation, noticeConfirmed: r.policy.noticeConfirmed, terms: o.terms ?? "",
    components: componentRows(figures, template(pol)).filter((x) => x.kind === "earning") };
}

// ---------------------------------------------------------------------------------------- the routes
export function registerCompRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const body = { type: "object" } as const;
  const guard = async (c: PoolClient, need: keyof Who | "any", what = "Pay is for founders and HR") => {
    const w = await who(c);
    if (need !== "any" && !w[need]) fail(403, what);
    return w;
  };

  // The People & pay table: status, next event and one action per row; figures only when asked (each logged).
  app.get<{ Querystring: { figures?: string } }>("/api/v0/comp/people", (req) => tx(req, async (c, v) => {
    const d = (await c.query("select pulse.comp_people() d")).rows[0].d as Row;
    const on = d.today as string, view = { me: v.person ?? "", writer: !!d.writer, approver: !!d.approver };
    const rows: Row[] = (d.people as Row[]).map((r) => { const e = nextEvent(r as PeopleRow, on, view); return { ...r, next: e, action: primaryAction(r as PeopleRow, e, view) }; });
    let figuresHidden = true;
    if (req.query.figures === "1" && d.reader) {
      const ring = await requireKeyring("pay");
      const ids = rows.filter((r) => r.hasRecord).map((r) => r.id);
      const got = new Map<string, Row>();
      for (const f of (await c.query("select person_id,change_id,pay_type,kid,dkey,data from pulse.comp_figures($1::uuid[],null)", [ids])).rows) {
        const fig = openValue<Figures>(ring, f, payContext(v.org, f.person_id, "change", f.change_id));
        got.set(f.person_id, { monthly: fig.monthly, ctc: fig.ctc, rate: fig.rate ?? null, payType: f.pay_type });
      }
      for (const r of rows) r.pay = got.get(r.id) ?? null;
      figuresHidden = false;
    }
    return { today: on, people: rows, figuresHidden, can: { read: !!d.reader, write: !!d.writer, approve: !!d.approver }, policy: d.policy };
  }));

  // One person's pay: record, versions with their figures and the figures before each, offer, probation, pauses, items,
  // claims, the full and final, letters and the timeline. Readers, the person, or a manager (status only).
  app.get<{ Params: { id: string } }>("/api/v0/comp/people/:id", (req) => tx(req, async (c, v) => {
    const pid = id(req.params.id, "Person");
    const r = await person(c, pid);
    const ring = (r.can.read || r.can.self) && !r.can.manager ? await ringOrNull() : null;
    const h = (r.can.read || r.can.self) ? await history(c, ring, v.org, pid) : { figures: new Map(), amounts: new Map(), sealed: true };
    const versions = (r.versions ?? []) as Row[];
    for (const x of versions) {
      x.figures = h.figures.get(x.id) ?? null;
      const before = x.correctsId ? versions.find((y) => y.id === x.correctsId) : x.beforeId ? versions.find((y) => y.id === x.beforeId) : null;
      x.before = before ? h.figures.get(before.id) ?? null : null;
      if (x.figures) x.components = componentRows(x.figures, template(r.policy));
    }
    for (const o of (r.offers ?? []) as Row[]) { o.figures = h.figures.get(o.changeId) ?? null; if (o.figures) o.components = componentRows(o.figures, template(r.policy)); }
    for (const i of (r.items ?? []) as Row[]) {
      i.amount = h.amounts.get(i.id) ?? null;
      if (i.amount !== null && i.recoverMonths) i.schedule = recoverySchedule(i.amount, i.recoverMonths, i.recoverFrom);
    }
    for (const k of (r.claims ?? []) as Row[]) k.amount = h.amounts.get(k.id) ?? null;
    const inForce = versions.find((x) => x.inForce) ?? null;
    return { ...r, inForce: inForce ? { id: inForce.id, payType: inForce.payType, figures: inForce.figures, effectiveOn: inForce.effectiveOn, components: inForce.components } : null,
      figuresSealed: h.sealed || !ring, keyring: !!(await ringOrNull()), me: v.person };
  }));
  app.get("/api/v0/comp/me", (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, "Sign in as a person to see your pay");
    const r = (await c.query("select pulse.comp_me() p")).rows[0].p as Row;
    const ring = await ringOrNull();
    const h = await history(c, ring, v.org, v.person!);
    const versions = (r.versions ?? []) as Row[];
    for (const x of versions) { x.figures = h.figures.get(x.id) ?? null; if (x.figures) x.components = componentRows(x.figures, template(r.policy)); }
    for (const o of (r.offers ?? []) as Row[]) { o.figures = h.figures.get(o.changeId) ?? null; if (o.figures) o.components = componentRows(o.figures, template(r.policy)); }
    for (const i of (r.items ?? []) as Row[]) i.amount = h.amounts.get(i.id) ?? null;
    for (const k of (r.claims ?? []) as Row[]) k.amount = h.amounts.get(k.id) ?? null;
    const inForce = versions.find((x) => x.inForce) ?? null;
    return { ...r, inForce: inForce ? { payType: inForce.payType, figures: inForce.figures, effectiveOn: inForce.effectiveOn, components: inForce.components } : null, keyring: !!ring };
  }));

  // ------------------------------------------------------------------------------------------- policy
  app.get("/api/v0/comp/policy", (req) => tx(req, async (c) => policy(c)));
  app.post<{ Body: Body }>("/api/v0/comp/policy", { schema: { body } }, (req) => tx(req, async (c) => {
    await guard(c, "writer", "HR and founders set the pay policy");
    const b = req.body ?? {}, p: Body = {};
    for (const k of ["approvers", "probationApproval", "managers", "dayBasis", "encashBasis", "currency"]) if (typeof b[k] === "string") p[k] = b[k];
    for (const k of ["probationDays", "remindDays", "offerDays", "encashDivisor", "recoverMax"]) if (b[k] !== undefined && b[k] !== "") p[k] = Number(b[k]);
    for (const k of ["noticeProbation", "noticeConfirmed"]) if (k in b) p[k] = b[k] === "" || b[k] === null ? "" : Number(b[k]);
    if ("claimThreshold" in b) p.claimThreshold = b.claimThreshold === "" || b.claimThreshold === null ? "" : Number(b.claimThreshold);
    if (Array.isArray(b.components)) p.components = b.components;
    if (Array.isArray(b.claimCategories)) p.claimCategories = (b.claimCategories as Row[]).map((x) => ({ key: x.key, label: x.label, ...(x.cap ? { cap: Number(x.cap) } : {}) }));
    if (b.letters && typeof b.letters === "object") p.letters = Object.fromEntries(Object.entries(b.letters as Row).map(([k, x]) => [k, { title: str(x?.title, 120), body: str(x?.body, 6000) }])
      .filter(([, x]) => (x as Row).title || (x as Row).body));
    return (await c.query("select pulse.comp_policy_save($1) p", [p])).rows[0].p;
  }));
  // The letterhead for the browser's live preview (the same design, company and images the API draws with).
  app.get("/api/v0/comp/letterhead", (req) => tx(req, async (c) => {
    const h = (await c.query("select pulse.comp_letterhead() h")).rows[0].h as Row;
    return { design: h.design, company: h.company, letters: h.letters, logo: h.logo ? "/api/v0/comp/letterhead/logo" : null, signature: h.signature ? "/api/v0/comp/letterhead/signature" : null };
  }));
  for (const kind of ["logo", "signature"] as const) {
    app.get(`/api/v0/comp/letterhead/${kind}`, async (req, reply) => {
      const r = await tx(req, async (c) => (await c.query("select bytes,mime from pulse.comp_letter_asset($1)", [kind])).rows[0]);
      if (!r) fail(404, "No image");
      reply.header("cache-control", "private, max-age=300");
      return reply.type(String(r.mime)).send(r.bytes);
    });
  }

  // ------------------------------------------------------------------------------------- change pay
  /** Before and after, the cost a month and for the rest of the year, arrears, and what the letter will say. */
  async function preview(c: PoolClient, v: Viewer, b: Body) {
    const pid = id(b.person, "Person"), kind = String(b.kind ?? "raise");
    const r = await person(c, pid), ring = await requireKeyring("pay");
    const payType = (PAY_TYPES as readonly string[]).includes(String(b.payType)) ? (b.payType as PayType) : fail(400, "Choose the pay type");
    const on = day(b.effectiveOn, "the date it takes effect"), now = await today(c);
    const f = b.figures && typeof b.figures === "object" ? (b.figures as Body) : {};
    const after = normaliseFigures({ monthly: money(f.monthly, "The pay a month"), ctc: money(f.ctc, "The yearly CTC"), rate: money(f.rate, "The hourly rate"), hours: f.hours,
      components: f.components && typeof f.components === "object" ? Object.fromEntries(Object.entries(f.components as Body).map(([k, x]) => [k, money(x, k)]).filter(([, x]) => x !== null)) : undefined },
    payType, template(r.policy));
    const h = await history(c, ring, v.org, pid), versions = (r.versions ?? []) as Row[];
    const corrected = kind === "correction" ? versions.find((x) => x.id === b.correctsId && x.status === "approved") ?? fail(400, "Choose the version this corrects") : null;
    const beforeRow = corrected ?? inForceOn(versions, on);
    const before = beforeRow ? h.figures.get(beforeRow.id) ?? null : null;
    if (kind === "raise" && before && after.monthly <= before.monthly) fail(400, "A raise is more than the pay before it: choose a cut or a correction");
    if (kind === "cut" && before && after.monthly >= before.monthly) fail(400, "A cut is less than the pay before it");
    if (["raise", "cut", "promotion", "role_change", "correction"].includes(kind) && !beforeRow) fail(400, "Set up this person's pay first");
    const effective = corrected ? corrected.effectiveOn : on;
    const view = previewChange(before, after, effective, now);
    view.budget = await budgetLine(c, v, ring, r.person.pod ?? null, effective < now ? now : effective, view.after.cost - (view.before?.cost ?? 0));
    const letterKind = CHANGE_LETTER[kind] ?? "revision";
    return { pid, r, payType, figures: after, before, beforeId: beforeRow?.id ?? null, effective, preview: view, components: componentRows(after, template(r.policy)),
      letter: { kind: letterKind, data: changeLetter(r, { kind, role: str(b.role, 120) || null, payType, effectiveOn: effective, reason: str(b.reason, 1000) }, after, before, r.policy) } };
  }
  app.post<{ Body: Body }>("/api/v0/comp/preview", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR proposes pay changes");
    const p = await preview(c, v, req.body ?? {});
    return { figures: p.figures, before: p.before, effectiveOn: p.effective, preview: p.preview, components: p.components, letter: p.letter };
  }));
  app.post<{ Body: Body }>("/api/v0/comp/changes", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR proposes pay changes");
    const b = req.body ?? {}, p = await preview(c, v, b), ring = await requireKeyring("pay");
    const cid = typeof b.id === "string" && UUID.test(b.id) ? b.id : randomUUID();
    const saved = (await c.query("select pulse.comp_change_save($1) id", [{ id: cid, person: p.pid, kind: b.kind, effectiveOn: p.effective, payType: p.payType, role: str(b.role, 120),
      jobId: typeof b.jobId === "string" && UUID.test(b.jobId) ? b.jobId : null, reason: str(b.reason, 1000), correctsId: b.correctsId ?? null, submit: b.submit !== false,
      sealed: sealValue(ring, p.figures, payContext(v.org, p.pid, "change", cid)) }])).rows[0].id;
    return { id: saved, preview: p.preview };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/changes/:id/decide", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "approver", "The approver named in the pay policy decides pay changes");
    const cid = id(req.params.id, "Change");
    const action = ["approve", "reject", "return"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Approve, reject or send back");
    const d = (await c.query("select pulse.comp_change_decide($1,$2,$3) d", [cid, action, str(req.body?.note, 1000)])).rows[0].d as Row;
    if (d.status !== "approved") return d;
    const ring = await requireKeyring("pay"), r = await person(c, d.person), h = await history(c, ring, v.org, d.person);
    const ch = (r.versions as Row[]).find((x) => x.id === cid)!, figures = h.figures.get(cid)!;
    const beforeRow = ch.correctsId ? (r.versions as Row[]).find((x) => x.id === ch.correctsId) : ch.beforeId ? (r.versions as Row[]).find((x) => x.id === ch.beforeId) : null;
    const before = beforeRow ? h.figures.get(beforeRow.id) ?? null : null;
    let arrearsId: string | null = null;
    if (d.backdated && before && figures.monthly !== before.monthly) {
      const owed = previewChange(before, figures, ch.effectiveOn, await today(c)).arrears;
      if (owed.amount > 0) {
        const iid = randomUUID();
        arrearsId = (await c.query("select pulse.comp_arrears_add($1,$2) id", [cid, { id: iid, months: owed.months, sealed: sealValue(ring, { amount: owed.amount }, payContext(v.org, d.person, "item", iid)) }])).rows[0].id;
      }
    }
    const letterId = await fileLetter(c, ring, v.org, { person: pp(r), kind: CHANGE_LETTER[ch.kind] ?? "revision", subjectType: "change", subjectId: cid,
      data: changeLetter(r, ch, figures, before, r.policy, beforeRow?.role ?? null) });
    return { ...d, letterId, arrearsId };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/comp/changes/:id/withdraw", (req) => tx(req, async (c) => {
    await guard(c, "writer", "HR withdraws pay changes");
    await c.query("select pulse.comp_change_withdraw($1)", [id(req.params.id, "Change")]);
    return { ok: true };
  }));

  // "Set up from salary records": the latest settled figure becomes the first version; a proposed one becomes an offer
  // draft for founders to review (Savuzo's case).
  app.post<{ Params: { id: string } }>("/api/v0/comp/people/:id/setup", (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR sets up pay records");
    const pid = id(req.params.id, "Person"), r = await person(c, pid);
    const rows = (await c.query("select pulse.hr_salary_components_read($1) r", [pid])).rows[0].r as Row[];
    const plan = setupPlan(rows);
    if (!plan.start && !plan.offer) fail(400, "There is no salary record to set up from: enter the pay with Change pay");
    const ring = await requireKeyring("pay");
    let startId: string | null = null, offerId: string | null = null;
    if (plan.start && !(r.versions as Row[]).some((x) => x.status === "approved")) {
      startId = randomUUID();
      const fig = normaliseFigures({ monthly: plan.start.amount }, plan.start.payType, template(r.policy));
      await c.query("select pulse.comp_setup_start($1)", [{ id: startId, person: pid, importRef: plan.start.id, effectiveOn: plan.start.on, payType: plan.start.payType,
        sealed: sealValue(ring, fig, payContext(v.org, pid, "change", startId)) }]);
    }
    if (plan.offer && !(r.offers as Row[]).some((o) => ["draft", "proposed", "approved", "sent", "accepted"].includes(o.status))) {
      const fig = normaliseFigures({ monthly: plan.offer.amount }, "salary", template(r.policy)), changeId = randomUUID();
      offerId = (await c.query("select pulse.comp_offer_save($1) id", [{ person: pid, changeId, role: String(r.person.role ?? "").replace(/\s*\(proposed\)\s*$/i, "") || "Role to confirm",
        startOn: plan.offer.on, payType: "salary", terms: plan.offer.note ?? "", reason: `From the salary record ${plan.offer.source}`, submit: false,
        sealed: sealValue(ring, fig, payContext(v.org, pid, "change", changeId)) }])).rows[0].id;
    }
    return { startId, offerId };
  }));

  // ----------------------------------------------------------------------------------------------- offers
  const offerBody = async (c: PoolClient, v: Viewer, b: Body, existing: Row | null) => {
    const pid = id(b.person, "Person"), r = await person(c, pid), ring = await requireKeyring("pay");
    const payType = (PAY_TYPES as readonly string[]).includes(String(b.payType)) ? (b.payType as PayType) : fail(400, "Choose the pay type");
    const f = b.figures && typeof b.figures === "object" ? (b.figures as Body) : {};
    const figures = normaliseFigures({ monthly: money(f.monthly, "The pay a month"), ctc: money(f.ctc, "The yearly CTC"), rate: money(f.rate, "The hourly rate"), hours: f.hours,
      components: f.components && typeof f.components === "object" ? Object.fromEntries(Object.entries(f.components as Body).map(([k, x]) => [k, money(x, k)]).filter(([, x]) => x !== null)) : undefined },
    payType, template(r.policy));
    const changeId = existing?.changeId ?? randomUUID();
    return { r, figures, payload: { id: existing?.id ?? undefined, person: pid, changeId, role: str(b.role, 120), startOn: day(b.startOn, "the start date"), payType,
      probationDays: b.probationDays === undefined || b.probationDays === "" ? null : Number(b.probationDays), noticeDays: b.noticeDays === undefined || b.noticeDays === "" ? null : Number(b.noticeDays),
      terms: str(b.terms, 4000), validUntil: isDay(b.validUntil) ? b.validUntil : null, reason: str(b.reason, 1000), submit: b.submit === true,
      sealed: sealValue(ring, figures, payContext(v.org, pid, "change", changeId)) } };
  };
  app.post<{ Body: Body }>("/api/v0/comp/offers", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR drafts offers");
    const b = req.body ?? {};
    let existing: Row | null = null;
    if (typeof b.id === "string" && UUID.test(b.id)) existing = ((await person(c, id(b.person, "Person"))).offers as Row[]).find((o) => o.id === b.id) ?? fail(404, "Offer not found");
    const { payload } = await offerBody(c, v, b, existing);
    return { id: (await c.query("select pulse.comp_offer_save($1) id", [payload])).rows[0].id };
  }));
  app.post<{ Body: Body }>("/api/v0/comp/offers/preview", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR drafts offers");
    const { r, figures, payload } = await offerBody(c, v, req.body ?? {}, null);
    const pol = r.policy, o = { ...payload, validUntil: payload.validUntil ?? addDays(await today(c), Number(pol.offerDays) || 7), probationDays: payload.probationDays ?? pol.probationDays };
    const now = await today(c), from = o.startOn > now ? o.startOn : now;
    const budget = await budgetLine(c, v, await requireKeyring("pay"), r.person.pod ?? null, from, monthlyCost(figures));
    return { figures, components: componentRows(figures, template(pol)), budget, letter: { kind: "offer", data: offerLetter(r, o, figures, pol) } };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/comp/offers/:id/propose", (req) => tx(req, async (c) => {
    await guard(c, "writer", "HR drafts offers");
    await c.query("select pulse.comp_offer_propose($1)", [id(req.params.id, "Offer")]);
    return { ok: true };
  }));
  const owner = async (c: PoolClient, kind: string, rid: string) => (await c.query("select pulse.comp_owner($1,$2) p", [kind, rid])).rows[0].p as string;
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/offers/:id/decide", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "approver", "A founder approves offers");
    const oid = id(req.params.id, "Offer");
    const action = ["approve", "reject", "return"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Approve, reject or send back");
    const pid = await owner(c, "offer", oid);
    const st = (await c.query("select pulse.comp_offer_decide($1,$2,$3) s", [oid, action, str(req.body?.note, 1000)])).rows[0].s as string;
    if (st !== "approved") return { status: st };
    const ring = await requireKeyring("pay"), r = await person(c, pid), h = await history(c, ring, v.org, pid);
    const o = (r.offers as Row[]).find((x) => x.id === oid)!;
    const letterId = await fileLetter(c, ring, v.org, { person: pp(r), kind: "offer", subjectType: "offer", subjectId: oid, data: offerLetter(r, o, h.figures.get(o.changeId)!, r.policy) });
    return { status: st, letterId };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/offers/:id/send", { schema: { body } }, (req) => tx(req, async (c) => {
    await guard(c, "approver", "A founder sends offers");
    const oid = id(req.params.id, "Offer"), link = req.body?.link !== false;
    const token = link ? randomBytes(32).toString("base64url") : null;
    const r = (await c.query("select pulse.comp_offer_send($1,$2) r", [oid, token ? createHash("sha256").update(token).digest("hex") : null])).rows[0].r as Row;
    return { url: token ? `${companyOrigin()}/offer/${token}` : null, validUntil: r.validUntil };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/offers/:id/withdraw", { schema: { body } }, (req) => tx(req, async (c) => {
    const w = await guard(c, "any");
    if (!w.writer && !w.approver) fail(403, "HR and founders withdraw offers");
    await c.query("select pulse.comp_offer_withdraw($1,$2)", [id(req.params.id, "Offer"), str(req.body?.note, 1000)]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/offers/:id/answer", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, "Sign in as the person the offer is for");
    const decision = ["accepted", "declined"].includes(String(req.body?.decision)) ? String(req.body?.decision) : fail(400, "Accept or decline");
    return (await c.query("select pulse.comp_offer_answer($1,$2,$3,$4) r", [id(req.params.id, "Offer"), decision, str(req.body?.name, 120), str(req.body?.note, 1000)])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/offers/:id/task", { schema: { body } }, (req) => tx(req, async (c) => {
    const w = await guard(c, "any");
    if (!w.writer && !w.approver) fail(403, "HR and founders link offers to tasks");
    await c.query("select pulse.comp_offer_task($1,$2)", [id(req.params.id, "Offer"), id(req.body?.taskId, "Task")]);
    return { ok: true };
  }));
  // Signed out: the person's offer through its link (only a hash of the token is stored).
  const hashOf = (token: string) => (/^[A-Za-z0-9_-]{43}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null);
  app.get<{ Params: { token: string } }>("/api/v0/offer/:token", async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    return (await open(async (c) => (await c.query("select pulse.comp_offer_open($1) r", [h])).rows[0].r)) ?? fail(404, "This link is not valid or has expired");
  });
  app.get<{ Params: { token: string } }>("/api/v0/offer/:token/pdf", async (req, reply) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const out = await open(async (c, org) => {
      const r = (await c.query("select person_id,letter_id,kid,dkey,data from pulse.comp_offer_link_letter($1)", [h])).rows[0];
      if (!r) return null;
      return openBytes(await requireKeyring("pay"), r, payContext(org, r.person_id, "letter-pdf", r.letter_id));
    });
    if (!out) fail(404, "This link is not valid or has expired");
    reply.header("cache-control", "private, no-store");
    return reply.type("application/pdf").send(out);
  });
  app.post<{ Params: { token: string }; Body: Body }>("/api/v0/offer/:token", async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const ip = String(req.headers["x-pulse-client-ip"] ?? req.ip ?? "");
    const decision = ["accepted", "declined"].includes(String(req.body?.decision)) ? String(req.body?.decision) : fail(400, "Accept or decline");
    return open(async (c) => (await c.query("select pulse.comp_offer_link_answer($1,$2,$3,$4,$5,$6) r", [h, decision, str(req.body?.name, 120), str(req.body?.note, 1000),
      createHash("sha256").update(`comp-offer:${ip}`).digest("hex"), str(req.headers["user-agent"], 300)])).rows[0].r);
  });

  // ---------------------------------------------------------------------------------------------- probation
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/people/:id/probation", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR records probation outcomes");
    const pid = id(req.params.id, "Person"), b = req.body ?? {};
    const action = ["confirm", "extend", "end"].includes(String(b.action)) ? String(b.action) : fail(400, "Confirm, extend or end");
    const r = (await c.query("select pulse.comp_probation_propose($1,$2) r", [pid, { action, until: isDay(b.until) ? b.until : null, note: str(b.note, 1000) }])).rows[0].r as Row;
    if (r.status === "approved") r.letterId = await probationLetter(c, v, r.id as string, pid);
    return r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/probation/:id/decide", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "approver", "A founder decides this");
    const bid = id(req.params.id, "Outcome");
    const action = ["approve", "reject"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Approve or reject");
    const st = (await c.query("select pulse.comp_probation_decide($1,$2,$3) s", [bid, action, str(req.body?.note, 1000)])).rows[0].s as string;
    if (st !== "approved") return { status: st };
    return { status: st, letterId: await probationLetter(c, v, bid, await owner(c, "probation", bid)) };
  }));
  async function probationLetter(c: PoolClient, v: Viewer, bid: string, pid: string) {
    const ring = await requireKeyring("pay");
    const r = await person(c, pid);
    const b = ((r.probation?.outcomes ?? []) as Row[]).find((x) => x.id === bid) ?? fail(404, "Outcome not found");
    const kind = `probation_${b.action}`, on = await today(c);
    return fileLetter(c, ring, v.org, { person: pp(r), kind, subjectType: "probation", subjectId: bid,
      data: { name: r.person.name, role: r.person.role, effective: on, probationEnd: b.until, lastDay: b.until, reason: b.note ?? "", noticeConfirmed: r.policy.noticeConfirmed } });
  }
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/reviews/:id", { schema: { body } }, (req) => tx(req, async (c) => {
    await c.query("select pulse.comp_review_done($1,$2)", [id(req.params.id, "Review"), str(req.body?.note, 2000)]);
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------------- pauses
  app.post<{ Body: Body }>("/api/v0/comp/pauses", { schema: { body } }, (req) => tx(req, async (c) => {
    await guard(c, "writer", "HR proposes pauses");
    const b = req.body ?? {};
    const paid = Math.max(0, Math.min(99, Math.round(Number(b.paidPercent) || 0)));
    return { id: (await c.query("select pulse.comp_pause_save($1) id", [{ person: id(b.person, "Person"), from: day(b.from, "the first day"), to: day(b.to, "the last day"),
      paidPercent: paid, reasonKind: str(b.reasonKind, 20), note: str(b.note, 1000) }])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/pauses/:id/decide", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "approver", "The approver named in the pay policy decides pauses");
    const zid = id(req.params.id, "Pause");
    const action = ["approve", "reject"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Approve or reject");
    const pid = await owner(c, "pause", zid);
    const st = (await c.query("select pulse.comp_pause_decide($1,$2,$3) s", [zid, action, str(req.body?.note, 1000)])).rows[0].s as string;
    if (st !== "approved") return { status: st };
    const ring = await requireKeyring("pay"), r = await person(c, pid);
    const z = (r.pauses as Row[]).find((x) => x.id === zid)!;
    const letterId = await fileLetter(c, ring, v.org, { person: pp(r), kind: "pause", subjectType: "pause", subjectId: zid,
      data: { name: r.person.name, role: r.person.role, payType: r.inForce?.payType ?? "salary", pauseFrom: z.from, pauseTo: z.to, resumeOn: addDays(z.to, 1), paidPercent: z.paidPercent,
        pauseReason: z.reasonKind, reason: z.note ?? "" } });
    return { status: st, letterId };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/pauses/:id/close", { schema: { body } }, (req) => tx(req, async (c) => {
    await guard(c, "writer", "HR ends or withdraws pauses");
    const action = ["withdraw", "end"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Withdraw or end");
    await c.query("select pulse.comp_pause_close($1,$2,$3)", [id(req.params.id, "Pause"), action, isDay(req.body?.on) ? req.body?.on : null]);
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------- one-time items
  app.post<{ Body: Body }>("/api/v0/comp/items", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR proposes one-time items");
    const b = req.body ?? {}, pid = id(b.person, "Person"), ring = await requireKeyring("pay");
    const amount = money(b.amount, "The amount") ?? fail(400, "Give the amount");
    if (amount <= 0) fail(400, "Give the amount");
    const ref: Body = {};
    if (Array.isArray(b.dates)) ref.dates = (b.dates as unknown[]).filter(isDay).slice(0, 31);
    if (Array.isArray(b.creditIds)) ref.creditIds = (b.creditIds as unknown[]).filter((x) => typeof x === "string" && UUID.test(x)).slice(0, 31);
    const iid = randomUUID();
    return { id: (await c.query("select pulse.comp_item_save($1) id", [{ id: iid, person: pid, kind: str(b.kind, 20), forMonth: isDay(b.forMonth) ? b.forMonth : null,
      payout: b.payout === "separate" ? "separate" : "payroll", reason: str(b.reason, 1000), ref, recoverMonths: b.recoverMonths ? Number(b.recoverMonths) : null,
      recoverFrom: isDay(b.recoverFrom) ? b.recoverFrom : null, sealed: sealValue(ring, { amount }, payContext(v.org, pid, "item", iid)) }])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/items/:id/decide", { schema: { body } }, (req) => tx(req, async (c) => {
    const w = await guard(c, "any");
    if (!w.writer && !w.approver) fail(403, "HR and founders decide one-time items");
    const action = ["approve", "reject", "withdraw"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Approve, reject or withdraw");
    if (action === "withdraw" ? !w.writer : !w.approver) fail(403, action === "withdraw" ? "HR withdraws items" : "The approver named in the pay policy decides one-time items");
    return { status: (await c.query("select pulse.comp_item_decide($1,$2,$3) s", [id(req.params.id, "Item"), action, str(req.body?.note, 1000)])).rows[0].s };
  }));

  // ---------------------------------------------------------------------------------------------- claims
  const RECEIPT_MAX = 8 * 1024 * 1024;
  const sniff = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
    : b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" ? "image/webp" : b.subarray(0, 5).toString() === "%PDF-" ? "application/pdf" : null;
  app.post<{ Body: Body }>("/api/v0/comp/claims", { schema: { body }, bodyLimit: Math.ceil(RECEIPT_MAX * 1.37) + 8192 }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, "Claims are for staff");
    const b = req.body ?? {};
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.receipt ?? ""));
    if (!m) fail(400, "Add a photo or PDF of the bill");
    const bytes = Buffer.from(m![2], "base64"), mime = sniff(bytes);
    if (!mime) fail(400, "The bill must be a photo (JPEG, PNG or WebP) or a PDF");
    if (bytes.length > RECEIPT_MAX) fail(400, "The bill is larger than 8 MB: take the photo again at a lower size");
    const amount = money(b.amount, "The amount") ?? fail(400, "Give the amount");
    if (amount <= 0) fail(400, "Give the amount");
    const spentOn = day(b.spentOn, "the bill's date"), category = str(b.category, 30);
    const pol = await policy(c), now = await today(c), ring = await requireKeyring("pay");
    const cat = (pol.claimCategories as Row[]).find((x) => x.key === category) ?? fail(400, "Choose a category");
    if (cat.cap) {
      const mine = (await c.query("select pulse.comp_me() p")).rows[0].p as Row, h = await history(c, ring, v.org, v.person!);
      const used = ((mine.claims ?? []) as Row[]).filter((k) => k.category === category && k.forMonth === monthStart(now) && !["rejected", "withdrawn"].includes(k.status))
        .reduce((a, k) => a + (h.amounts.get(k.id) ?? 0), 0);
      if (used + amount > Number(cat.cap) * 100) fail(400, `This goes over the monthly limit for ${String(cat.label).toLowerCase()}: ask HR about it`);
    }
    const cid = randomUUID();
    const saved = (await c.query("select pulse.comp_claim_submit($1) id", [{ id: cid, category, spentOn, vendor: str(b.vendor, 120), note: str(b.note, 500),
      payout: b.payout === "separate" ? "separate" : "payroll", aboveThreshold: pol.claimThreshold != null && amount > Number(pol.claimThreshold) * 100,
      receiptMime: mime, receiptSize: bytes.length, receiptSha256: sha(bytes), dupKey: dupKey(ring, v.org, `${v.person}|${amount}|${spentOn}`),
      sealed: sealValue(ring, { amount }, payContext(v.org, v.person!, "claim", cid)), receipt: sealBytes(ring, bytes, payContext(v.org, v.person!, "receipt", cid)) }])).rows[0].id;
    return { id: saved };
  }));
  app.get("/api/v0/comp/claims", (req) => tx(req, async (c, v) => {
    const list = (await c.query("select pulse.comp_claims_waiting() l")).rows[0].l as Row[];
    const ring = list.length ? await ringOrNull() : null;
    for (const k of list) {
      if (!ring) { k.amount = null; continue; }
      const s = (await c.query("select person_id,kid,dkey,data from pulse.comp_sealed('claim',$1)", [k.id])).rows[0];
      k.amount = openValue<{ amount: number }>(ring, s, payContext(v.org, s.person_id, "claim", k.id)).amount;
    }
    return { claims: list, keyring: !!ring };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/comp/claims/:id/receipt", async (req, reply) => {
    const out = await tx(req, async (c, v) => {
      const kid = id(req.params.id, "Claim");
      const s = (await c.query("select person_id,kid,dkey,data from pulse.comp_sealed('receipt',$1)", [kid])).rows[0];
      return openBytes(await requireKeyring("pay"), s, payContext(v.org, s.person_id, "receipt", kid));
    });
    reply.header("cache-control", "private, no-store").header("content-security-policy", "sandbox").header("content-disposition", 'inline; filename="bill"');
    return reply.type(sniff(out) ?? "application/octet-stream").send(out);
  });
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/claims/:id/decide", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, "Sign in");
    const action = ["approve", "reject", "withdraw"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Approve, reject or withdraw");
    return { status: (await c.query("select pulse.comp_claim_decide($1,$2,$3) s", [id(req.params.id, "Claim"), action, str(req.body?.note, 1000)])).rows[0].s };
  }));

  // --------------------------------------------------------------------------------------- full and final
  /** The statement worked out from the leaving case's days, the pay in force, approved items, claims and recoveries. */
  async function statement(c: PoolClient, v: Viewer, pid: string, b: Body) {
    const r = await person(c, pid);
    if (!r.record) fail(404, "This person has no pay record: set it up first");
    const ring = await requireKeyring("pay"), h = await history(c, ring, v.org, pid), now = await today(c);
    const step = (r.leavingCase?.settlement ?? {}) as Row;
    const lastDay = isDay(b.lastDay) ? b.lastDay : r.employment?.lastWorkingDay ?? r.leavingCase?.effectiveOn ?? fail(400, "Give the last working day");
    const ver = inForceOn((r.versions ?? []) as Row[], lastDay), figures = ver ? h.figures.get(ver.id) ?? null : null;
    const exitKind = String(b.exitKind ?? (r.leavingCase?.leftType === "terminated" ? "terminated" : r.leavingCase?.leftType === "contract_ended" ? "contract_ended" : "resigned"));
    const required = Number(b.noticeRequired ?? step.noticeRequiredDays ?? (r.employment?.probationTo && r.employment.probationTo >= lastDay ? r.policy.noticeProbation : r.policy.noticeConfirmed)) || 0;
    const served = Number(b.noticeServed ?? step.noticeServedDays ?? 0) || 0;
    const mode = (["served", "short_recovered", "waived", "paid_in_lieu"].includes(String(b.noticeMode)) ? b.noticeMode : required > served ? "short_recovered" : "served") as "served" | "short_recovered" | "waived" | "paid_in_lieu";
    const unpaid = ((r.items ?? []) as Row[]).filter((i) => i.status === "approved" && !i.paidAt);
    const items = unpaid.filter((i) => !["advance", "loan"].includes(i.kind)).map((i) => ({ label: `${i.kind[0].toUpperCase()}${i.kind.slice(1)}: ${i.reason ?? ""}`.slice(0, 80), amount: h.amounts.get(i.id) ?? 0 }));
    const recoveries = unpaid.filter((i) => ["advance", "loan"].includes(i.kind)).map((i) => {
      const left = recoverySchedule(h.amounts.get(i.id) ?? 0, i.recoverMonths, i.recoverFrom).filter((x) => x.month > monthStart(now)).reduce((a, x) => a + x.amount, 0);
      return { label: `${i.kind === "loan" ? "Loan" : "Advance"} still to recover`, amount: left };
    }).filter((x) => x.amount > 0);
    const claims = ((r.claims ?? []) as Row[]).filter((k) => k.status === "approved" && !k.paidAt).map((k) => ({ label: `Reimbursement: ${k.vendor ?? k.category}`, amount: h.amounts.get(k.id) ?? 0 }));
    const adjustments = Array.isArray(b.adjustments) ? (b.adjustments as Row[]).slice(0, 10).map((a) => ({ label: str(a.label, 80) || "Adjustment", amount: (money(Math.abs(Number(a.amount)), "An adjustment") ?? 0) * (Number(a.amount) < 0 ? -1 : 1), reason: str(a.reason, 200) || fail(400, "Say why for each adjustment") })) : [];
    const out = settlement({ lastDay, figures, lastMonthPaid: b.lastMonthPaid === true, encash: { days: Number(b.encashDays ?? step.leaveDays ?? 0) || 0, basis: r.policy.encashBasis, divisor: Number(r.policy.encashDivisor) || 30 },
      notice: { required, served, mode }, items, claims, recoveries, joinedOn: r.person.joinedOn ?? r.record?.startOn ?? null, gratuity: b.gratuity !== false, adjustments });
    const settleBy = isDay(step.settlementBy) ? step.settlementBy : addDays(lastDay, 2);
    return { r, ring, lastDay, exitKind, mode, required, served, settleBy, ...out, inputs: { encashDays: Number(b.encashDays ?? step.leaveDays ?? 0) || 0, lastMonthPaid: b.lastMonthPaid === true, adjustments } };
  }
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/people/:id/settlement/preview", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR prepares the full and final");
    const s = await statement(c, v, id(req.params.id, "Person"), req.body ?? {});
    return { lastDay: s.lastDay, exitKind: s.exitKind, noticeMode: s.mode, noticeRequired: s.required, noticeServed: s.served, settleBy: s.settleBy, lines: s.lines, net: s.net, inputs: s.inputs,
      letter: { kind: "settlement", data: { name: s.r.person.name, lastDay: s.lastDay, settleBy: s.settleBy, net: s.net, statement: s.lines, currency: s.r.record?.currency } } };
  }));
  app.post<{ Body: Body }>("/api/v0/comp/settlements", { schema: { body } }, (req) => tx(req, async (c, v) => {
    await guard(c, "writer", "HR prepares the full and final");
    const b = req.body ?? {}, pid = id(b.person, "Person"), s = await statement(c, v, pid, b);
    const legal = Object.fromEntries(["reason", "notice", "heard", "dues"].map((k) => [k, (b.legal as Row | undefined)?.[k] === true]));
    return { id: (await c.query("select pulse.comp_settlement_save($1) id", [{ person: pid, caseId: s.r.leavingCase?.id ?? null, exitKind: s.exitKind, lastDay: s.lastDay, noticeMode: s.mode, legal,
      note: str(b.note, 2000), sealed: sealValue(s.ring, { lines: s.lines, net: s.net, settleBy: s.settleBy, noticeRequired: s.required, noticeServed: s.served, inputs: s.inputs }, payContext(v.org, pid, "settlement")) }])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/comp/settlements/:id/step", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const w = await guard(c, "any");
    if (!w.writer && !w.approver) fail(403, "The full and final is for HR and founders");
    const action = ["check", "approve", "return", "withdraw"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Check, approve, send back or withdraw");
    if (["check", "withdraw"].includes(action) ? !w.writer : !w.approver) fail(403, action === "check" ? "HR checks the statement" : "A founder approves the full and final");
    const sid = id(req.params.id, "Full and final");
    const st = (await c.query("select pulse.comp_settlement_step($1,$2,$3) s", [sid, action, str(req.body?.note, 1000)])).rows[0].s as string;
    if (st !== "approved") return { status: st };
    const pid = await owner(c, "settlement", sid);
    const ring = await requireKeyring("pay"), r = await person(c, pid);
    const sealed = (await c.query("select person_id,kid,dkey,data from pulse.comp_sealed('settlement',$1)", [sid])).rows[0];
    const s = openValue<Row>(ring, sealed, payContext(v.org, pid, "settlement"));
    const letterId = await fileLetter(c, ring, v.org, { person: pp(r), kind: "settlement", subjectType: "settlement", subjectId: sid,
      data: { name: r.person.name, role: r.person.role, lastDay: r.settlement.lastDay, settleBy: s.settleBy, net: s.net, statement: s.lines, currency: r.record?.currency } });
    return { status: "issued", letterId };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/comp/settlements/:id", (req) => tx(req, async (c, v) => {
    const sid = id(req.params.id, "Full and final");
    const sealed = (await c.query("select person_id,kid,dkey,data from pulse.comp_sealed('settlement',$1)", [sid])).rows[0];
    return openValue<Row>(await requireKeyring("pay"), sealed, payContext(v.org, sealed.person_id, "settlement"));
  }));

  // ------------------------------------------------------------------------------------------------ letters
  for (const format of ["pdf", "docx"] as const) {
    app.get<{ Params: { id: string }; Querystring: { inline?: string } }>(`/api/v0/comp/letters/:id/${format}`, async (req, reply) => {
      const lid = id(req.params.id, "Letter");
      const out = await tx(req, async (c, v) => {
        const r = (await c.query("select person_id,kind,title,kid,dkey,data from pulse.comp_letter_sealed($1,$2)", [lid, format === "pdf" ? "pdf" : "content"])).rows[0];
        const ring = await requireKeyring("pay");
        if (format === "pdf") return { title: r.title as string, bytes: openBytes(ring, r, payContext(v.org, r.person_id, "letter-pdf", lid)) };
        const s = openValue<Row>(ring, r, payContext(v.org, r.person_id, "letter", lid));
        const assets = await c.query("select pulse.comp_writer() or pulse.comp_is_approver() ok").then(async (q) => q.rows[0].ok ? letterhead(c) : null);
        return { title: r.title as string, bytes: Buffer.from(await renderLetterDocx(buildLetterModel(s.design, s.letter, { logo: assets?.logo ?? null, signature: assets?.signature ?? null }), { fonts: await fonts() })) };
      });
      const name = `${out.title.replace(/[^A-Za-z0-9 ._-]+/g, "").trim().replace(/\s+/g, "-") || "letter"}.${format}`;
      reply.header("cache-control", "private, no-store").header("content-disposition", `${req.query.inline === "1" && format === "pdf" ? "inline" : "attachment"}; filename="${name}"`);
      return reply.type(format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(out.bytes);
    });
  }

  // ------------------------------------------------------------------------------- a month, and totals
  // What a month pays one person (COMP-B's payroll input), for founders, HR and the person.
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>("/api/v0/comp/people/:id/month", (req) => tx(req, async (c, v) => {
    const pid = id(req.params.id, "Person"), r = await person(c, pid);
    if (!r.can.read && !r.can.self) fail(403, "Pay is for founders, HR and the person");
    if (!r.record) fail(404, "This person has no pay record");
    const ring = await requireKeyring("pay");
    const month = monthStart(isDay(`${req.query.month}-01`) ? `${req.query.month}-01` : await today(c));
    return monthOf(r, await history(c, ring, v.org, pid), month);
  }));
  // Totals for a month: founders, HR and the Accountant (no names for the Accountant: the database hides them).
  app.get<{ Querystring: { month?: string } }>("/api/v0/comp/totals", (req) => tx(req, async (c, v) => {
    const month = monthStart(isDay(`${req.query.month}-01`) ? `${req.query.month}-01` : await today(c));
    const dim = Number(monthEnd(month).slice(8, 10));
    const rows = (await c.query("select person_key,person_id,change_id,pay_type,effective_on::text \"from\",until_on::text \"to\",kid,dkey,data,pause from pulse.comp_month_sealed($1)", [month])).rows;
    const per = new Map<string, number>(), ring = rows.length ? await requireKeyring("pay") : null;
    let total = 0;
    for (const x of rows) {
      const f = openValue<Figures>(ring!, x, payContext(v.org, x.person_id, "change", x.change_id));
      const days = Number(String(x.to).slice(8, 10)) - Number(String(x.from).slice(8, 10)) + 1;
      const amount = Math.round(((f.monthly * days) / dim) * Number(x.pause ?? 1));
      total += amount; per.set(x.person_key, (per.get(x.person_key) ?? 0) + amount);
    }
    return { month: month.slice(0, 7), total, people: per.size, basis: "Pay in force for the days of the month, after approved pauses. Not bank payments; one-time items and claims are not included." };
  }));
}

/** A month's pay from a person's page data and opened history (shared with COMP-B's run). */
export function monthOf(r: Row, h: { figures: Map<string, Figures>; amounts: Map<string, number> }, month: string) {
  const versions = ((r.versions ?? []) as Row[]).filter((x) => x.status === "approved" && h.figures.get(x.id)).map((x) => ({ effectiveOn: x.effectiveOn, payType: x.payType as PayType, figures: h.figures.get(x.id)! }));
  const pauses = ((r.pauses ?? []) as Row[]).filter((z) => z.status === "approved").map((z) => ({ from: z.from, to: z.endedOn ?? z.to, paidPercent: z.paidPercent }));
  const items = ((r.items ?? []) as Row[]).filter((i) => i.status === "approved" && h.amounts.has(i.id)).map((i) => ({ kind: i.kind, amount: h.amounts.get(i.id)!, forMonth: i.forMonth, payout: i.payout, recoverMonths: i.recoverMonths, recoverFrom: i.recoverFrom }));
  const claims = ((r.claims ?? []) as Row[]).filter((k) => k.status === "approved" && h.amounts.has(k.id)).map((k) => ({ amount: h.amounts.get(k.id)!, forMonth: k.forMonth, payout: k.payout, label: `Reimbursement: ${k.vendor ?? k.category}` }));
  return { month: month.slice(0, 7), ...monthPay({ month, versions, start: r.record?.startOn ?? null, end: r.record?.endOn ?? null, pauses, items, claims }) };
}
