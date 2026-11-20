// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C): the AI's change card. An AI employee (or anyone through the
// API) proposes changes to a draft quotation, proforma or invoice: a price, an extra charge, a quantity, a line off. The
// card shows them in plain words with the total after applying; nothing changes until a person taps Apply (the draft is
// saved through the composer's own saveDraft, so the totals, the base prices and the log are the composer's) or Not now.
//   GET  /api/v0/erp/documents/:id/proposals              the cards waiting (also in the document's own read)
//   POST /api/v0/erp/documents/:id/proposals/:pid/apply   a person applies a card
//   POST /api/v0/erp/documents/:id/proposals/:pid/dismiss Not now
// API v1 / MCP: proposeQuoteChanges (propose_quote_changes) in v1-money.ts.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Tx, type Viewer } from "./routes.js";
import { cleanLines, ErpInputError, neededLines, UUID, unregisteredInvoice, type LineRow } from "./erp-model.js";
import { applyChanges, cleanChanges, describeChange, rupees, splitFigures, STALE, type Change } from "./quote-builder-model.js";
import { builderTelemetry, DOC_COLS, LINE_COLS, log, reader, saveDraft, writer } from "./erp.js";

type Row = Record<string, unknown>;
const KINDS = ["quotation", "proforma", "invoice"];
const id = (raw: unknown, what: string) => (typeof raw === "string" && UUID.test(raw) ? raw : fail(404, `${what} not found`));

/** A draft as the card sees it: its fields, its lines (as saved) and each line's base. */
async function draftOf(c: PoolClient, docId: string) {
  const cur = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [docId])).rows[0] as Row | undefined;
  if (!cur || !KINDS.includes(String(cur.docType))) fail(404, "Quotation, proforma or invoice not found");
  const stored = (await c.query(`select ${LINE_COLS} from pulse.erp_line where document_id=$1 order by position`, [docId])).rows as Row[];
  const lines = cleanLines(stored);
  const bases = stored.map((r) => (r.catalogueRate === null || r.catalogueRate === undefined ? null : Number(r.catalogueRate)));
  return { cur: cur!, lines, bases };
}
/** The total and the estimates a draft would have with these lines (as saveDraft works them out). */
function figuresOf(cur: Row, lines: LineRow[]) {
  const noGst = unregisteredInvoice(cur.docType, cur.seller as Row);
  const { kept } = neededLines(noGst ? lines.map((l) => ({ ...l, gstRate: 0 })) : lines);
  const seller = (cur.seller ?? {}) as Row;
  const s = splitFigures(String(seller.stateCode ?? ""), { placeOfSupply: (cur.placeOfSupply as string) ?? null, roundTotal: cur.roundTotal !== false,
    reverseCharge: !!cur.reverseCharge, zeroRated: !!cur.zeroRated }, kept);
  return { total: s.fig.total, estimate: s.estimate };
}
const isAi = async (c: PoolClient, v: Viewer) => !!v.person && !!(await c.query("select 1 from pulse.agent_member where person_id=$1 limit 1", [v.person])).rows[0];

type Stored = Change & { text: string };
export type Proposal = { id: string; documentId: string; status: string; ask: string | null; items: { op: string; text: string }[]; stale: boolean;
  before: Figures; after: Figures; by: string | null; createdAt: string };
type Figures = { total: number; estimate: number; totalRupees: string; estimateRupees: string };
const said = (f: { total: number; estimate: number }): Figures => ({ ...f, totalRupees: rupees(f.total), estimateRupees: rupees(f.estimate) });
function out(p: Row, lines: LineRow[] | null, cur: Row | null, bases: (number | null)[]): Proposal {
  const changes = p.changes as Stored[];
  let stale = false, after = { total: Number(p.after_total), estimate: 0 }, before = { total: Number(p.before_total), estimate: 0 };
  if (lines && cur && p.status === "pending") {
    try { before = figuresOf(cur, lines); after = figuresOf(cur, applyChanges(lines, changes, bases)); } catch (e) { if (e instanceof ErpInputError) stale = true; else throw e; }
  }
  return { id: String(p.id), documentId: String(p.document_id), status: String(p.status), ask: (p.ask as string) ?? null, items: changes.map((c) => ({ op: c.op, text: c.text })), stale,
    before: said(before), after: said(after), by: (p.by as string) ?? null, createdAt: String(p.created_at) };
}
const COLS = `p.id,p.document_id,p.changes,p.ask,p.status,p.before_total::float8 before_total,p.after_total::float8 after_total,p.created_at,(select display_name from pulse.person where id=p.created_by) "by"`;

/** The cards waiting on a draft, newest first, each checked against the draft as it is now (stale: ask again). */
export async function pendingProposals(c: PoolClient, docId: string): Promise<Proposal[]> {
  const rows = (await c.query(`select ${COLS} from pulse.erp_quote_proposal p where p.document_id=$1 and p.status='pending' order by p.created_at desc limit 5`, [docId])).rows as Row[];
  if (!rows.length) return [];
  const { cur, lines, bases } = await draftOf(c, docId);
  return rows.map((p) => out(p, lines, cur, bases));
}

/** A new card for a draft. Checked now (each line it names, each amount); nothing on the draft changes. */
export async function proposeChanges(c: PoolClient, v: Viewer, docId: string, raw: unknown, ask: string | null): Promise<Proposal> {
  await writer(c);
  const { cur, lines, bases } = await draftOf(c, docId);
  if (cur.status !== "draft") fail(409, cur.docType === "quotation" ? "This quotation is approved: revise it first (revise_quotation), then propose changes" : "Only a draft changes");
  const changes = cleanChanges(raw, lines);
  const stored: Stored[] = changes.map((ch) => ({ ...ch, text: describeChange(ch, lines, bases) }));
  const before = figuresOf(cur, lines), after = figuresOf(cur, applyChanges(lines, changes, bases));
  const p = (await c.query(`insert into pulse.erp_quote_proposal(org_id,document_id,changes,ask,before_total,after_total,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6)
    returning id,document_id,changes,ask,status,before_total::float8 before_total,after_total::float8 after_total,created_at`,
    [docId, JSON.stringify(stored), ask ? ask.slice(0, 500) : null, before.total, after.total, v.person])).rows[0] as Row;
  await builderTelemetry(c, v, [{ kind: "billing.ai_proposal", name: String(cur.docType), value: after.total - before.total,
    detail: { step: "proposed", by: (await isAi(c, v)) ? "ai" : "person", ops: changes.map((ch) => ch.op) } }]);
  return { ...out(p, null, null, bases), before: said(before), after: said(after) };
}

/** Apply (a person only) or Not now. Apply saves the changed lines as the composer would; a card the draft has moved
 *  past is refused (ask again) and stays for Not now. */
export async function decideProposal(c: PoolClient, v: Viewer, docId: string, pid: string, apply: boolean) {
  await writer(c);
  const p = (await c.query(`select ${COLS} from pulse.erp_quote_proposal p where p.id=$1 and p.document_id=$2 for update`, [pid, docId])).rows[0] as Row | undefined;
  if (!p) fail(404, "Change card not found");
  if (p!.status !== "pending") fail(409, p!.status === "applied" ? "These changes are already applied" : "This card was closed with Not now");
  let total: number | null = null;
  if (apply) {
    if (await isAi(c, v)) fail(403, "A person applies the assistant's changes");
    const { cur, lines, bases } = await draftOf(c, docId);
    if (cur.status !== "draft") fail(409, "Only a draft changes");
    let next: LineRow[];
    try { next = applyChanges(lines, p!.changes as Stored[], bases); } catch (e) { if (e instanceof ErpInputError) fail(409, e.message === STALE ? STALE : e.message); throw e; }
    const fig = await saveDraft(c, v, docId, { ...cur, lines: next! });
    total = fig.total;
    await log(c, "document", docId, "ai_changes_applied", { card: pid, from: Number(p!.before_total), to: fig.total, changes: (p!.changes as Stored[]).length });
  }
  await c.query("update pulse.erp_quote_proposal set status=$2,decided_by=$3,decided_at=now() where id=$1", [pid, apply ? "applied" : "dismissed", v.person]);
  await builderTelemetry(c, v, [{ kind: "billing.ai_proposal", name: "card", value: apply ? 1 : 0, detail: { step: apply ? "applied" : "dismissed" } }]);
  return { ok: true, status: apply ? "applied" : "dismissed", total };
}

export function registerQuoteProposalRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>("/api/v0/erp/documents/:id/proposals", (req) => tx(req, async (c) => {
    await reader(c);
    return { proposals: await pendingProposals(c, id(req.params.id, "Document")) };
  }));
  for (const [path, apply] of [["apply", true], ["dismiss", false]] as const) {
    app.post<{ Params: { id: string; pid: string } }>(`/api/v0/erp/documents/:id/proposals/:pid/${path}`, (req) => tx(req, (c, v) =>
      decideProposal(c, v, id(req.params.id, "Document"), id(req.params.pid, "Change card"), apply)));
  }
}
