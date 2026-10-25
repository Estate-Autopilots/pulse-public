"use client";

// Billing composer (18 Oct 2026, the blueprint's "Composer"): write on the left, the customer's copy on the right; on a
// phone the copy is a sheet that peeks from the bottom with the total and the one main button. One line per thing: a
// catalogue line keeps the catalogue's price and has a +/− for the quantity; an amount that changes by site (installation,
// transport, a service priced at ₹0 in the catalogue) stays highlighted until it is filled or marked not needed; a
// different price is a request the owner approves, never typed over the catalogue's. Client, GSTIN and terms come from the
// record and the template (a tap on the client opens them); the rest waits behind "More details". The draft saves itself
// a moment after each change; the main button approves it, which numbers it (the PDF exactly as exported is filed then).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FilePlus2, MoreHorizontal, Package, Plus, Search, Trash2, UserPlus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { computeDocument, DOC_LABELS, formatAmount, formatDate, GST_RATES, STATES, stateFromGstin, stateLabel, toPaise, validGstin, type DocumentInput } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { initials, styles } from "../../../ui";
import { Drawer, DrawerFooter, DrawerSection, useIsPhone } from "../../../kit/drawer";
import { AddField, Disclosure } from "../../../kit/disclosure";
import { LineList, LineRow, OpenAmount, Stepper } from "../../../kit/line-row";
import { ChainBar, NextStep } from "../../../kit/next-step";
import { Menu, type MenuItem } from "../../../kit/menu";
import { LivePreview } from "../../preview";
import type { Buyer, CatalogPick, DocumentData, Line } from "../../types";
import { chainSteps, EVENT, inr, plural, when } from "../chain";
import { showField, type BillingSetup } from "../../settings/fields";
import css from "../documents.module.css";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
const STATE_OPTIONS = Object.entries(STATES).sort((a, b) => a[1].name.localeCompare(b[1].name));
/** A line as the composer holds it: `open` = its amount is asked here (a ₹0 catalogue item or a line of our own), `filled`
 *  = someone gave it, `notNeeded` = it stays off the document. A quantity of 0 takes a line off too. `parentKey` = the line
 *  it is an add-on of (EST-1236). */
type Row = Line & { key: string; open: boolean; filled: boolean; notNeeded: boolean; parentKey: string | null };
/** EST-1236's line model, when the API has it: open charges and "not needed" are kept on the draft (off the PDF and the
 *  totals), and an add-on points at its parent line (by position when saved). Older APIs answer without these fields. */
type SavedLine = Line & { id?: string; open?: boolean; notNeeded?: boolean; parentLineId?: string | null; parentIndex?: number | null };
type AddOn = { itemId: string; name: string; price: number };
type ItemPick = CatalogPick & { addOns?: AddOn[]; open?: boolean };
type Draft = {
  issueDate: string; dueDate: string | null; validUntil: string | null; buyer: Buyer; placeOfSupply: string | null; reference: { project?: string; milestone?: string; po?: string };
  notes: string; terms: string | null; reverseCharge: boolean; zeroRated: boolean; roundTotal: boolean; templateId: string | null; rows: Row[];
};
let seq = 0;
const rowOf = (l: SavedLine, item?: ItemPick): Row => {
  const open = l.open ?? (item ? item.open ?? item.price === 0 : l.rate === 0);
  return { ...l, key: `r${++seq}`, open, filled: !open || l.rate > 0, notNeeded: !!l.notNeeded, parentKey: null };
};
const fromItem = (it: ItemPick, parentKey: string | null = null): Row => ({ ...rowOf({ itemId: it.id, description: it.name, details: it.description.slice(0, 1000), sac: it.sac, unit: it.unit, qty: 1, rate: it.price, discount: 0, discountPercent: null, gstRate: it.gstRate }, it), parentKey });
const onDocument = (r: Row) => !r.notNeeded && r.qty > 0 && !!r.description.trim();
const toLine = (r: Row): Line => ({ itemId: r.itemId, description: r.description, details: r.details, sac: r.sac, unit: r.unit, qty: r.qty, rate: r.rate, discount: r.discount, discountPercent: r.discountPercent, gstRate: r.gstRate });
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
  const show = (key: Parameters<typeof showField>[1]) => showField(setup, key);
  const router = useRouter();
  const phone = useIsPhone();
  const d = data.document;
  const label = DOC_LABELS[d.docType];
  const items = useMemo(() => new Map((data.items as ItemPick[]).map((i) => [i.id, i])), [data.items]);
  // EST-1236's line model is there when the API answers lines or items with `open`.
  const v2 = (data.lines as SavedLine[]).some((l) => l.open !== undefined) || (data.items as ItemPick[]).some((i) => i.open !== undefined);
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = data.lines as SavedLine[];
    const rows = saved.map((l) => rowOf({ itemId: l.itemId, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: l.qty, rate: l.rate,
      discount: l.discountPercent ? 0 : l.discount, discountPercent: l.discountPercent, gstRate: l.gstRate, open: l.open, notNeeded: l.notNeeded }, l.itemId ? items.get(l.itemId) : undefined));
    // An add-on's parent, by the saved line's id (or its position).
    rows.forEach((r, n) => { const l = saved[n]; const at = l.parentLineId ? saved.findIndex((x) => x.id === l.parentLineId) : l.parentIndex ?? -1; r.parentKey = at >= 0 && rows[at] ? rows[at].key : null; });
    return {
    issueDate: d.issueDate, dueDate: d.dueDate, validUntil: d.validUntil, buyer: { address: [], ...d.buyer }, placeOfSupply: d.placeOfSupply,
    reference: d.reference ?? {}, notes: d.notes ?? "", terms: d.terms, reverseCharge: d.reverseCharge, zeroRated: d.zeroRated, roundTotal: d.roundTotal,
    templateId: d.templateId ?? data.template?.id ?? null,
    rows,
  }; });
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | string>("idle");
  const [panel, setPanel] = useState<null | { kind: "line"; key: string } | { kind: "client" } | { kind: "task" }>(null);
  const [finding, setFinding] = useState(false), [find, setFind] = useState("");
  const version = useRef(0), savedVersion = useRef(0);
  const latest = useRef(draft), savingNow = useRef<Promise<boolean> | null>(null), acting = useRef(false);
  const change = (fn: (x: Draft) => Draft) => { latest.current = fn(latest.current); version.current++; setDraft(latest.current); setDirty(true); setSaving("idle"); };
  const set = (patch: Partial<Draft>) => change((x) => ({ ...x, ...patch }));
  const setRow = (key: string, patch: Partial<Row>) => change((x) => ({ ...x, rows: x.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
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
  const computed = useMemo(() => {
    try { return { ok: computeDocument({ lines: shown.map(toLine), sellerState, placeOfSupply: draft.placeOfSupply, roundTotal: draft.roundTotal, reverseCharge: draft.reverseCharge, zeroRated: draft.zeroRated }), error: "" }; }
    catch (e) { return { ok: null, error: message(e) }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sellerState]);
  const lineTotal = (r: Row) => computed.ok?.lines[shown.indexOf(r)]?.total ?? null;
  const against = data.related.find((r) => r.id === d.againstId);
  const input: DocumentInput | null = useMemo(() => computed.ok ? {
    docType: d.docType, status: "draft", number: null, issueDate: draft.issueDate, dueDate: draft.dueDate, validUntil: draft.validUntil,
    seller: company, buyer: draft.buyer, placeOfSupply: draft.placeOfSupply, reference: draft.reference, against: against ? { number: against.number, date: against.issueDate } : null,
    lines: shown.map(toLine), notes: draft.notes, terms: draft.terms, reverseCharge: draft.reverseCharge, zeroRated: draft.zeroRated, roundTotal: draft.roundTotal,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  } : null, [computed.ok, d.docType, draft, company, against]);

  // Price requests: a catalogue line whose price or discount differs from the catalogue's (never a ₹0 open amount).
  const deviations = draft.rows.filter(onDocument).flatMap((r) => {
    const it = r.itemId ? items.get(r.itemId) : undefined;
    return it && it.price > 0 && !r.open && (r.rate !== it.price || (r.discountPercent ?? 0) > 0 || r.discount > 0) ? [{ r, it }] : [];
  });
  const needed = draft.rows.filter((r) => onDocument(r) && r.open && !r.filled).length;
  const gstinBad = !!draft.buyer.gstin && !validGstin(draft.buyer.gstin);
  const blocked = !draft.buyer.name?.trim() ? "Choose the client to approve" : !draft.rows.some(onDocument) ? "Add a line to approve" : needed ? `Fill ${plural(needed, "amount")} to approve`
    : gstinBad ? "Fix the client's GSTIN to approve" : computed.error || null;
  const approvalWait = d.ownerApproval === "needed";
  const approvalBlocked = approvalWait && !canApproveOwnerQuote;

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
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function approve() {
    if (approvalBlocked) return;
    const price = deviations.length || approvalWait ? " The price that differs from the catalogue is approved with it." : "";
    if (!window.confirm(`Approve this ${label.noun}? It gets the next number in the ${label.title.toLowerCase()} series and can't be edited after that.${price}`)) return;
    await afterSave(async () => { try {
      const r = await post<{ number: string }>(`erp/documents/${d.id}/issue`, { draft: body() });
      setDirty(false);
      notify({ id: "erp-issue", tone: "success", title: `${label.title} ${r.number} approved`, message: d.docType === "quotation" ? "Send it to the customer next." : "The PDF exactly as exported is filed with it.", timeout: 5000 });
      router.refresh();
    } catch (e) { notify({ id: "erp-issue", tone: "error", title: "Not approved", message: message(e) }); } });
  }
  /** A download is of the saved draft: unsaved changes are saved first. */
  async function download(format: "pdf" | "docx") {
    await afterSave(async () => {
    const a = document.createElement("a"); a.href = `/api/v0/erp/documents/${d.id}/${format}`; a.download = ""; document.body.append(a); a.click(); a.remove();
    });
  }
  async function remove() {
    if (acting.current || !window.confirm("Delete this draft? It has no number yet, so nothing is lost from the books.")) return;
    acting.current = true; setBusy(true);
    try {
      // Let an existing writer settle before deleting, even if the draft cannot be saved. Never start a save here.
      await savingNow.current?.catch(() => false);
      await post(`erp/documents/${d.id}/delete`); setDirty(false); router.push("/erp/documents");
    } catch (e) { notify({ id: "erp-del", tone: "error", title: "Not deleted", message: message(e) }); }
    finally { acting.current = false; setBusy(false); }
  }
  const add = (it: ItemPick, parentKey: string | null = null) => {
    const has = draft.rows.find((r) => r.itemId === it.id && !r.open);
    if (has) setRow(has.key, { qty: Math.max(1, has.qty + (has.notNeeded ? 0 : 1)), notNeeded: false });
    else change((x) => ({ ...x, rows: [...x.rows, fromItem(it, parentKey)] }));
    setFinding(false); setFind("");
  };
  /** Removing a line removes its add-ons with it. */
  const removeRow = (key: string) => change((x) => ({ ...x, rows: x.rows.filter((r) => r.key !== key && r.parentKey !== key) }));
  const addOwn = () => {
    const r = rowOf({ itemId: null, description: "", details: "", sac: null, unit: null, qty: 1, rate: 0, discount: 0, discountPercent: null, gstRate: 18 });
    change((x) => ({ ...x, rows: [...x.rows, r] }));
    setPanel({ kind: "line", key: r.key });
  };

  // Add-ons: catalogue items not on the document yet. With nothing on it, packages first (a starting point); after that the
  // services and products that go with it, priced ones first; ₹0 ones are amounts to fill (installation, transport).
  const onIt = new Set(draft.rows.filter(onDocument).map((r) => r.itemId));
  const free = (data.items as ItemPick[]).filter((i) => !onIt.has(i.id));
  // The usual add-ons of what is on the document (EST-1236), each tied to its line: offered first.
  const addOnChips = (show("addOns") ? draft.rows : []).filter(onDocument).flatMap((r) => (r.itemId ? items.get(r.itemId)?.addOns ?? [] : [])
    .filter((a) => !onIt.has(a.itemId) && items.has(a.itemId)).map((a) => ({ a, parent: r })))
    .filter((x, n, all) => all.findIndex((y) => y.a.itemId === x.a.itemId) === n);
  const startEmpty = !draft.rows.some(onDocument);
  const chips = (startEmpty ? [...free.filter((i) => i.kind === "package"), ...free.filter((i) => i.kind !== "package")] : free.filter((i) => i.kind !== "package")
    .sort((a, b) => Number(b.price > 0) - Number(a.price > 0))).slice(0, phone ? 4 : 6);
  const q = find.trim().toLowerCase();
  const found = q ? free.filter((i) => `${i.name} ${i.code ?? ""} ${i.sac ?? ""}`.toLowerCase().includes(q)).slice(0, 8) : free.slice(0, 8);

  const total = computed.ok?.total ?? 0;
  const status = approvalWait ? "A price differs from the catalogue: only the owner approves it" : blocked
    ?? (deviations.length ? `Approving accepts ${plural(deviations.length, "price")} that differ${deviations.length === 1 ? "s" : ""} from the catalogue` : `Total ${inr(total)} · numbered when approved`);
  const main = <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !!blocked || approvalBlocked} onClick={() => void approve()}>
    {approvalBlocked ? "Only leadership can approve" : deviations.length || approvalWait ? "Approve the new price" : "Approve"}</button>;
  const menu: MenuItem[] = [
    { key: "pdf", label: "Download PDF", icon: <Download size={15} aria-hidden="true" />, onSelect: () => void download("pdf") },
    { key: "docx", label: "Download Word file", icon: <Download size={15} aria-hidden="true" />, onSelect: () => void download("docx") },
    ...(!data.task && data.assignees.length ? [{ key: "task", label: "Give it to a person", icon: <UserPlus size={15} aria-hidden="true" />, onSelect: () => setPanel({ kind: "task" }) }] : []),
    { key: "delete", label: "Delete draft", icon: <Trash2 size={15} aria-hidden="true" />, danger: true, disabled: !!d.taskId, hint: d.taskId ? "Attached to a task" : undefined, onSelect: () => void remove(), separator: true },
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
        <ChainBar steps={chainSteps(d, data.related)} current={d.docType === "credit_note" ? "credit_note" : d.docType} />
        <span className={css.draftChip}>Draft · numbered when approved</span>
        <span className={css.note} aria-live="polite">{savedText}</span>
      </div>

      <div className={css.block}>
        <p className={css.label}>{d.docType === "quotation" ? "Prepared for" : "Bill to"}</p>
        <LineList label="Client">
          <LineRow lead={<span className={css.avatar} aria-hidden="true">{draft.buyer.name ? initials(draft.buyer.name) : "?"}</span>} tone={draft.buyer.name?.trim() ? undefined : "needed"}
            title={draft.buyer.name?.trim() || "Choose the client"} label={`Client: ${draft.buyer.name || "not chosen"}. Open the billing details`}
            sub={[gstinBad ? "GSTIN not valid" : draft.buyer.gstin ? `GSTIN ${draft.buyer.gstin}` : "Unregistered", buyerState, draft.buyer.address?.[0]].filter(Boolean).join(" · ")}
            onOpen={() => setPanel({ kind: "client" })} end={d.clientId ? <span className={css.src}>From the client record</span> : undefined} />
        </LineList>
      </div>

      <div className={css.block}>
        <p className={css.label}>{d.docType === "credit_note" ? "What is credited" : "What is quoted"} · {plural(draft.rows.filter(onDocument).length, "line")}</p>
        {draft.rows.length ? <LineList label="Lines">
          {draft.rows.map((r) => {
            const it = r.itemId ? items.get(r.itemId) : undefined;
            const off = r.notNeeded || r.qty <= 0;
            const t = lineTotal(r);
            const dev = deviations.find((x) => x.r === r);
            const parent = r.parentKey ? draft.rows.find((x) => x.key === r.parentKey) : undefined;
            const sub = off ? (r.notNeeded ? "Not needed: not on the document" : "Taken off: + adds it back")
              : r.open ? `${parent ? `Add-on for ${parent.description} · ` : ""}${it ? "Changes by site · fill in or mark not needed" : "Amount to fill in"}`
              : [parent ? `Add-on for ${parent.description}` : null, it?.kind === "package" ? "Package" : null, `${inr(r.rate)}${r.unit ? ` per ${r.unit}` : ""}`, `GST ${r.gstRate}%`, dev ? `catalogue ${inr(dev.it.price)}` : null].filter(Boolean).join(" · ");
            return <LineRow key={r.key} stack title={r.description || "New line"} sub={sub} tone={off ? "muted" : r.open && !r.filled ? "needed" : undefined}
              label={`${r.description || "New line"}: details`} onOpen={() => setPanel({ kind: "line", key: r.key })}
              lead={it?.kind === "package" ? <Package size={16} aria-hidden="true" /> : undefined}
              end={r.open ? <OpenAmount label={`${r.description || "Line"} amount before GST`} value={r.filled ? r.rate : null} notNeeded={r.notNeeded} placeholder="₹ before GST"
                onChange={(p) => setRow(r.key, p === null ? { rate: 0, filled: false } : { rate: p, filled: true })} onNotNeeded={(no) => setRow(r.key, { notNeeded: no })} />
                : <Stepper label={`Quantity of ${r.description || "this line"}`} value={r.qty} min={0} onChange={(n) => setRow(r.key, { qty: n })} />}
              amount={!off && t !== null && !(r.open && !r.filled) ? inr(t) : undefined} amountSub={!off && t !== null && !(r.open && !r.filled) ? "incl. GST" : undefined} />;
          })}
        </LineList> : <p className={css.note}>Nothing on it yet: start from a package or an item below.</p>}

        {data.items.length ? <div className={css.adds} role="group" aria-label="Add from the catalogue">
          <span className={css.addsLabel}>{startEmpty ? "Start from:" : "Add:"}</span>
          {addOnChips.map(({ a, parent }) => <button key={`addon-${a.itemId}`} type="button" className={css.chip} data-tone={a.price === 0 ? "needed" : undefined}
            onClick={() => add(items.get(a.itemId)!, parent.key)} title={`Add-on for ${parent.description}${a.price ? ` · ${inr(a.price)} + GST` : " · amount to fill in"}`}><Plus size={13} aria-hidden="true" /><span>{a.name}</span></button>)}
          {chips.filter((i) => !addOnChips.some((x) => x.a.itemId === i.id)).map((i) => <button key={i.id} type="button" className={css.chip} data-tone={i.price === 0 ? "needed" : undefined} onClick={() => add(i)}
            title={i.price ? `${inr(i.price)} + GST ${i.gstRate}%` : "Amount to fill in"}><Plus size={13} aria-hidden="true" /><span>{i.name}</span></button>)}
          <button type="button" className={css.chip} data-tone="quiet" aria-expanded={finding} onClick={() => setFinding(!finding)}><Search size={13} aria-hidden="true" /><span>{finding ? "Close the catalogue" : "Whole catalogue"}</span></button>
          <button type="button" className={css.chip} data-tone="quiet" onClick={addOwn}><FilePlus2 size={13} aria-hidden="true" /><span>Something else</span></button>
        </div> : <div className={css.adds}><button type="button" className={css.chip} onClick={addOwn}><Plus size={13} aria-hidden="true" /><span>Add a line</span></button>
          <span className={css.addsLabel}>The catalogue is empty: add services and products in Catalogue to pick them here.</span></div>}
        {finding ? <div className={css.find}>
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search the catalogue: name, code or SAC" aria-label="Search the catalogue" autoFocus />
          <LineList label="Catalogue matches">
            {found.map((i) => <LineRow key={i.id} title={i.name} sub={[i.kind === "package" ? "Package" : i.kind === "product" ? "Product" : "Service", i.code, i.status === "draft" ? "draft" : null].filter(Boolean).join(" · ")}
              amount={i.price ? inr(i.price) : "Amount to fill"} amountSub={i.price ? `+ GST ${i.gstRate}%` : undefined} onOpen={() => add(i)} label={`Add ${i.name}`} />)}
            {!found.length ? <LineRow title="Nothing matches" sub="Try another word, or add something else" tone="muted" /> : null}
          </LineList>
        </div> : null}
      </div>

      {approvalWait ? <div className={css.flag} role="status"><b>Waiting for the owner&apos;s approval</b><span>A price on this quotation differs from the catalogue. It goes out only after the owner approves it.</span></div>
        : d.ownerApproval === "approved" ? <div className={css.flag} data-tone="ok" role="status"><b>Price approved by the owner</b></div> : null}
      {deviations.map(({ r, it }) => {
        const each = r.discountPercent ? Math.round(r.rate * (1 - r.discountPercent / 100)) : r.rate - (r.discount && r.qty ? Math.round(r.discount / r.qty) : 0);
        const diff = it.price - each;
        return <div key={r.key} className={css.flag} role="status">
          <b>{r.description}: {inr(each)} asked</b>
          <span>{diff > 0 ? `${inr(diff)} below` : `${inr(-diff)} above`} the catalogue&apos;s {inr(it.price)}. Approving the {label.noun} approves this price; until then it is a request.</span>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setRow(r.key, { rate: it.price, discount: 0, discountPercent: null })}>Use the catalogue price</button>
        </div>;
      })}

      {computed.ok ? <div className={css.totals}>
        <small>Before GST {inr(computed.ok.taxable)} · GST {inr(computed.ok.cgst + computed.ok.sgst + computed.ok.igst)}{computed.ok.roundOff ? ` · round off ${formatAmount(computed.ok.roundOff)}` : ""}{needed ? ` · ${plural(needed, "amount")} to fill` : ""}</small>
        <span className={css.total}><small>Total</small>{inr(computed.ok.total)}</span>
      </div> : computed.error ? <p className={css.note} role="alert">{computed.error}</p> : null}

      <Disclosure summary="More details" hint={d.docType === "quotation" ? "validity, place of supply, template, notes, terms" : "dates, place of supply, template, notes, terms"}>
        <div className={css.fields}>
          <label className={styles.field}>{label.date}<input type="date" value={draft.issueDate} max={data.today} onChange={(e) => set({ issueDate: e.target.value })} /></label>
          {d.docType === "quotation" ? show("validity") && <label className={styles.field}>Valid until<input type="date" value={draft.validUntil ?? ""} onChange={(e) => set({ validUntil: e.target.value || null })} /></label>
            : d.docType !== "credit_note" ? <label className={styles.field}>Due date<input type="date" value={draft.dueDate ?? ""} onChange={(e) => set({ dueDate: e.target.value || null })} /></label> : null}
          <label className={styles.field}>Place of supply<select value={draft.placeOfSupply ?? ""} onChange={(e) => set({ placeOfSupply: e.target.value || null })}>
            {STATE_OPTIONS.map(([code, s]) => <option key={code} value={code}>{s.name} ({code})</option>)}</select>
            <span className={css.hint}>{computed.ok ? computed.ok.mode === "intra" ? `Same state: CGST + ${computed.ok.split}` : "Another state: IGST" : "Decides CGST + SGST or IGST"}</span></label>
          <label className={styles.field}>Template<select value={draft.templateId ?? ""} onChange={(e) => set({ templateId: e.target.value || null })}>
            {data.templates.filter((t) => t.docTypes.includes(d.docType)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
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
        {data.task ? <p className={css.note}>Task <b>{data.task.title}</b> · {data.task.assignee ?? "unassigned"} · {data.task.status}{data.task.dueOn ? ` · due ${formatDate(data.task.dueOn)}` : ""}. It is done when this {label.noun} is approved.</p> : null}
      </Disclosure>

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
          {data.events.map((e, i) => <li key={i}><b>{EVENT[e.kind] ?? e.kind}</b><span>{when(e.at)}{e.actor ? ` · ${e.actor}` : ""}</span></li>)}</ol></DrawerSection> },
      ]}
      footer={<DrawerFooter tone="info" status={status} primary={main}>{more}</DrawerFooter>} /> : null}

    {panel?.kind === "client" ? <Drawer title={d.docType === "quotation" ? "Prepared for" : "Bill to"} context={d.clientId ? "From the client's billing profile" : "Typed for this document"} onClose={() => setPanel(null)} snap="full"
      footer={<DrawerFooter status={gstinBad ? "Not a valid GSTIN: check the 15 characters" : null} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setPanel(null)}>Done</button>} />}>
      <DrawerSection title="Business">
        <div className={css.fields}>
          <label className={`${styles.field} ${css.wide}`}>Legal name<input value={draft.buyer.name ?? ""} onChange={(e) => setBuyer({ name: e.target.value })} placeholder="As registered for GST" /></label>
          <label className={styles.field}>GSTIN<input value={draft.buyer.gstin ?? ""} onChange={(e) => setBuyer({ gstin: e.target.value.toUpperCase() || null })} maxLength={15} placeholder="Unregistered: leave empty" aria-invalid={gstinBad || undefined} />
            <span className={`${css.hint} ${gstinBad ? css.bad : draft.buyer.gstin ? css.good : ""}`}>{gstinBad ? "Not a valid GSTIN" : draft.buyer.gstin ? `Valid · ${stateLabel(stateFromGstin(draft.buyer.gstin)!)}` : "Consumer or unregistered business"}</span></label>
          <label className={styles.field}>State<select value={draft.buyer.stateCode ?? ""} disabled={!!draft.buyer.gstin && !gstinBad} onChange={(e) => setBuyer({ stateCode: e.target.value || null })}>
            <option value="">Choose…</option>{STATE_OPTIONS.map(([code, s]) => <option key={code} value={code}>{s.name} ({code})</option>)}</select></label>
          <label className={`${styles.field} ${css.wide}`}>Address<textarea rows={2} value={(draft.buyer.address ?? []).join("\n")} onChange={(e) => setBuyer({ address: e.target.value.split("\n").slice(0, 6) })} /></label>
        </div>
      </DrawerSection>
      <DrawerSection title="Contact">
        <div className={css.fields}>
          <label className={styles.field}>Name<input value={draft.buyer.contactName ?? ""} onChange={(e) => setBuyer({ contactName: e.target.value })} /></label>
          <label className={styles.field}>Phone<input type="tel" value={draft.buyer.phone ?? ""} onChange={(e) => setBuyer({ phone: e.target.value })} /></label>
          <label className={styles.field}>E-mail<input type="email" value={draft.buyer.email ?? ""} onChange={(e) => setBuyer({ email: e.target.value })} /></label>
        </div>
      </DrawerSection>
    </Drawer> : null}

    {editing ? <LineDrawer row={editing} item={editing.itemId ? items.get(editing.itemId) : undefined} total={lineTotal(editing)} noun={label.noun} discount={show("discount")}
      onChange={(patch) => setRow(editing.key, patch)} onRemove={() => { removeRow(editing.key); setPanel(null); }} onClose={() => setPanel(null)} /> : null}

    {panel?.kind === "task" ? <TaskDrawer data={data} noun={label.noun} beforeSave={() => save(true)} onClose={() => setPanel(null)} /> : null}
  </div>;
}

/** One line's details: what it is, how many, its price (the catalogue's, or a request for another), tax. */
function LineDrawer({ row, item, total, noun, discount, onChange, onRemove, onClose }: { row: Row; item?: CatalogPick; total: number | null; noun: string; discount: boolean; onChange: (p: Partial<Row>) => void; onRemove: () => void; onClose: () => void }) {
  const fixed = !!item && item.price > 0 && !row.open;
  const [asking, setAsking] = useState(fixed && (row.rate !== item!.price || !!row.discountPercent || !!row.discount));
  return <Drawer title={row.description || "New line"} context={total !== null ? `${inr(total)} incl. GST` : row.open ? "Amount to fill" : undefined} onClose={onClose} snap="half" noAutofocus={!!row.description}
    footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>Done</button>}>
      <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnDanger}`} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />Remove</button></DrawerFooter>}>
    <DrawerSection title="What it is">
      <label className={styles.field}>Name on the {noun}<input value={row.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="What is billed" data-autofocus={row.description ? undefined : ""} /></label>
      <AddField label="Add details (deliverables, period)" show={!!row.details}><label className={styles.field}>Details<textarea rows={3} value={row.details} onChange={(e) => onChange({ details: e.target.value })} /></label></AddField>
    </DrawerSection>
    <DrawerSection title="How many" aside={row.unit ?? undefined}>
      <Stepper label="Quantity" value={row.qty} min={0} onChange={(n) => onChange({ qty: n })} />
    </DrawerSection>
    <DrawerSection title="Price before GST">
      {row.open ? <OpenAmount label="Amount before GST" value={row.filled ? row.rate : null} notNeeded={row.notNeeded} placeholder="₹ before GST"
        onChange={(p) => onChange(p === null ? { rate: 0, filled: false } : { rate: p, filled: true })} onNotNeeded={(no) => onChange({ notNeeded: no })} />
        : fixed ? <>
          <p className={css.price}><b>{inr(item!.price)}</b><span className={css.hint}>catalogue price{row.unit ? ` per ${row.unit}` : ""}</span></p>
          {asking ? <>
            <div className={css.fields}>
              <label className={styles.field}>Price you want to offer ₹<RupeeInput label="Price you want to offer" value={row.rate} onChange={(rate) => onChange({ rate })} /></label>
              {discount ? <label className={styles.field}>Or a discount %<input inputMode="decimal" value={row.discountPercent ?? ""} onChange={(e) => onChange({ discountPercent: e.target.value === "" ? null : Number(e.target.value), discount: 0 })} /></label> : null}
            </div>
            <p className={css.note}>A different price is a request: the {noun} goes out once it is approved.</p>
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { onChange({ rate: item!.price, discount: 0, discountPercent: null }); setAsking(false); }}>Use the catalogue price</button>
          </> : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setAsking(true)}>Ask for a different price</button>}
        </>
        : <div className={css.fields}><label className={styles.field}>Rate ₹<RupeeInput label="Rate" value={row.rate} onChange={(rate) => onChange({ rate, filled: true })} /></label>
          {discount ? <label className={styles.field}>Discount %<input inputMode="decimal" value={row.discountPercent ?? ""} onChange={(e) => onChange({ discountPercent: e.target.value === "" ? null : Number(e.target.value), discount: 0 })} /></label> : null}</div>}
    </DrawerSection>
    <Disclosure summary="Tax" hint={`${row.sac ? `SAC/HSN ${row.sac} · ` : ""}GST ${row.gstRate}%`}>
      <div className={css.fields}>
        <label className={styles.field}>SAC/HSN<input value={row.sac ?? ""} inputMode="numeric" maxLength={8} onChange={(e) => onChange({ sac: e.target.value.replace(/\D/g, "") || null })} /></label>
        <label className={styles.field}>GST<select value={row.gstRate} onChange={(e) => onChange({ gstRate: Number(e.target.value) })}>{GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}</select></label>
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
    <DrawerSection title="By when"><label className={styles.field}>Due (optional)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label></DrawerSection>
  </Drawer>;
}
