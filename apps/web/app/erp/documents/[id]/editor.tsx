"use client";

// Billing composer (18 Oct 2026, the blueprint's "Composer"): write on the left, the customer's copy on the right; on a
// phone the copy is a sheet that peeks from the bottom with the total and the one main button. One line per thing: a
// catalogue line keeps the catalogue's price and has a +/− for the quantity; an amount that changes by site (installation,
// transport, a service priced at ₹0 in the catalogue) stays highlighted until it is filled or marked not needed; a
// different price is a request the owner approves, never typed over the catalogue's. Client, GSTIN and terms come from the
// record and the template (a tap on the client opens them); the rest waits behind "More details". The draft saves itself
// a moment after each change; the main button approves it, which numbers it (the PDF exactly as exported is filed then).
// BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane): the catalogue search forgives case, spaces and punctuation
// ("purepower 5" finds Pure Power 5.0) and matches codes; a line can carry an extended warranty (an add-on line priced
// like any other); a tax invoice names the serial number of each unit of serialised stock it sells; a customer typed in
// is matched to the profile that already has their phone or e-mail; a salesperson sends the draft to a manager or the
// owner for approval, who approves it with one tap.
// KAZUK-REST (6 Nov 2026; Kazuk's Quotation Builder v2): "Rate card" builds lines from a service's rate card (base × X ×
// talent × period, plus add-ons); a price typed over the card's is a request, approved as any price request is.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Calculator, Clock, Download, FilePlus2, ListPlus, MoreHorizontal, Package, Plus, Repeat, RotateCcw, ScanBarcode, Search, Send, ShieldCheck, Trash2, UserPlus, UserRound, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { computeDocument, DOC_LABELS, formatAmount, formatDate, GST_RATES, STATES, stateFromGstin, stateLabel, toPaise, validGstin, type DocumentInput } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { initials, styles } from "../../../ui";
import { Drawer, DrawerFooter, DrawerSection, useIsPhone } from "../../../kit/drawer";
import { AddField, Disclosure } from "../../../kit/disclosure";
import { LineList, LineRow, OpenAmount, Stepper } from "../../../kit/line-row";
import { ChainBar, NextStep } from "../../../kit/next-step";
import { ReadyPath } from "./ready";
import { Menu, type MenuItem } from "../../../kit/menu";
import { LivePreview } from "../../preview";
import { useFormDraft } from "../../../kit/use-form-draft";
import { keptAgo, offerDraft } from "../../../lib/form-draft.mjs";
import { Versions } from "./issued";
import { PartyPicker, pickParty, type PartyChoice, type Picked } from "../../party-picker";
import type { Buyer, CatalogPick, DocumentData, Line, WarrantyOption } from "../../types";
import { chainSteps, EVENT, inr, plural, when } from "../chain";
import { rank } from "../../../lib/forgiving-search.mjs";
import { showField, type BillingSetup } from "../../settings/fields";
import css from "../documents.module.css";
import { DateField } from "../../../kit/date-field";
import { SelectField } from "../../../kit/select-field";
import { useWords } from "../../../org-code";
import { say } from "../../../lib/words.mjs";
// UX-BILLING (owner, 5 Nov 2026): the composer is built from My day's pieces (cards with a heading, figures, an empty
// state that says what to do), not page-only small-caps labels and dashed pills.
import { Card, EmptyState, SectionHeader, StatTile, StatTiles } from "../../../components/calm";
import { RateCardDrawer } from "./rate-card";
import { DiscountAdvice } from "./discount-advice";
import type { CardLine } from "../../../lib/rate-card.mjs";
import { useConfirm } from "../../../kit/dialogs";
// QUOTE-STRUCT (Kazuk, 16 Nov 2026: "Phase-wise Package Editing: Build Guide"): a package added here opens into its parts,
// grouped under the company's phases; each part is kept or removed, its quantity and price changed, swapped for a variant,
// or an item added to its phase, for this quotation only (the catalogue's package never changes). Changed parts carry a
// marker (added, removed, +1, price changed, swapped). The customer's copy prints phase by phase with one total.
import { changes, groupLines, opensIntoParts, packageLines, packageTotal, phaseOf, swapOptions, swapTo, type PhaseFields } from "../../../lib/quote-phases.mjs";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
const STATE_OPTIONS = Object.entries(STATES).sort((a, b) => a[1].name.localeCompare(b[1].name));
/** A line as the composer holds it: `open` = its amount is asked here (a ₹0 catalogue item or a line of our own), `filled`
 *  = someone gave it, `notNeeded` = it stays off the document. A quantity of 0 takes a line off too. `parentKey` = the line
 *  it is an add-on of (EST-1236). */
type Row = Line & { key: string; open: boolean; filled: boolean; notNeeded: boolean; parentKey: string | null };
/** BILLING-WL: "+2 years", "+18 months". */
const span = (m: number) => (m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`);
const warrantyName = (months: number, of: string) => `Extended warranty +${span(months)}: ${of}`.slice(0, 300);
/** EST-1236's line model, when the API has it: open charges and "not needed" are kept on the draft (off the PDF and the
 *  totals), and an add-on points at its parent line (by position when saved). Older APIs answer without these fields. */
type SavedLine = Line & { id?: string; open?: boolean; notNeeded?: boolean; parentLineId?: string | null; parentIndex?: number | null };
type AddOn = { itemId: string; name: string; price: number };
type ItemPick = CatalogPick & { addOns?: AddOn[]; open?: boolean };
type Draft = {
  issueDate: string; dueDate: string | null; validUntil: string | null; buyer: Buyer; placeOfSupply: string | null; reference: { project?: string; milestone?: string; po?: string };
  notes: string; terms: string | null; reverseCharge: boolean; zeroRated: boolean; roundTotal: boolean; templateId: string | null; rows: Row[];
  /** BILLING (4 Nov 2026): the client and contact picked from Clients and Contacts (null for a new client typed in), and
   *  the project location (the site), kept apart from the office / billing address the invoice prints. */
  clientId: string | null; contactPersonId: string | null; siteLocation: string | null;
  /** BILLING-WL: the Sales X-Ray lead the customer was picked from (linked to the client when the quotation is approved). */
  sxLeadId: string | null;
};
let seq = 0;
const rowOf = (l: SavedLine, item?: ItemPick): Row => {
  const open = l.role ? false : l.open ?? (item ? item.open ?? item.price === 0 : l.rate === 0);
  return { ...l, key: `r${++seq}`, open, filled: !open || l.rate > 0, notNeeded: !!l.notNeeded, parentKey: null };
};
const fromItem = (it: ItemPick, parentKey: string | null = null, where: PhaseFields = {}): Row => ({ ...rowOf({ itemId: it.id, description: it.name, details: it.description.slice(0, 1000), sac: it.sac, unit: it.unit, qty: 1,
  rate: it.included ? 0 : it.price, discount: 0, discountPercent: null, gstRate: it.gstRate, ...where, ...(it.included ? { role: "included" as const } : {}) }, it), parentKey });
/** QUOTE-STRUCT: the phase fields a line carries (only those set, so a company without phases saves plain lines). */
const phaseFieldsOf = (r: PhaseFields): PhaseFields => Object.fromEntries((["phase", "phaseOrder", "phaseGroup", "role", "packageId", "packageLabel", "packageDefault", "listRate"] as const)
  .filter((k) => r[k] !== undefined && r[k] !== null).map((k) => [k, r[k]])) as PhaseFields;
const onDocument = (r: Row) => !r.notNeeded && r.qty > 0 && !!r.description.trim();
const toLine = (r: Row): Line => ({ itemId: r.itemId, description: r.description, details: r.details, sac: r.sac, unit: r.unit, qty: r.qty, rate: r.rate, discount: r.discount, discountPercent: r.discountPercent, gstRate: r.gstRate,
  warrantyMonths: r.warrantyMonths ?? null, serials: r.serials ?? [], ...(r.rateCard ? { rateCard: r.rateCard } : {}), ...phaseFieldsOf(r) });
/** The saved lines. With EST-1236's API a "not needed" line stays on the draft and an add-on names its parent's position;
 *  without it, a line not needed is simply left out. */
function linesToSave(rows: Row[], v2: boolean): (Line & { open?: boolean; notNeeded?: boolean; parentIndex?: number | null })[] {
  const kept = rows.filter((r) => (v2 ? r.qty > 0 && !!r.description.trim() : onDocument(r)));
  if (!v2) return kept.map(toLine);
  return kept.map((r) => {
    const at = r.parentKey ? kept.findIndex((x) => x.key === r.parentKey) : -1;
    return { ...toLine(r), open: r.open, notNeeded: r.notNeeded, parentIndex: at >= 0 ? at : null };
  });
}

/** Rupees as typed ("1,18,000.50") ⇄ paise. Shown with Indian grouping once the field is left. */
function RupeeInput({ value, onChange, label, id }: { value: number; onChange: (paise: number) => void; label: string; id?: string }) {
  const [text, setText] = useState<string | null>(null);
  return <input id={id} inputMode="decimal" aria-label={label} value={text ?? formatAmount(value)} onFocus={() => setText(formatAmount(value).replace(/,/g, ""))}
    onChange={(e) => { setText(e.target.value); const p = toPaise(e.target.value); if (p !== null && p >= 0) onChange(p); }} onBlur={() => setText(null)} />;
}

export function DocumentEditor({ data, setup, canApproveOwnerQuote = false }: { data: DocumentData; setup?: BillingSetup; canApproveOwnerQuote?: boolean }) {
  const confirm = useConfirm();
  const show = (key: Parameters<typeof showField>[1]) => showField(setup, key);
  const router = useRouter();
  const words = useWords();
  const phone = useIsPhone();
  const d = data.document;
  const label = DOC_LABELS[d.docType];
  // KAZUK-FLOW (G2, Kazuk: "no approval anywhere; the salesperson decides the price"): with the company's approval off
  // the main button is Send (it numbers the draft; the issued page sends it), a price away from the catalogue is simply
  // the price, and nothing here speaks of approving. With it on (Willow Lane) every word and gate below stays as it was.
  const free = data.approvalMode === "none";
  const act = free ? "send" : "approve";
  const items = useMemo(() => new Map((data.items as ItemPick[]).map((i) => [i.id, i])), [data.items]);
  // EST-1236's line model is there when the API answers lines or items with `open`.
  const v2 = (data.lines as SavedLine[]).some((l) => l.open !== undefined) || (data.items as ItemPick[]).some((i) => i.open !== undefined);
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = data.lines as SavedLine[];
    const rows = saved.map((l) => rowOf({ itemId: l.itemId, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: l.qty, rate: l.rate,
      discount: l.discountPercent ? 0 : l.discount, discountPercent: l.discountPercent, gstRate: l.gstRate, open: l.open, notNeeded: l.notNeeded,
      warrantyMonths: l.warrantyMonths ?? null, serials: l.serials ?? [], rateCard: l.rateCard ?? null, catalogueRate: l.catalogueRate ?? null, ...phaseFieldsOf(l) }, l.itemId ? items.get(l.itemId) : undefined));
    // An add-on's parent, by the saved line's id (or its position).
    rows.forEach((r, n) => { const l = saved[n]; const at = l.parentLineId ? saved.findIndex((x) => x.id === l.parentLineId) : l.parentIndex ?? -1; r.parentKey = at >= 0 && rows[at] ? rows[at].key : null; });
    return {
    issueDate: d.issueDate, dueDate: d.dueDate, validUntil: d.validUntil, buyer: { address: [], ...d.buyer }, placeOfSupply: d.placeOfSupply,
    reference: d.reference ?? {}, notes: d.notes ?? "", terms: d.terms, reverseCharge: d.reverseCharge, zeroRated: d.zeroRated, roundTotal: d.roundTotal,
    templateId: d.templateId ?? data.template?.id ?? null,
    rows, clientId: d.clientId ?? null, contactPersonId: d.contactPersonId ?? null, siteLocation: d.siteLocation ?? null, sxLeadId: d.sxLeadId ?? null,
  }; });
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | string>("idle");
  const [panel, setPanel] = useState<null | { kind: "line"; key: string } | { kind: "client" } | { kind: "task" } | { kind: "approval" } | { kind: "rateCard" }>(null);
  const [finding, setFinding] = useState(false), [find, setFind] = useState("");
  // QUOTE-STRUCT: "+ Add to <phase>" searches the catalogue for that phase (its items first) and places the pick there.
  const [findPhase, setFindPhase] = useState<{ key: string | null; name: string; order: number | null } | null>(null);
  const version = useRef(0), savedVersion = useRef(0);
  const latest = useRef(draft), savingNow = useRef<Promise<boolean> | null>(null), acting = useRef(false);
  const change = (fn: (x: Draft) => Draft) => { latest.current = fn(latest.current); version.current++; setDraft(latest.current); setDirty(true); setSaving("idle"); };
  const set = (patch: Partial<Draft>) => change((x) => ({ ...x, ...patch }));
  const setRow = (key: string, patch: Partial<Row>) => change((x) => ({ ...x, rows: x.rows.map((r) => (r.key === key ? { ...r, ...patch }
    : r.parentKey === key && r.warrantyMonths && patch.qty !== undefined ? { ...r, qty: patch.qty } : r)) }));
  /** BILLING-WL: the extended warranty of a line: one add-on line with its months and price (null takes it off). */
  const setWarranty = (key: string, w: WarrantyOption | null) => change((x) => {
    const parent = x.rows.find((r) => r.key === key);
    if (!parent) return x;
    const rest = x.rows.filter((r) => !(r.parentKey === key && r.warrantyMonths));
    if (!w) return { ...x, rows: rest };
    const row: Row = { ...rowOf({ itemId: null, description: warrantyName(w.months, parent.description), details: "", sac: null, unit: "nos", qty: parent.qty, rate: w.price, discount: 0,
      discountPercent: null, gstRate: parent.gstRate, warrantyMonths: w.months, serials: [] }), open: false, filled: true, parentKey: key };
    const at = rest.findIndex((r) => r.key === key);
    return { ...x, rows: [...rest.slice(0, at + 1), row, ...rest.slice(at + 1)] };
  });
  const setBuyer = (patch: Partial<Buyer>) => change((x) => {
    const buyer = { ...x.buyer, ...patch };
    if (patch.gstin !== undefined && patch.gstin && validGstin(patch.gstin)) buyer.stateCode = stateFromGstin(patch.gstin);
    // The place of supply follows the buyer's state until someone sets it apart.
    const follows = !x.placeOfSupply || x.placeOfSupply === x.buyer.stateCode;
    return { ...x, buyer, placeOfSupply: follows ? buyer.stateCode ?? x.placeOfSupply : x.placeOfSupply };
  });
  const company = data.company;
  const sellerState = company.stateCode ?? "27";
  const template = data.templates.find((t) => t.id === draft.templateId) ?? data.template;
  const design = template?.design ?? {};
  // The logo the API draws: the template's own, else the organisation's PNG logo.
  const logoId = template?.logoId ?? (data.orgLogo ? "org-logo" : null);

  // What is saved (open amounts not given yet are kept at ₹0, so they come back as needed) and what the customer sees.
  const shown = draft.rows.filter((r) => onDocument(r) && r.filled);
  // VITALS-CLOSEOUT: with no GSTIN the company charges no GST on an invoice or credit note (the API saves it so too).
  const noGst = (d.docType === "invoice" || d.docType === "credit_note") && !String(company.gstin ?? "").trim();
  const lineOf = (r: Row): Line => noGst ? { ...toLine(r), gstRate: 0 } : toLine(r);
  const computed = useMemo(() => {
    try { return { ok: computeDocument({ lines: shown.map(lineOf), sellerState, placeOfSupply: draft.placeOfSupply, roundTotal: draft.roundTotal, reverseCharge: draft.reverseCharge, zeroRated: draft.zeroRated }), error: "" }; }
    catch (e) { return { ok: null, error: message(e) }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sellerState]);
  const lineTotal = (r: Row) => computed.ok?.lines[shown.indexOf(r)]?.total ?? null;
  const against = data.related.find((r) => r.id === d.againstId);
  const input: DocumentInput | null = useMemo(() => computed.ok ? {
    docType: d.docType, status: "draft", number: null, issueDate: draft.issueDate, dueDate: draft.dueDate, validUntil: draft.validUntil,
    seller: company, buyer: draft.buyer, placeOfSupply: draft.placeOfSupply, reference: draft.reference, against: against ? { number: against.number, date: against.issueDate } : null,
    lines: shown.map(lineOf), notes: draft.notes, terms: draft.terms, reverseCharge: draft.reverseCharge, zeroRated: draft.zeroRated, roundTotal: draft.roundTotal,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  } : null, [computed.ok, d.docType, draft, company, against]);

  // KAZUK-REST (1710): a line built from a rate card is priced by its card (the rate-card price the database worked out).
  const priceOf = (r: Row): ItemPick | undefined => { const it = r.itemId ? items.get(r.itemId) : undefined;
    // QUOTE-STRUCT: a part of a package is priced by the package (its default for that part) until it is swapped.
    if (it && r.packageDefault && r.packageDefault.itemId === r.itemId && typeof r.packageDefault.rate === "number") return { ...it, price: r.packageDefault.rate };
    return r.rateCard && it && typeof r.catalogueRate === "number" ? { ...it, price: r.catalogueRate, warrantyOptions: [], addOns: [] } : it; };
  // Price requests: a catalogue line whose price or discount differs from the catalogue's (never a ₹0 open amount).
  const deviations = draft.rows.filter((r) => !free && onDocument(r) && !r.role).flatMap((r) => {
    const it = priceOf(r);
    return it && it.price > 0 && !r.open && (r.rate !== it.price || (r.discountPercent ?? 0) > 0 || r.discount > 0) ? [{ r, it }] : [];
  });
  // KAZUK-V2 G14 (T28): with no approval step, a quotation priced under the catalogue gets the Sales Agent's advice on
  // what to offer first (never a wait). The discount is the catalogue lines' price against what is asked.
  const cut = free && d.docType === "quotation" ? draft.rows.filter((r) => onDocument(r) && !r.open && !r.role).reduce((acc, r) => {
    const it = priceOf(r);
    if (!it || !(it.price > 0)) return acc;
    const each = r.discountPercent ? Math.round(r.rate * (1 - r.discountPercent / 100)) : r.rate - (r.discount && r.qty ? Math.round(r.discount / r.qty) : 0);
    return { list: acc.list + it.price * r.qty, now: acc.now + each * r.qty, pkg: acc.pkg ?? (it.kind === "package" ? it.id : r.packageId ?? null) };
  }, { list: 0, now: 0, pkg: null as string | null }) : null;
  const needed = draft.rows.filter((r) => onDocument(r) && r.open && !r.filled).length;
  const gstinBad = !!draft.buyer.gstin && !validGstin(draft.buyer.gstin);
  // BILLING-WL: a tax invoice names one serial per unit of serialised stock (the database checks they are in stock).
  const serialised = (r: Row) => d.docType === "invoice" && !!data.inventoryEnabled && !!r.itemId && !!items.get(r.itemId)?.serialised;
  const unserialled = draft.rows.find((r) => onDocument(r) && serialised(r) && (r.serials ?? []).length !== r.qty);
  // KAZUK-FLOW config (G3): the fields the company's flow requires before a quotation is sent (a draft saves without them).
  const SEND_FIELDS: Record<string, string> = { name: "Company name", contactName: "Client name", phone: "Contact number", email: "Mail ID", siteLocation: "Project location" };
  const missingField = d.docType === "quotation" ? (data.sendRequired ?? []).find((k) => k in SEND_FIELDS
    && !String(k === "siteLocation" ? draft.siteLocation ?? "" : (draft.buyer as unknown as Record<string, unknown>)[k] ?? "").trim()) : undefined;
  // KAZUK-FLOW G9: an invoice made from the accepted quotation keeps its lines; a GST-registered client needs the address.
  const locked = !!data.linesLocked;
  const noAddress = d.docType === "invoice" && !!draft.buyer.gstin && !(draft.buyer.address ?? []).some((x) => x.trim());
  const blocked = !draft.buyer.name?.trim() ? `Choose the client to ${act}` : missingField ? `${SEND_FIELDS[missingField]} is needed to send`
    : noAddress ? "Add the client's billing address: they are GST-registered" : !draft.rows.some(onDocument) ? `Add a line to ${act}` : needed ? `Fill ${plural(needed, "amount")} to ${act}`
    : gstinBad ? `Fix the client's GSTIN to ${act}` : unserialled ? `Pick ${plural(unserialled.qty, "serial number")} for ${unserialled.description}` : computed.error || null;
  const approvalWait = !free && d.ownerApproval === "needed";
  const approvalBlocked = approvalWait && !canApproveOwnerQuote;
  // BILLING-WL (Akabod: the salesperson sends it to their manager or the owner, who approves it with one tap).
  const ap = data.approval ?? null, asked = ap?.asked ?? null;
  // KAZUK-REST (1710): where the company keeps approvals, a price away from a rate card is approved by leadership or the
  // person it was sent to (the database checks it too); anyone else sends it for approval. Without approvals it is theirs.
  const cardAsk = !!ap && ap.required && ap.lead === false && !asked?.forMe && deviations.some((x) => !!x.r.rateCard);
  const mustAsk = !!ap && ((ap.required && !ap.canApprove) || cardAsk);

  const body = () => ({ ...latest.current, rows: undefined, lines: linesToSave(latest.current.rows, v2) });
  function save(quiet: boolean): Promise<boolean> {
    if (savingNow.current) return savingNow.current;
    // One writer drains the newest snapshot. Actions join it, including edits made while an older POST is pending.
    const drain = async () => {
      while (savedVersion.current < version.current) {
        const at = version.current;
        setSaving("saving");
        try { await post(`erp/documents/${d.id}`, body()); }
        catch (e) {
          if (version.current !== at) continue;
          setSaving(message(e));
          if (!quiet) notify({ id: "erp-save", tone: "error", title: "Not saved", message: message(e) });
          return false;
        }
        savedVersion.current = at;
        if (version.current === at) { setDirty(false); setSaving("saved"); }
      }
      if (!quiet) notify({ id: "erp-save", tone: "success", title: "Draft saved", timeout: 2000 });
      return true;
    };
    savingNow.current = drain().finally(() => { savingNow.current = null; });
    return savingNow.current;
  }
  async function afterSave(action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; setBusy(true);
    try { if (await save(true)) await action(); }
    finally { acting.current = false; setBusy(false); }
  }
  // Saves itself 1.2 s after the last change, when what is typed can be saved (a half-typed GSTIN waits).
  useEffect(() => {
    if (!dirty || gstinBad || computed.error || busy) return;
    const t = setTimeout(() => { if (!acting.current) void save(true); }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, busy]);
  // KAZUK-GAPS (A12): what cannot be saved into the draft yet (a half-typed GSTIN, an amount that does not add up, a failed
  // save) is kept on the server as typed, so it can be picked up here again on any device; a good save forgets it.
  const unsaveable = dirty && (gstinBad || !!computed.error || (saving !== "idle" && saving !== "saving" && saving !== "saved"));
  const keep = useFormDraft<Draft>(`erp-${d.id}`, draft, { title: `${d.number ?? `New ${label.noun}`}${draft.buyer.name?.trim() ? ` · ${draft.buyer.name.trim()}` : ""}`, href: `/erp/documents/${d.id}`, enabled: unsaveable });
  const keptSome = useRef(false);
  useEffect(() => { if (keep.status === "kept") keptSome.current = true; }, [keep.status]);
  useEffect(() => { if (saving === "saved" && !dirty && keptSome.current) { keptSome.current = false; void keep.clear(); } }, [saving, dirty, keep]);
  const offer = keep.kept && offerDraft(keep.kept, d.updatedAt) ? keep.kept : null;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // BILLING (4 Nov 2026): a revision of an approved quotation keeps its number (revise again to change it later).
  const revisionOf = d.number && (d.revision ?? 0) > 0 ? d.number : null;
  async function approve() {
    if (approvalBlocked) return;
    const price = deviations.length || approvalWait ? " The price that is different from the catalogue is approved too." : "";
    // Approving what someone sent you is one tap; approving your own draft asks once, since it numbers it for good.
    const numbered = `It gets the next ${label.title.toLowerCase()} number. After that, you can't change it.`, kept = "It keeps the same number. The earlier copy stays in Versions.";
    if (!asked?.forMe && !(await confirm(free ? revisionOf ? { title: `Send revision ${d.revision} of ${revisionOf}?`, body: kept, confirmLabel: "Send revision" }
      : { title: `Send this ${label.noun}?`, body: numbered, confirmLabel: `Send ${label.noun}` }
      : revisionOf ? { title: `Approve revision ${d.revision} of ${revisionOf}?`, body: kept + price, confirmLabel: "Approve revision" }
      : { title: `Approve this ${label.noun}?`, body: numbered + price, confirmLabel: `Approve ${label.noun}` }))) return;
    await afterSave(async () => { try {
      const r = await post<{ number: string }>(`erp/documents/${d.id}/issue`, { draft: body() });
      setDirty(false);
      notify({ id: "erp-issue", tone: "success", title: `${label.title} ${r.number} ${free ? "numbered" : "approved"}`, message: asked && !asked.mine ? `${asked.by ?? "The person who asked"} is told, so they can send it.`
        : d.docType === "quotation" ? free ? "Send it by e-mail and WhatsApp below." : "Send it to the customer next." : "The PDF exactly as exported is filed with it.", timeout: 5000 });
      router.refresh();
    } catch (e) { notify({ id: "erp-issue", tone: "error", title: free ? "Not sent" : "Not approved", message: message(e) }); } });
  }
  /** A download is of the saved draft: unsaved changes are saved first. */
  async function download(format: "pdf" | "docx") {
    await afterSave(async () => {
    const a = document.createElement("a"); a.href = `/api/v0/erp/documents/${d.id}/${format}`; a.download = ""; document.body.append(a); a.click(); a.remove();
    });
  }
  // WL-QUOTE-LIVE: "✅ Approve" on the quotation's Telegram card opens it here with ?do=approve: the same confirm as the
  // Approve button, at once (the person's own sign-in decides; nothing is approved without their tap).
  const approveAsked = useRef(false);
  useEffect(() => {
    if (approveAsked.current || typeof window === "undefined" || approvalBlocked) return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("do") !== "approve") return;
    approveAsked.current = true;
    u.searchParams.delete("do"); window.history.replaceState(null, "", u.pathname + u.search + u.hash);
    void approve();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the page the link opened
  }, [approvalBlocked]);
  async function undoRevision() {
    if (acting.current || !(await confirm({ title: "Undo this revision?", body: `${revisionOf} goes back to its approved copy. The changes you made here are thrown away.`, confirmLabel: "Undo revision", danger: true }))) return;
    acting.current = true; setBusy(true);
    try { await savingNow.current?.catch(() => false); await post(`erp/documents/${d.id}/revise/undo`); setDirty(false); router.refresh(); }
    catch (e) { notify({ id: "erp-undo", tone: "error", title: "Not undone", message: message(e) }); }
    finally { acting.current = false; setBusy(false); }
  }
  async function remove() {
    if (acting.current || !(await confirm({ title: "Delete this draft?", body: "It has no number yet, so your books don't change.", confirmLabel: "Delete draft", danger: true }))) return;
    acting.current = true; setBusy(true);
    try {
      // Let an existing writer settle before deleting, even if the draft cannot be saved. Never start a save here.
      await savingNow.current?.catch(() => false);
      await post(`erp/documents/${d.id}/delete`); setDirty(false); router.push("/erp/documents");
    } catch (e) { notify({ id: "erp-del", tone: "error", title: "Not deleted", message: message(e) }); }
    finally { acting.current = false; setBusy(false); }
  }
  const phases = data.phases ?? [];
  const parts = data.packageParts ?? {};
  const add = (it: ItemPick, parentKey: string | null = null) => {
    // QUOTE-STRUCT: a package with priced parts opens into them, once (its parts are then edited below).
    if (it.kind === "package" && opensIntoParts(parts[it.id])) {
      if (draft.rows.some((r) => r.packageId === it.id)) notify({ id: "erp-pkg", tone: "info", title: `${it.name} is already on it`, message: "Change its parts below.", timeout: 3000 });
      else change((x) => ({ ...x, rows: [...x.rows, ...packageLines(it, parts[it.id], phases).map((l) => rowOf(l))] }));
      setFinding(false); setFind(""); setFindPhase(null);
      return;
    }
    // An item added to a phase goes in that phase ("+ Add to Phase 2"), else in its own.
    const where: PhaseFields = findPhase ? { phase: findPhase.name, phaseOrder: findPhase.order, phaseGroup: it.phase === findPhase.key ? phaseOf(phases, it).phaseGroup : null } : phaseOf(phases, it);
    const has = draft.rows.find((r) => r.itemId === it.id && !r.open && !r.rateCard && (r.phase ?? null) === (where.phase ?? null));
    if (has) setRow(has.key, { qty: Math.max(1, has.qty + (has.notNeeded ? 0 : 1)), notNeeded: false });
    else change((x) => ({ ...x, rows: [...x.rows, fromItem(it, parentKey, where)] }));
    setFinding(false); setFind(""); setFindPhase(null);
  };
  /** QUOTE-STRUCT: the package's parts back to its defaults on this quotation, or the package off it. */
  const resetPackage = (packageId: string) => change((x) => {
    const pkg = items.get(packageId);
    const at = x.rows.findIndex((r) => r.packageId === packageId);
    const rest = x.rows.filter((r) => r.packageId !== packageId);
    if (!pkg || !parts[packageId]) return { ...x, rows: rest };
    return { ...x, rows: [...rest.slice(0, at), ...packageLines(pkg, parts[packageId], phases).map((l) => rowOf(l)), ...rest.slice(at)] };
  });
  const removePackage = (packageId: string) => change((x) => ({ ...x, rows: x.rows.filter((r) => r.packageId !== packageId) }));
  /** Removing a line removes its add-ons with it. */
  const removeRow = (key: string) => change((x) => ({ ...x, rows: x.rows.filter((r) => r.key !== key && r.parentKey !== key) }));
  /** KAZUK-REST (1710): a rate card choice adds the service line and its add-on lines (add-ons of that line). */
  const addFromCard = (lines: { main: CardLine; addOns: CardLine[] }) => {
    const main = rowOf(lines.main);
    const extra = lines.addOns.map((a) => ({ ...rowOf(a), parentKey: main.key }));
    change((x) => ({ ...x, rows: [...x.rows, main, ...extra] }));
    setPanel(null);
  };
  const addOwn = () => {
    const r = rowOf({ itemId: null, description: "", details: "", sac: null, unit: null, qty: 1, rate: 0, discount: 0, discountPercent: null, gstRate: 18 });
    change((x) => ({ ...x, rows: [...x.rows, r] }));
    setPanel({ kind: "line", key: r.key });
  };

  // Add-ons: catalogue items not on the document yet. With nothing on it, packages first (a starting point); after that the
  // services and products that go with it, priced ones first; ₹0 ones are amounts to fill (installation, transport).
  const onIt = new Set([...draft.rows.filter((r) => onDocument(r) || (r.packageId && r.packageDefault)).map((r) => r.itemId), ...draft.rows.map((r) => r.packageId ?? null)]);
  const notOn = (data.items as ItemPick[]).filter((i) => !onIt.has(i.id));
  // The usual add-ons of what is on the document (EST-1236), each tied to its line: offered first.
  const addOnChips = (show("addOns") ? draft.rows : []).filter(onDocument).flatMap((r) => (r.itemId ? items.get(r.itemId)?.addOns ?? [] : [])
    .filter((a) => !onIt.has(a.itemId) && items.has(a.itemId)).map((a) => ({ a, parent: r })))
    .filter((x, n, all) => all.findIndex((y) => y.a.itemId === x.a.itemId) === n);
  const startEmpty = !draft.rows.some(onDocument);
  // QUOTE-STRUCT: a company that quotes by phase adds package after package (one per phase), so packages not on it yet stay first.
  const morePackages = startEmpty || phases.length > 0 || draft.rows.some((r) => r.packageId);
  const chips = (morePackages ? [...notOn.filter((i) => i.kind === "package"), ...notOn.filter((i) => i.kind !== "package")] : notOn.filter((i) => i.kind !== "package")
    .sort((a, b) => Number(b.price > 0) - Number(a.price > 0))).slice(0, phone ? 4 : 6);
  // BILLING-WL: "purepower 5", "Pure Power 5.0" and "pure power5.0" all find Pure Power 5.0; a code or a number finds its item.
  const found = findPhase && !find.trim() ? notOn.filter((i) => i.kind !== "package" && i.phase === findPhase.key).slice(0, 12)
    : rank(findPhase ? notOn.filter((i) => i.kind !== "package") : notOn, find, (i) => [i.name, i.code, i.sac, i.description.slice(0, 200)], 8);

  // The catalogue search; "+ Add to <phase>" opens it right under that phase (QUOTE-STRUCT).
  const finder = <div className={css.find}>
          {findPhase ? <p className={css.note}>Adding to <b>{findPhase.name}</b> · <button type="button" className={css.inlineLink} onClick={() => setFindPhase(null)}>add anywhere instead</button></p> : null}
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={findPhase ? `Search to add to ${findPhase.name}` : "Search the catalogue: name, code or SAC"} aria-label="Search the catalogue" autoFocus />
          <LineList label="Catalogue matches">
            {found.map((i) => <LineRow key={i.id} title={i.name} sub={[i.kind === "package" ? "Package" : i.kind === "product" ? "Product" : "Service", i.code, i.status === "draft" ? "draft" : null].filter(Boolean).join(" · ")}
              amount={i.price ? inr(i.price) : "Amount to fill"} amountSub={i.price ? `+ GST ${i.gstRate}%` : undefined} onOpen={() => add(i)} label={`Add ${i.name}`} />)}
            {!found.length ? findPhase && !find.trim() ? <LineRow title={`Everything in ${findPhase.name} is on it`} sub="Type a name to add anything else to this phase" tone="muted" />
              : <LineRow title="Nothing matches" sub="Try another word, or add something else" tone="muted" /> : null}
          </LineList>
        </div>;
  // QUOTE-STRUCT: the phase-wise view, once the company has phases or a line carries a phase, package or free role.
  const phased = phases.length > 0 || draft.rows.some((r) => r.phase || r.packageId || r.role);
  const pkgIds = [...new Set(draft.rows.filter((r) => r.packageId).map((r) => r.packageId as string))];
  const lineNet = (r: Row) => computed.ok?.lines[shown.indexOf(r)]?.taxable ?? null;
  function phasedRow(r: Row) {
    const it = r.itemId ? items.get(r.itemId) : undefined;
    const off = r.notNeeded || r.qty <= 0;
    const marks = changes(r);
    const net = lineNet(r);
    const dev = deviations.find((x) => x.r === r);
    const monthly = /^(month|months|mo|monthly)$/i.test(String(r.unit ?? "").trim());
    const sub = off ? (r.packageId && r.packageDefault ? "Removed: tick it to keep it" : r.notNeeded ? "Not needed: not on the document" : "Taken off: + adds it back")
      : r.role === "included" ? "Free with this package" : r.role === "to_quote" ? "Price comes later: not in the total yet" : r.role === "bonus" ? `Bonus · worth ${inr((r.listRate ?? 0) * r.qty)}`
      : r.open ? (r.filled ? `${inr(r.rate)} · changes by site` : "Changes by site · fill in or mark not needed")
      : [`${inr(r.rate)}${monthly ? " a month" : r.qty !== 1 ? " each" : ""}`, dev ? `${r.rateCard ? "rate card" : "catalogue"} ${inr(dev.it.price)}` : null, it?.kind === "package" ? "Package" : null].filter(Boolean).join(" · ");
    const shownMarks = marks.filter((m) => m !== "removed" || r.packageDefault);
    return <LineRow key={r.key} stack title={<>{r.description || "New line"}{shownMarks.length ? <span className={css.marks}>{shownMarks.map((m) =>
      <span key={m} className={css.mark} data-kind={m === "added" ? "added" : m === "removed" ? "removed" : undefined}>{m}</span>)}</span> : null}</>}
      sub={sub} tone={off ? "muted" : r.open && !r.filled ? "needed" : undefined} label={`${r.description || "New line"}: details`}
      onOpen={locked ? undefined : () => setPanel({ kind: "line", key: r.key })}
      before={r.packageId && !locked ? <input type="checkbox" className={css.keep} checked={!r.notNeeded} aria-label={`Keep ${r.description} on the ${label.noun}`}
        onChange={(e) => setRow(r.key, { notNeeded: !e.target.checked, ...(e.target.checked && r.qty <= 0 ? { qty: r.packageDefault?.qty || 1 } : {}) })} /> : undefined}
      end={off ? undefined : r.open ? <OpenAmount label={`${r.description || "Line"} amount before GST`} value={r.filled ? r.rate : null} notNeeded={r.notNeeded} placeholder="₹ before GST"
        onChange={(p) => setRow(r.key, p === null ? { rate: 0, filled: false } : { rate: p, filled: true })} onNotNeeded={(no) => setRow(r.key, { notNeeded: no })} />
        : locked ? <span className={css.note}>× {r.qty}</span> : <Stepper label={`${monthly ? "Months" : "Quantity"} of ${r.description || "this line"}`} value={r.qty} min={r.packageId ? 1 : 0} onChange={(n) => setRow(r.key, { qty: n })} />}
      amount={off ? undefined : r.role === "included" ? "Included" : r.role === "to_quote" ? "To be quoted" : r.role === "bonus" ? "₹0" : r.open && !r.filled ? undefined : net !== null ? inr(net) : undefined}
      amountSub={!off && !r.role && !(r.open && !r.filled) && net !== null ? "+ GST" : undefined} />;
  }

  const total = computed.ok?.total ?? 0;
  const status = approvalWait ? "A price differs from the catalogue: only the owner approves it" : blocked
    ?? (mustAsk ? asked ? `Waiting for ${asked.to ?? "approval"} since ${when(asked.at ?? d.updatedAt)}. You are told when it is approved.` : `Total ${inr(total)} · a manager or the owner approves it, then you send it`
      : asked?.forMe ? `${asked.by ?? "A colleague"} sent this for your approval ${when(asked.at ?? d.updatedAt)}` : null)
    ?? (deviations.length ? `Approving accepts ${plural(deviations.length, "price")} that differ${deviations.length === 1 ? "s" : ""} from the catalogue` : `Total ${inr(total)} · ${revisionOf ? `keeps ${revisionOf}` : `numbered when ${free ? "sent" : "approved"}`}`);
  // UX-BILLING (review, 5 Nov 2026): while something stops the approval, the main button does that thing (choose the
  // client, add a line, fill an amount, pick the serial numbers), never a grey disabled "Approve".
  const firstNeeded = draft.rows.find((r) => onDocument(r) && r.open && !r.filled);
  type Fix = "client" | "lines" | "amount" | "serials";
  const fix: { label: string; kind: Fix } | null = !draft.buyer.name?.trim() || gstinBad ? { label: gstinBad ? "Fix the GSTIN" : "Choose the client", kind: "client" }
    : missingField || noAddress ? { label: "Complete the client details", kind: "client" }
    : !draft.rows.some(onDocument) ? { label: data.items.length ? "Add from the catalogue" : "Add a line", kind: "lines" }
    : firstNeeded ? { label: needed > 1 ? `Fill ${needed} amounts` : "Fill the amount", kind: "amount" }
    : unserialled ? { label: "Pick the serial numbers", kind: "serials" } : null;
  function doFix(kind: Fix) {
    if (kind === "client") setPanel({ kind: "client" });
    else if (kind === "lines") { if (data.items.length) setFinding(true); else addOwn(); }
    else if (kind === "amount" && firstNeeded) document.querySelector<HTMLInputElement>(`[aria-label="${CSS.escape(`${firstNeeded.description || "Line"} amount before GST`)}"]`)?.focus();
    else if (kind === "serials" && unserialled) setPanel({ kind: "line", key: unserialled.key });
  }
  const main = fix && !approvalBlocked ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-primary="" disabled={busy} onClick={() => doFix(fix.kind)}>{fix.label}</button>
    : mustAsk ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-primary="" disabled={busy || !!blocked} onClick={() => setPanel({ kind: "approval" })}>
    {asked?.mine ? <><BellRing size={15} aria-hidden="true" />Remind {asked.to ?? "them"}</> : <><Send size={15} aria-hidden="true" />Send for approval</>}</button>
    : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-primary={busy || blocked || approvalBlocked ? undefined : ""} disabled={busy || !!blocked || approvalBlocked} onClick={() => void approve()}>
    {free ? <><Send size={15} aria-hidden="true" />{revisionOf ? "Send revision" : d.docType === "invoice" || d.docType === "credit_note" ? "Issue" : "Send"}</>
      : approvalBlocked ? "Only leadership can approve" : deviations.length || approvalWait ? "Approve the new price" : revisionOf ? "Approve revision" : "Approve"}</button>;
  const held = !!d.taskId && !["done", "accepted", "cancelled"].includes(String(data.task?.status ?? ""));
  const menu: MenuItem[] = [
    { key: "pdf", label: "Download PDF", icon: <Download size={15} aria-hidden="true" />, onSelect: () => void download("pdf") },
    { key: "docx", label: "Download Word file", icon: <Download size={15} aria-hidden="true" />, onSelect: () => void download("docx") },
    ...(!data.task && data.assignees.length ? [{ key: "task", label: "Give it to a person", icon: <UserPlus size={15} aria-hidden="true" />, onSelect: () => setPanel({ kind: "task" }) }] : []),
    ...(!free && ap && !mustAsk && ap.approvers.length ? [{ key: "ask", label: "Ask someone to approve", hint: "A manager or the owner, who is told", icon: <Send size={15} aria-hidden="true" />,
      onSelect: () => setPanel({ kind: "approval" }) }] : []),
    revisionOf ? { key: "undo", label: "Undo the revision", hint: "Back to the approved copy", icon: <Trash2 size={15} aria-hidden="true" />, danger: true, onSelect: () => void undoRevision(), separator: true }
      // QUOTE-STRUCT (Kazuk's gaps list: "cannot be deleted, and the page does not say which task"): the task is named, and
      // once it is done or cancelled the draft can be deleted (the API's draftHeldByTask rule).
      : { key: "delete", label: "Delete draft", icon: <Trash2 size={15} aria-hidden="true" />, danger: true, disabled: held,
        hint: held ? data.task ? `Kept for the task “${data.task.title.slice(0, 60)}”: finish or cancel it first` : "Kept for an open task" : undefined, onSelect: () => void remove(), separator: true },
  ];
  const more = <Menu label="More actions" items={menu} className={css.more} buttonLabel="More actions"><MoreHorizontal size={16} aria-hidden="true" /></Menu>;
  const savedText = saving === "saving" ? "Saving…" : saving === "saved" && !dirty ? "Saved" : saving !== "idle" && saving !== "saved" ? `Not saved: ${saving}` : dirty ? "Changes not saved yet" : "";
  const buyerState = draft.buyer.stateCode ? stateLabel(draft.buyer.stateCode) : null;
  const terms = draft.terms ?? String((design as { terms?: string }).terms ?? "");
  const editing = panel?.kind === "line" ? draft.rows.find((r) => r.key === panel.key) : undefined;

  const preview = <LivePreview label="Customer's copy" note={`${template?.name ?? "Default"} template · updates as you type`} design={design} doc={input} logoId={logoId} signatureId={template?.signatureId ?? null} bare={phone}
    actions={phone ? undefined : <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void download("pdf")}><Download size={13} aria-hidden="true" />PDF</button>} />;

  return <div className={css.composer} inert={busy || undefined}>
    <div className={css.write}>
      <div className={css.top}>
        {/* COMPANIES-MODEL (judge r4): a draft quotation with nothing made from it has no chain yet; the bar read as a
            second stepper above the 1-2-3-4 one. It shows once a proforma or an invoice exists. */}
        {d.docType === "quotation" && !data.related.some((r) => r.id !== d.id && r.status !== "cancelled") ? null
          : <ChainBar steps={chainSteps(d, data.related)} current={d.docType === "credit_note" ? "credit_note" : d.docType} />}
        <span className={css.draftChip}>{revisionOf ? `${revisionOf} R${(d.revision ?? 0) + 1} · revision ${d.revision} · keeps its number` : `Draft · numbered when ${free ? "sent" : "approved"}`}</span>
        <span className={css.note} aria-live="polite">{savedText}</span>
      </div>

      {offer ? <div className={css.keptNotice} role="status">
        <span>Changes from {keptAgo(offer.updatedAt)} were not saved into this {label.noun}. They were kept as typed, on this or another device.</span>
        <span className={css.keptActions}><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => { const kept = offer.data; keep.dismiss(); change(() => ({ ...kept, rows: kept.rows ?? [] })); }}>Restore them</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void keep.clear()}>Discard</button></span>
      </div> : null}
      <Card label={d.docType === "quotation" ? "Prepared for" : "Bill to"} flat>
        <SectionHeader icon={<UserRound size={16} aria-hidden="true" />} title={d.docType === "quotation" ? "Prepared for" : "Bill to"}
          hint={draft.buyer.name?.trim() ? undefined : "Who it is for"} />
        <LineList label="Client">
          <LineRow lead={<span className={css.avatar} aria-hidden="true">{draft.buyer.name ? initials(draft.buyer.name) : "?"}</span>} tone={draft.buyer.name?.trim() ? undefined : "needed"}
            title={draft.buyer.name?.trim() || "Choose the client"} label={`Client: ${draft.buyer.name || "not chosen"}. Open the billing details`}
            sub={draft.buyer.name?.trim() ? [draft.buyer.contactName, draft.buyer.phone, gstinBad ? "GSTIN not valid" : draft.buyer.gstin ? `GSTIN ${draft.buyer.gstin}` : null, draft.buyer.gstin && !gstinBad ? null : buyerState].filter(Boolean).join(" · ")
              : "Search Clients and Contacts, or type a new client"}
            onOpen={() => setPanel({ kind: "client" })} end={draft.clientId ? <span className={css.src}>In Clients</span> : draft.buyer.name?.trim() ? <span className={css.src}>New client</span> : undefined} />
        </LineList>
        {/* BILLING-EMAIL (Kazuk, 5 Nov 2026): the project location as its own line, apart from the billing address. */}
        {draft.buyer.name?.trim() && (draft.siteLocation || draft.buyer.address?.some(Boolean)) ? <p className={css.note} data-where="">
          {draft.siteLocation ? <>{say("{Project} location", words)}: <b>{draft.siteLocation}</b></> : null}
          {draft.siteLocation && draft.buyer.address?.some(Boolean) ? <br /> : null}
          {draft.buyer.address?.some(Boolean) ? <>Billing address: {draft.buyer.address.filter(Boolean).join(", ")}</> : null}</p> : null}
      </Card>

      <Card label="Lines" flat>
        <SectionHeader icon={<ListPlus size={16} aria-hidden="true" />} title={d.docType === "credit_note" ? "What is credited" : d.docType === "quotation" ? "What is quoted" : "What is billed"}
          count={draft.rows.filter(onDocument).length || undefined} />
        {phased && pkgIds.length ? <div className={css.pkgs} role="group" aria-label="Packages on this quotation">
          {pkgIds.map((pid) => {
            const own = draft.rows.filter((r) => r.packageId === pid);
            const name = items.get(pid)?.name ?? own[0]?.packageLabel?.split(" · ")[0] ?? "Package";
            const n = own.filter((r) => changes(r).length).length;
            return <div key={pid} className={css.pkg}><Package size={16} aria-hidden="true" />
              <span className={css.pkgText}><b>{name}</b><small>{inr(packageTotal(own, pid))} + GST · {own.filter((r) => !r.notNeeded).length} of {own.length} parts
                {n ? ` · ${plural(n, "change")}` : ""}</small></span>
              {!locked ? <span className={css.pkgActions}>
                {n && parts[pid] ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => resetPackage(pid)}><RotateCcw size={13} aria-hidden="true" />Undo</button> : null}
                <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void (async () => {
                  if (await confirm({ title: `Take ${name} off?`, body: `Its ${plural(own.length, "part")} come off this ${label.noun}. The package in the catalogue stays as it is.`, confirmLabel: "Take it off", danger: true })) removePackage(pid);
                })()}><Trash2 size={13} aria-hidden="true" />Take off</button></span> : null}
            </div>;
          })}
        </div> : null}
        {phased && draft.rows.length ? groupLines(draft.rows).map((g) => {
          const sum = g.lines.filter((r) => onDocument(r) && !r.role).reduce((n, r) => n + (lineNet(r) ?? 0), 0);
          const ph = g.key.startsWith("p:") ? phases.find((x) => x.name === g.name) : undefined;
          return <section key={g.key} className={css.phase} aria-label={g.name ?? "Lines"}>
            {g.name ? <div className={css.phaseHead}><b>{g.name}</b>{sum ? <small>{inr(sum)} before GST</small> : null}</div> : null}
            {g.subGroups.map((sg) => <div key={sg || "-"}>
              {sg ? <p className={css.subGroup}>{sg}</p> : null}
              <LineList label={sg || g.name || "Lines"}>{g.lines.filter((r) => (r.phaseGroup ?? "") === sg).map((r) => phasedRow(r))}</LineList>
            </div>)}
            {finding && findPhase && findPhase.name === g.name ? finder : !locked && g.key !== "bonus" && data.items.length ? <div className={`${css.adds} ${css.addTo}`}>
              <button type="button" className={css.chip} data-tone="add" onClick={() => { setFindPhase(g.key === "other" ? null : { key: ph?.key ?? null, name: g.name ?? "", order: g.lines[0]?.phaseOrder ?? null }); setFind(""); setFinding(true); }}>
                <Plus size={13} aria-hidden="true" /><span>Add to {g.key === "other" ? "the quotation" : g.name}</span></button></div> : null}
          </section>;
        }) : null}
        {!phased && draft.rows.length ? <LineList label="Lines">
          {draft.rows.map((r) => {
            const it = r.itemId ? items.get(r.itemId) : undefined;
            const off = r.notNeeded || r.qty <= 0;
            const t = lineTotal(r);
            const dev = deviations.find((x) => x.r === r);
            const parent = r.parentKey ? draft.rows.find((x) => x.key === r.parentKey) : undefined;
            const sub = off ? (r.notNeeded ? "Not needed: not on the document" : "Taken off: + adds it back")
              : r.open ? `${parent ? `Add-on for ${parent.description} · ` : ""}${it ? "Changes by site · fill in or mark not needed" : "Amount to fill in"}`
              : [r.warrantyMonths ? `+${span(r.warrantyMonths)} warranty` : parent ? `Add-on for ${parent.description}` : null, it?.kind === "package" ? "Package" : null, `${inr(r.rate)}${r.unit ? ` per ${r.unit}` : ""}`, `GST ${r.gstRate}%`, dev ? `${r.rateCard ? "rate card" : "catalogue"} ${inr(dev.it.price)}` : null, serialised(r) ? (r.serials ?? []).length === r.qty ? `S/N ${(r.serials ?? []).join(", ")}` : `${(r.serials ?? []).length} of ${r.qty} serial numbers picked` : null,
                !r.parentKey && it?.warrantyMonths ? `${span(it.warrantyMonths)} warranty` : null].filter(Boolean).join(" · ");
            return <LineRow key={r.key} stack title={r.description || "New line"} sub={sub} tone={off ? "muted" : (r.open && !r.filled) || (serialised(r) && (r.serials ?? []).length !== r.qty) ? "needed" : undefined}
              label={`${r.description || "New line"}: details`} onOpen={locked ? undefined : () => setPanel({ kind: "line", key: r.key })}
              lead={it?.kind === "package" ? <Package size={16} aria-hidden="true" /> : undefined}
              end={r.open ? <OpenAmount label={`${r.description || "Line"} amount before GST`} value={r.filled ? r.rate : null} notNeeded={r.notNeeded} placeholder="₹ before GST"
                onChange={(p) => setRow(r.key, p === null ? { rate: 0, filled: false } : { rate: p, filled: true })} onNotNeeded={(no) => setRow(r.key, { notNeeded: no })} />
                : locked ? <span className={css.note}>× {r.qty}</span> : <Stepper label={`Quantity of ${r.description || "this line"}`} value={r.qty} min={0} onChange={(n) => setRow(r.key, { qty: n })} />}
              amount={!off && t !== null && !(r.open && !r.filled) ? inr(t) : undefined} amountSub={!off && t !== null && !(r.open && !r.filled) ? "incl. GST" : undefined} />;
          })}
        </LineList> : draft.rows.length ? null : <EmptyState icon={<Package size={18} aria-hidden="true" />} title="Nothing on it yet"
          text={data.items.length ? "Tap a package or an item below to add it, or search the whole catalogue." : "Add a line of your own, or add services and products in Catalogue to pick them here."} />}

        {locked ? <p className={css.note} data-lines-locked="">The lines, quantities and prices come from {data.related.find((x) => x.id === d.sourceId)?.number ?? "the quotation"}
          {d.sourceRevision !== null && d.sourceRevision !== undefined ? ` V${d.sourceRevision + 1}` : ""} as accepted. To change them, make a new version of the quotation.</p>
        : data.items.length ? <div className={css.adds} role="group" aria-label="Add from the catalogue">
          <span className={css.addsLabel}>{startEmpty ? "Start from:" : "Add:"}</span>
          {addOnChips.map(({ a, parent }) => <button key={`addon-${a.itemId}`} type="button" className={css.chip} data-tone={a.price === 0 ? "needed" : undefined}
            onClick={() => add(items.get(a.itemId)!, parent.key)} title={`Add-on for ${parent.description}${a.price ? ` · ${inr(a.price)} + GST` : " · amount to fill in"}`}><Plus size={13} aria-hidden="true" /><span>{a.name}</span></button>)}
          {chips.filter((i) => !addOnChips.some((x) => x.a.itemId === i.id)).map((i) => <button key={i.id} type="button" className={css.chip} data-tone={i.price === 0 ? "needed" : undefined} onClick={() => add(i)}
            title={i.price ? `${inr(i.price)} + GST ${i.gstRate}%` : "Amount to fill in"}><Plus size={13} aria-hidden="true" /><span>{i.name}</span></button>)}
          <button type="button" className={css.chip} data-tone="quiet" aria-expanded={finding} onClick={() => { setFindPhase(null); setFinding(!finding); }}><Search size={13} aria-hidden="true" /><span>{finding ? "Close the catalogue" : "Whole catalogue"}</span></button>
          {data.rateCards?.length && d.docType !== "credit_note" ? <button type="button" className={css.chip} onClick={() => setPanel({ kind: "rateCard" })}><Calculator size={13} aria-hidden="true" /><span>Rate card</span></button> : null}
          <button type="button" className={css.chip} data-tone="quiet" onClick={addOwn}><FilePlus2 size={13} aria-hidden="true" /><span>Something else</span></button>
        </div> : <div className={css.adds}><button type="button" className={css.chip} onClick={addOwn}><Plus size={13} aria-hidden="true" /><span>Add a line</span></button>
          <span className={css.addsLabel}>The catalogue is empty: add services and products in Catalogue to pick them here.</span></div>}
        {finding && !findPhase ? finder : null}
      </Card>

      {asked?.forMe ? <div className={css.flag} data-tone="ok" role="status"><b>{asked.by ?? "A colleague"} asked you to approve this</b>
        <span>{asked.note ? `“${asked.note}” · ` : ""}One tap on Approve numbers it, and {asked.by ?? "they"} {asked.by ? "is" : "are"} told to send it.</span></div>
        : asked && mustAsk ? <div className={css.flag} data-tone="info" role="status"><b>Sent to {asked.to ?? "an approver"} for approval</b>
        <span>{when(asked.at ?? d.updatedAt)}{asked.note ? ` · “${asked.note}”` : ""}. You can keep editing; you are told once it is approved, then you send it.</span></div> : null}
      {approvalWait ? <div className={css.flag} role="status"><b>Waiting for the owner&apos;s approval</b><span>A price on this quotation differs from the catalogue. It goes out only after the owner approves it.</span></div>
        : d.ownerApproval === "approved" ? <div className={css.flag} data-tone="ok" role="status"><b>Price approved by the owner</b></div> : null}
      {deviations.map(({ r, it }) => {
        const each = r.discountPercent ? Math.round(r.rate * (1 - r.discountPercent / 100)) : r.rate - (r.discount && r.qty ? Math.round(r.discount / r.qty) : 0);
        const diff = it.price - each;
        return <div key={r.key} className={css.flag} role="status">
          <b>{r.description}: {inr(each)} asked</b>
          <span>{diff > 0 ? `${inr(diff)} below` : `${inr(-diff)} above`} the {r.rateCard ? "rate card" : "catalogue"}&apos;s {inr(it.price)}. Approving the {label.noun} approves this price; until then it is a request.</span>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setRow(r.key, { rate: it.price, discount: 0, discountPercent: null })}>Use the {r.rateCard ? "rate card" : "catalogue"} price</button>
        </div>;
      })}

      {cut && cut.list > cut.now ? <DiscountAdvice pct={((cut.list - cut.now) / cut.list) * 100} amount={cut.list - cut.now} packageId={cut.pkg} /> : null}

      {/* UX-POLISH-3: the way to done, with a live total and checks that tick (ready.tsx). */}
      <ReadyPath docId={d.id} noun={label.noun} finish={free ? (!revisionOf && (d.docType === "invoice" || d.docType === "credit_note") ? "Issue" : "Send") : "Approve"} total={computed.ok?.total ?? null} totalText={computed.ok ? inr(computed.ok.total) : null} checks={[
        { key: "client", label: "Client chosen", done: !!draft.buyer.name?.trim(), hint: "Who it is for" },
        { key: "gstin", label: "GSTIN valid or unregistered", done: !gstinBad, hint: "Fix the client's GSTIN" },
        { key: "lines", label: "At least one line", done: draft.rows.some(onDocument), hint: "From the catalogue or a milestone" },
        { key: "amounts", label: "Every amount filled", done: !needed, hint: needed ? `${plural(needed, "amount")} to fill` : undefined },
        ...(draft.rows.some((r) => onDocument(r) && serialised(r)) ? [{ key: "serials", label: "Serial numbers picked", done: !unserialled, hint: unserialled ? `For ${unserialled.description}` : undefined }] : []),
        { key: "totals", label: "Totals worked out", done: !!computed.ok && !computed.error, hint: computed.error || undefined },
      ]} />
      {computed.ok ? <StatTiles label="Totals">
        <StatTile label="Before GST" value={inr(computed.ok.taxable)} />
        <StatTile label={computed.ok.mode === "intra" ? "CGST + SGST" : "IGST"} value={inr(computed.ok.cgst + computed.ok.sgst + computed.ok.igst)} />
        <StatTile label="Total" value={inr(computed.ok.total)} sub={computed.ok.roundOff ? `round off ${formatAmount(computed.ok.roundOff)}` : "incl. GST"} />
        <StatTile label="To fill in" value={needed ? plural(needed, "amount") : "Nothing"} tone={needed ? "warn" : blocked ? undefined : "good"} sub={needed ? "or mark not needed" : blocked ? undefined : `ready to ${act}`} />
      </StatTiles> : computed.error ? <p className={css.note} role="alert">{computed.error}</p> : null}

      <Disclosure summary="More details" hint={d.docType === "quotation" ? "validity, terms, notes" : "dates, terms, notes"}>
        <div className={css.fields}>
          <label className={styles.field}>{label.date}<DateField value={draft.issueDate} max={data.today} onChange={(e) => set({ issueDate: e.target.value })} /></label>
          {d.docType === "quotation" ? show("validity") && <label className={styles.field}>Valid until<DateField value={draft.validUntil ?? ""} onChange={(e) => set({ validUntil: e.target.value || null })} /></label>
            : d.docType !== "credit_note" ? <label className={styles.field}>Due date<DateField value={draft.dueDate ?? ""} onChange={(e) => set({ dueDate: e.target.value || null })} /></label> : null}
          <label className={styles.field}>Place of supply<SelectField value={draft.placeOfSupply ?? ""} onChange={(e) => set({ placeOfSupply: e.target.value || null })}>
            {STATE_OPTIONS.map(([code, s]) => <option key={code} value={code}>{s.name} ({code})</option>)}</SelectField>
            <span className={css.hint}>{computed.ok ? computed.ok.mode === "intra" ? `Same state: CGST + ${computed.ok.split}` : "Another state: IGST" : "Decides CGST + SGST or IGST"}</span></label>
          <label className={styles.field}>Template<SelectField value={draft.templateId ?? ""} onChange={(e) => set({ templateId: e.target.value || null })}>
            {data.templates.filter((t) => t.docTypes.includes(d.docType)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField></label>
          {show("project") ? <div className={css.wide}><AddField label="Add a project" show={!!draft.reference.project}><label className={styles.field}>Project<input value={draft.reference.project ?? ""} onChange={(e) => set({ reference: { ...draft.reference, project: e.target.value } })} /></label></AddField></div> : null}
          {show("months") ? <div className={css.wide}><AddField label="Add a milestone" show={!!draft.reference.milestone}><label className={styles.field}>Milestone<input value={draft.reference.milestone ?? ""} onChange={(e) => set({ reference: { ...draft.reference, milestone: e.target.value } })} /></label></AddField></div> : null}
          {show("poNumber") ? <div className={css.wide}><AddField label="Add a PO or reference" show={!!draft.reference.po}><label className={styles.field}>PO / reference<input value={draft.reference.po ?? ""} onChange={(e) => set({ reference: { ...draft.reference, po: e.target.value } })} /></label></AddField></div> : null}
          <div className={css.wide}><AddField label="Add a note for the customer" show={!!draft.notes}><label className={styles.field}>Note for the customer<textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label></AddField></div>
        </div>
        <div className={css.checks}>
          <label className={css.check}><input type="checkbox" checked={draft.roundTotal} onChange={(e) => set({ roundTotal: e.target.checked })} />Round the total to the rupee</label>
          {d.docType !== "quotation" ? <label className={css.check}><input type="checkbox" checked={draft.reverseCharge} onChange={(e) => set({ reverseCharge: e.target.checked })} />Reverse charge</label> : null}
          {draft.placeOfSupply === "96" ? <label className={css.check}><input type="checkbox" checked={draft.zeroRated} onChange={(e) => set({ zeroRated: e.target.checked })} />Export under LUT (zero-rated)</label> : null}
          <label className={css.check}><input type="checkbox" checked={draft.terms === null} onChange={(e) => set({ terms: e.target.checked ? null : String((design as { terms?: string }).terms ?? "") })} />The template&apos;s terms</label>
        </div>
        {draft.terms !== null ? <label className={styles.field}>Terms for this {label.noun}<textarea rows={3} value={draft.terms} onChange={(e) => set({ terms: e.target.value })} /></label>
          : terms ? <p className={css.note}>Terms: {terms.length > 160 ? `${terms.slice(0, 160)}…` : terms}</p> : null}
        {data.task ? <p className={css.note}>Task <b>{data.task.title}</b> · {data.task.assignee ?? "unassigned"} · {data.task.status}{data.task.dueOn ? ` · due ${formatDate(data.task.dueOn)}` : ""}. It is done when this {label.noun} is {free ? "sent" : "approved"}.</p> : null}
      </Disclosure>

      {data.versions?.length ? <Versions id={d.id} number={d.number} revision={d.revision ?? 0} versions={data.versions} free={free} /> : null}

      <div className={css.deskOnly}><NextStep status={status} tone={blocked || approvalWait ? "warning" : "info"} primary={main} secondary={more} /></div>
    </div>

    <div className={css.view}>{phone ? null : preview}</div>

    {phone ? <Drawer title="Customer's copy" persistent snap="peek" onClose={() => undefined} noAutofocus
      context={<span className={css.sheetTotal}>Total <b>{inr(total)}</b>{needed ? ` · ${plural(needed, "amount")} to fill` : ""}</span>}
      panes={[
        { key: "preview", label: "Preview", content: preview },
        { key: "terms", label: "Terms", content: <DrawerSection title="Terms">{terms ? <p className={css.sheetTerms}>{terms}</p> : <p className={css.note}>The template has no terms.</p>}
          {draft.notes ? <p className={css.sheetTerms}>{draft.notes}</p> : null}</DrawerSection> },
        { key: "activity", label: "Activity", count: data.events.length || undefined, content: <DrawerSection title="Activity"><ol className={css.activity}>
          {data.events.map((e, i) => <li key={i}><b>{free && e.kind === "issued" ? "Numbered" : EVENT[e.kind] ?? e.kind}</b><span>{when(e.at)}{e.actor ? ` · ${e.actor}` : ""}</span></li>)}</ol></DrawerSection> },
      ]}
      footer={<DrawerFooter tone="info" status={status.startsWith(`Total ${inr(total)} · `) ? revisionOf ? `Keeps ${revisionOf}` : `Gets its number when ${free ? "sent" : "approved"}` : status} primary={main}>{more}</DrawerFooter>} /> : null}

    {panel?.kind === "client" ? <ClientDrawer noun={label.noun} quotation={d.docType === "quotation"} draft={draft} gstinBad={gstinBad} setBuyer={setBuyer} onClose={() => setPanel(null)}
      onPicked={(picked) => change((x) => {
        const buyer = { address: [], ...picked.buyer } as Buyer;
        const follows = !x.placeOfSupply || x.placeOfSupply === x.buyer.stateCode;
        return { ...x, buyer, clientId: picked.clientId, contactPersonId: picked.contactPersonId, siteLocation: picked.siteLocation ?? x.siteLocation, sxLeadId: picked.sxLeadId ?? null,
          placeOfSupply: follows ? buyer.stateCode ?? x.placeOfSupply : x.placeOfSupply };
      })}
      onNew={(name) => change((x) => ({ ...x, buyer: { name, address: [], stateCode: x.buyer.stateCode ?? null }, clientId: null, contactPersonId: null, sxLeadId: null }))}
      onSite={(siteLocation) => set({ siteLocation })} /> : null}

    {editing ? <LineDrawer free={free} row={editing} item={priceOf(editing)} total={lineTotal(editing)} noun={label.noun} discount={show("discount")}
      warranty={!editing.parentKey && !editing.warrantyMonths && (show("warranty") || !!(editing.itemId && items.get(editing.itemId)?.warrantyOptions?.length) || draft.rows.some((r) => r.parentKey === editing.key && !!r.warrantyMonths))}
      extension={draft.rows.find((r) => r.parentKey === editing.key && !!r.warrantyMonths) ?? null} onWarranty={(w) => setWarranty(editing.key, w)}
      serials={serialised(editing) ? data.stockSerials?.[editing.itemId!] ?? [] : null}
      onChange={(patch) => setRow(editing.key, patch)} onClose={() => setPanel(null)}
      // QUOTE-STRUCT: a package's part is taken off by unticking it (it stays, greyed, to be ticked back); anything else is removed.
      onRemove={() => { if (editing.packageId && editing.packageDefault) setRow(editing.key, { notNeeded: true }); else removeRow(editing.key); setPanel(null); }}
      phased={phased} swaps={phased ? swapOptions(editing, data.items as ItemPick[]) : []} onSwap={(o) => setRow(editing.key, swapTo(editing, o as ItemPick & { kind: string }))} /> : null}

    {panel?.kind === "approval" && ap ? <ApprovalDrawer id={d.id} noun={label.noun} approval={ap} beforeSend={() => save(true)} body={body} onClose={() => setPanel(null)} /> : null}

    {panel?.kind === "rateCard" && data.rateCards?.length ? <RateCardDrawer cards={data.rateCards} noun={label.noun} onAdd={addFromCard} onClose={() => setPanel(null)} /> : null}

    {panel?.kind === "task" ? <TaskDrawer data={data} noun={label.noun} beforeSave={() => save(true)} onClose={() => setPanel(null)} /> : null}
  </div>;
}

/** "Prepared for" / "Bill to" (BILLING, owner 4 Nov 2026): find the client in Clients and Contacts or type a new one; the
 *  name, contact, phone and e-mail are enough to send. The project location (the site) is kept apart from the office /
 *  billing address the invoice prints, and the GSTIN is asked only when the billing includes GST. */
function ClientDrawer({ noun, quotation, draft, gstinBad, setBuyer, onPicked, onNew, onSite, onClose }: { noun: string; quotation: boolean; draft: Draft; gstinBad: boolean;
  setBuyer: (patch: Partial<Buyer>) => void; onPicked: (p: Picked) => void; onNew: (name: string) => void; onSite: (site: string | null) => void; onClose: () => void }) {
  const [finding, setFinding] = useState(!draft.buyer.name?.trim());
  const [gst, setGst] = useState(!!draft.buyer.gstin);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const b = draft.buyer;
  // BILLING-WL (Akabod: no double entry, names editable without duplicates): a customer typed in whose phone or e-mail a
  // profile already has is offered that profile.
  const [twins, setTwins] = useState<{ key: string; list: { kind: "client" | "contact"; id: string; name: string; why: string }[] } | null>(null);
  const digits = (b.phone ?? "").replace(/\D/g, ""), mail = (b.email ?? "").trim();
  const twinKey = !draft.clientId && !draft.contactPersonId && (digits.length >= 10 || /.+@.+\..+/.test(mail)) ? `${digits.slice(-10)}|${mail.toLowerCase()}` : "";
  useEffect(() => {
    if (!twinKey) return;
    let gone = false;
    const t = setTimeout(() => {
      fetch(`/api/v0/erp/parties/twins?${new URLSearchParams({ phone: digits, email: mail })}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((x) => {
        if (gone || !x) return;
        type Twin = { id: string; name: string; why: string };
        setTwins({ key: twinKey, list: [...(x.clients as Twin[]).map((c) => ({ ...c, kind: "client" as const })), ...(x.contacts as Twin[]).map((c) => ({ ...c, kind: "contact" as const }))].slice(0, 3) });
      }).catch(() => undefined);
    }, 400);
    return () => { gone = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twinKey]);
  const twinList = twinKey && twins?.key === twinKey ? twins.list : [];
  async function pick(choice: PartyChoice) {
    setBusy(true); setError(null);
    try { const p = await pickParty(choice); onPicked(p); setGst(!!p.buyer.gstin); setFinding(false); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const missing = !b.name?.trim() ? "Name the client" : !b.phone?.trim() && !b.email?.trim() ? "Add a phone or e-mail to send it" : null;
  return <Drawer title={quotation ? "Prepared for" : "Bill to"} context={draft.clientId ? "From Clients" : b.name?.trim() ? "New client: booked in Clients when the invoice is issued" : `Who the ${noun} is for`} onClose={onClose} snap="full"
    footer={<DrawerFooter status={error ?? (gstinBad ? "Not a valid GSTIN: check the 15 characters" : finding ? null : missing)} primary={finding
      ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setFinding(false)} disabled={busy}>Type the client instead</button>
      : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>Done</button>}>
      {!finding ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setFinding(true)}><Search size={14} aria-hidden="true" />Find in Clients</button> : null}
    </DrawerFooter>}>
    {finding ? <DrawerSection title="Clients and Contacts">
      <PartyPicker autoFocus busy={busy} selectedClient={draft.clientId} selectedContact={draft.contactPersonId} selectedLead={draft.sxLeadId} onPick={(choice) => void pick(choice)}
        onNew={(name) => { onNew(name); setGst(false); setFinding(false); }} />
    </DrawerSection> : <>
      {twinList.length ? <div className={css.flag} data-tone="info" role="status"><b>Already in Pulse</b>
        <span>{twinList.map((t) => `${t.name} (${t.kind}, same ${t.why === "email" ? "e-mail" : "phone"})`).join(", ")}. Use that profile so the customer is not added twice.</span>
        <div className={styles.inline}>{twinList.map((t) => <button key={t.kind + t.id} type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy}
          onClick={() => void pick(t.kind === "client" ? { client: t.id } : { contact: t.id })}>Use {t.name}</button>)}</div></div> : null}
      <DrawerSection title="Client">
        <div className={css.fields}>
          <label className={`${styles.field} ${css.wide}`}>Name (legal name for the invoice)<input value={b.name ?? ""} onChange={(e) => setBuyer({ name: e.target.value })} placeholder="Business or person" data-autofocus={b.name ? undefined : ""} />
            {draft.clientId || draft.contactPersonId ? <span className={css.hint}>Fix the spelling or add “Mr.” freely: the quotation stays on the same profile, nobody is added twice</span> : null}</label>
          <label className={styles.field}>Contact person<input value={b.contactName ?? ""} onChange={(e) => setBuyer({ contactName: e.target.value })} placeholder="Who you deal with" /></label>
          <label className={styles.field}>Phone<input type="tel" value={b.phone ?? ""} onChange={(e) => setBuyer({ phone: e.target.value })} /></label>
          <label className={styles.field}>E-mail<input type="email" value={b.email ?? ""} onChange={(e) => setBuyer({ email: e.target.value })} /></label>
        </div>
      </DrawerSection>
      <DrawerSection title="Where">
        <div className={css.fields}>
          <label className={`${styles.field} ${css.wide}`}>Project location<input value={draft.siteLocation ?? ""} onChange={(e) => onSite(e.target.value || null)} placeholder="The site, e.g. Moshi, Pune" />
            <span className={css.hint}>Where the project is: shown on the map, not printed as the billing address</span></label>
          <label className={`${styles.field} ${css.wide}`}>Billing address (the office; optional)<textarea rows={2} value={(b.address ?? []).join("\n")} onChange={(e) => setBuyer({ address: e.target.value.split("\n").slice(0, 6) })} placeholder="Printed on the document as the billing address" /></label>
          <label className={styles.field}>State (place of supply)<SelectField value={b.stateCode ?? ""} disabled={gst && !!b.gstin && !gstinBad} onChange={(e) => setBuyer({ stateCode: e.target.value || null })}>
            <option value="">Choose…</option>{STATE_OPTIONS.map(([code, st]) => <option key={code} value={code}>{st.name} ({code})</option>)}</SelectField></label>
        </div>
      </DrawerSection>
      <DrawerSection title="GST">
        <label className={css.check}><input type="checkbox" checked={gst} onChange={(e) => { setGst(e.target.checked); if (!e.target.checked) setBuyer({ gstin: null }); }} />The client is GST-registered (bill with their GSTIN)</label>
        {gst ? <label className={styles.field}>Client&apos;s GSTIN<input value={b.gstin ?? ""} onChange={(e) => setBuyer({ gstin: e.target.value.toUpperCase() || null })} maxLength={15} placeholder="15 characters" aria-invalid={gstinBad || undefined} />
          <span className={`${css.hint} ${gstinBad ? css.bad : b.gstin ? css.good : ""}`}>{gstinBad ? "Not a valid GSTIN" : b.gstin ? `Valid · ${stateLabel(stateFromGstin(b.gstin)!)}` : "From their GST certificate"}</span></label>
          : <p className={css.note}>No GSTIN: billed as a consumer or an unregistered business.</p>}
      </DrawerSection>
    </>}
  </Drawer>;
}

/** One line's details: what it is, how many, its price (the catalogue's, or a request for another), tax. */
function LineDrawer({ free = false, row, item, total, noun, discount, warranty, extension, onWarranty, serials, onChange, onRemove, onClose, phased = false, swaps = [], onSwap }: { free?: boolean; row: Row; item?: CatalogPick; total: number | null; noun: string; discount: boolean;
  warranty: boolean; extension: Row | null; onWarranty: (w: WarrantyOption | null) => void; serials: string[] | null; onChange: (p: Partial<Row>) => void; onRemove: () => void; onClose: () => void;
  /** QUOTE-STRUCT: the phase-wise composer: how the line prints (Included, To be quoted, bonus) and the variants it can swap for. */
  phased?: boolean; swaps?: CatalogPick[]; onSwap?: (it: CatalogPick) => void }) {
  const fixed = !!item && item.price > 0 && !row.open;
  const [asking, setAsking] = useState(fixed && (row.rate !== item!.price || !!row.discountPercent || !!row.discount));
  // BILLING-WL: the extended warranty (the catalogue's extensions, or one of its own) and the serial numbers sold.
  const options = item?.warrantyOptions ?? [];
  const [own, setOwn] = useState<{ months: string; price: number } | null>(extension && !options.some((o) => o.months === extension.warrantyMonths && o.price === extension.rate)
    ? { months: String(extension.warrantyMonths), price: extension.rate } : null);
  const [scan, setScan] = useState("");
  const picked = row.serials ?? [];
  const addSerial = (raw: string) => {
    const sn = raw.trim().replace(/\s+/g, "").toUpperCase();
    if (sn && !picked.includes(sn)) onChange({ serials: [...picked, sn] });
    setScan("");
  };
  return <Drawer title={row.description || "New line"} context={total !== null ? `${inr(total)} incl. GST` : row.open ? "Amount to fill" : undefined} onClose={onClose} snap="half" noAutofocus={!!row.description}
    footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>Done</button>}>
      <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnDanger}`} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />Remove</button></DrawerFooter>}>
    <DrawerSection title="What it is">
      <label className={styles.field}>Name on the {noun}<input value={row.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="What is billed" data-autofocus={row.description ? undefined : ""} /></label>
      <AddField label="Add details (deliverables, period)" show={!!row.details}><label className={styles.field}>Details<textarea rows={3} value={row.details} onChange={(e) => onChange({ details: e.target.value })} /></label></AddField>
    </DrawerSection>
    <DrawerSection title="How many" aside={row.unit ?? undefined}>
      <Stepper label="Quantity" value={row.qty} min={0} onChange={(n) => onChange({ qty: n })} />
      {item?.onHand !== undefined && item?.onHand !== null ? <p className={css.note}>{item.onHand} {item.unit} in stock</p> : null}
    </DrawerSection>
    {serials ? <DrawerSection title="Serial numbers" aside={`${picked.length} of ${row.qty}`}>
      <p className={css.note}>One per unit sold: they leave the stock when the invoice is approved.</p>
      {picked.length ? <div className={css.adds} role="group" aria-label="Picked serial numbers">{picked.map((sn) => <button key={sn} type="button" className={css.chip} aria-pressed="true"
        onClick={() => onChange({ serials: picked.filter((x) => x !== sn) })} aria-label={`Remove serial ${sn}`}><X size={13} aria-hidden="true" /><span>{sn}</span>
        {!serials.includes(sn) ? <small>not in stock</small> : null}</button>)}</div> : null}
      <label className={styles.field}>Scan or type a serial number<span className={styles.inline}>
        <input value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSerial(scan); } }} placeholder="e.g. PP5-24-00117" autoCapitalize="characters" />
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => addSerial(scan)} disabled={!scan.trim()}><ScanBarcode size={13} aria-hidden="true" />Add</button></span></label>
      {serials.filter((sn) => !picked.includes(sn)).length ? <div className={css.adds} role="group" aria-label="Serial numbers in stock">
        <span className={css.addsLabel}>In stock:</span>
        {serials.filter((sn) => !picked.includes(sn)).slice(0, 24).map((sn) => <button key={sn} type="button" className={css.chip} disabled={picked.length >= row.qty}
          onClick={() => addSerial(sn)} aria-label={`Pick serial ${sn}`}><Plus size={13} aria-hidden="true" /><span>{sn}</span></button>)}</div>
        : <p className={css.note}>No unit of this item is in stock with a serial number. Record the stock in on the catalogue item first.</p>}
    </DrawerSection> : null}
    {warranty ? <DrawerSection title="Extended warranty" aside={item?.warrantyMonths ? `${span(item.warrantyMonths)} standard` : undefined}>
      <div className={css.radios} role="radiogroup" aria-label="Extended warranty">
        <label className={css.radio}><input type="radio" name="erp-warranty" checked={!extension && !own} onChange={() => { setOwn(null); onWarranty(null); }} />
          {item?.warrantyMonths ? `Standard only (${span(item.warrantyMonths)})` : "No extended warranty"}</label>
        {options.map((o) => <label key={o.months} className={css.radio}><input type="radio" name="erp-warranty" checked={!own && extension?.warrantyMonths === o.months && extension.rate === o.price}
          onChange={() => { setOwn(null); onWarranty(o); }} /><ShieldCheck size={14} aria-hidden="true" />+{span(o.months)} · {inr(o.price)}{row.qty > 1 ? " each" : ""} + GST</label>)}
        <label className={css.radio}><input type="radio" name="erp-warranty" checked={!!own} onChange={() => setOwn({ months: String(extension?.warrantyMonths ?? 12), price: extension?.rate ?? 0 })} />Another length or price</label>
      </div>
      {own ? <div className={css.fields}>
        <label className={styles.field}>Months added<input inputMode="numeric" value={own.months} onChange={(e) => setOwn({ ...own, months: e.target.value.replace(/\D/g, "").slice(0, 3) })} /></label>
        <label className={styles.field}>Price before GST ₹<RupeeInput label="Extended warranty price" value={own.price} onChange={(price) => setOwn({ ...own, price })} /></label>
        <div><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!(Number(own.months) >= 1 && Number(own.months) <= 600)}
          onClick={() => onWarranty({ months: Number(own.months), price: own.price })}><ShieldCheck size={13} aria-hidden="true" />{extension ? "Update the warranty" : "Add the warranty"}</button></div>
      </div> : null}
      {extension ? <p className={css.note}>On the {noun} as its own line: {extension.description} · {inr(extension.rate)}{extension.qty > 1 ? ` × ${extension.qty}` : ""} + GST {extension.gstRate}%</p> : null}
    </DrawerSection> : null}
    {swaps.length && onSwap ? <DrawerSection title="Swap for another item" help="Another choice in the same phase. The quantity stays.">
      <div className={css.adds} role="group" aria-label="Swap for">{swaps.map((o) => <button key={o.id} type="button" className={css.chip} onClick={() => onSwap(o)}>
        <Repeat size={13} aria-hidden="true" /><span>{o.name}</span><small>{o.included ? "Included" : o.price ? inr(o.price) : "To be quoted"}</small></button>)}</div>
    </DrawerSection> : null}
    {phased ? <DrawerSection title={`On the customer's copy`}>
      {row.role ? <>
        <p className={css.note}>{row.role === "to_quote" ? "Prints “To be quoted” and adds nothing to the total." : row.role === "included" ? `Prints “Included”: free with this ${noun}.`
          : `A bonus: worth ${inr((row.listRate ?? 0) * row.qty)}, printed struck through at ₹0.`}</p>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { const p = item?.price && item.price > 0 ? item.price : row.listRate ?? 0;
          onChange({ role: null, listRate: null, rate: p, open: !(p > 0), filled: p > 0 }); }}>{row.role === "to_quote" ? "Give it a price" : "Charge for it"}</button>
      </> : <><p className={css.note}>Not sure of the price yet? It can print “To be quoted” and add nothing to the total.</p>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onChange({ role: "to_quote", rate: 0, open: false, filled: true, discount: 0, discountPercent: null })}>
        <Clock size={13} aria-hidden="true" />Price it later</button></>}
    </DrawerSection> : null}
    {row.role ? null : <DrawerSection title="Price before GST">
      {row.open ? <OpenAmount label="Amount before GST" value={row.filled ? row.rate : null} notNeeded={row.notNeeded} placeholder="₹ before GST"
        onChange={(p) => onChange(p === null ? { rate: 0, filled: false } : { rate: p, filled: true })} onNotNeeded={(no) => onChange({ notNeeded: no })} />
        : fixed ? <>
          <p className={css.price}><b>{inr(item!.price)}</b><span className={css.hint}>{row.rateCard ? "rate card price" : "catalogue price"}{row.unit && row.unit !== "nos" ? ` per ${row.unit}` : " each"}</span></p>
          {asking ? <>
            <div className={css.fields}>
              <label className={styles.field}>Price you want to offer ₹<RupeeInput label="Price you want to offer" value={row.rate} onChange={(rate) => onChange({ rate })} /></label>
              {discount ? <label className={styles.field}>Or a discount %<input inputMode="decimal" value={row.discountPercent ?? ""} onChange={(e) => onChange({ discountPercent: e.target.value === "" ? null : Number(e.target.value), discount: 0 })} /></label> : null}
            </div>
            {free ? <p className={css.note}>You decide the price: the {noun} goes out with it.</p> : <p className={css.note}>A different price is a request: the {noun} goes out once it is approved.</p>}
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { onChange({ rate: item!.price, discount: 0, discountPercent: null }); setAsking(false); }}>Use the {row.rateCard ? "rate card" : "catalogue"} price</button>
          </> : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setAsking(true)}>{free ? "Offer a different price" : "Ask for a different price"}</button>}
        </>
        : <div className={css.fields}><label className={styles.field}>Rate ₹<RupeeInput label="Rate" value={row.rate} onChange={(rate) => onChange({ rate, filled: true })} /></label>
          {discount ? <label className={styles.field}>Discount %<input inputMode="decimal" value={row.discountPercent ?? ""} onChange={(e) => onChange({ discountPercent: e.target.value === "" ? null : Number(e.target.value), discount: 0 })} /></label> : null}</div>}
    </DrawerSection>}
    <Disclosure summary="Tax" hint={`${row.sac ? `SAC/HSN ${row.sac} · ` : ""}GST ${row.gstRate}%`}>
      <div className={css.fields}>
        <label className={styles.field}>SAC/HSN<input value={row.sac ?? ""} inputMode="numeric" maxLength={8} onChange={(e) => onChange({ sac: e.target.value.replace(/\D/g, "") || null })} /></label>
        <label className={styles.field}>GST<SelectField value={row.gstRate} onChange={(e) => onChange({ gstRate: Number(e.target.value) })}>{GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}</SelectField></label>
      </div>
    </Disclosure>
  </Drawer>;
}

/** Gives the draft to one person as a task (done when it is approved). */
function TaskDrawer({ data, noun, beforeSave, onClose }: { data: DocumentData; noun: string; beforeSave: () => Promise<boolean>; onClose: () => void }) {
  const router = useRouter();
  const [who, setWho] = useState(""), [due, setDue] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function give() {
    setBusy(true); setError(null);
    try {
      if (!(await beforeSave())) throw new Error("Save the draft first");
      await post(`erp/documents/${data.document.id}/task`, { assigneeId: who, dueOn: due || null });
      notify({ id: "erp-task", tone: "success", title: "Task created", message: `The draft is attached to it; the task is done when this ${noun} is approved.`, timeout: 4000 });
      onClose(); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Drawer title="Give it to a person" context={`They finish and approve this ${noun}`} size="sm" onClose={onClose} snap="half"
    footer={<DrawerFooter status={error} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!who || busy} onClick={() => void give()}>Create task</button>} />}>
    <DrawerSection title="Who">
      <div className={css.radios} role="radiogroup" aria-label="Who">{data.assignees.map((p) => <label key={p.id} className={css.radio}><input type="radio" name="erp-task-who" checked={who === p.id} onChange={() => setWho(p.id)} />{p.name}</label>)}</div>
    </DrawerSection>
    <DrawerSection title="By when"><label className={styles.field}>Due (optional)<DateField value={due} onChange={(e) => setDue(e.target.value)} /></label></DrawerSection>
  </Drawer>;
}

/** BILLING-WL (Akabod, 4 Nov 2026): send the draft to a manager or the owner. They are told in Pulse and approve it with one
 *  tap; then the sender is told, and sends it to the customer. Sending again is a reminder. */
function ApprovalDrawer({ id, noun, approval, beforeSend, body, onClose }: { id: string; noun: string; approval: NonNullable<DocumentData["approval"]>; beforeSend: () => Promise<boolean>;
  body: () => unknown; onClose: () => void }) {
  const router = useRouter();
  const first = approval.asked?.toId && approval.approvers.some((p) => p.id === approval.asked!.toId) ? approval.asked.toId : approval.approvers[0]?.id ?? "";
  const [who, setWho] = useState(first), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const reminder = !!approval.asked && approval.asked.toId === who;
  async function send() {
    setBusy(true); setError(null);
    try {
      if (!(await beforeSend())) throw new Error("Save the draft first");
      await post(`erp/documents/${id}/approval`, { to: who, note: note || null, draft: body() });
      const name = approval.approvers.find((p) => p.id === who)?.name ?? "them";
      notify({ id: "erp-approval", tone: "success", title: reminder ? `${name} is reminded` : `Sent to ${name}`, message: `You are told once the ${noun} is approved, then you send it.`, timeout: 5000 });
      onClose(); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Drawer title={reminder ? "Remind the approver" : "Send for approval"} context={`A manager or the owner approves this ${noun}`} size="sm" onClose={onClose} snap="half"
    footer={<DrawerFooter status={error ?? (approval.approvers.length ? null : "No one can approve quotations yet. Ask an admin to give a manager the Finance role.")}
      primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!who || busy} onClick={() => void send()}>{reminder ? <BellRing size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}{reminder ? "Send a reminder" : "Send for approval"}</button>} />}>
    <DrawerSection title="Who approves it">
      <div className={css.radios} role="radiogroup" aria-label="Who approves it">{approval.approvers.map((p) => <label key={p.id} className={css.radio}>
        <input type="radio" name="erp-approver" checked={who === p.id} onChange={() => setWho(p.id)} />{p.name}{p.lead ? <small> · leadership</small> : null}</label>)}</div>
    </DrawerSection>
    <DrawerSection title="Note"><label className={styles.field}>A word for them (optional)<textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
      placeholder="e.g. Customer wants it today" /></label></DrawerSection>
  </Drawer>;
}
