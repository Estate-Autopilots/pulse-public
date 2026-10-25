"use client";

// ERP-INVOICE: one catalog item. A package is built from parts (catalog services or free parts) with their deliverables,
// where each lives, how it is set up and what it feeds; it carries the billing plan its sales get as milestones. Every
// save is a version: the price history is the version list.
// BILLING (18 Oct 2026): details on the left, the customer's copy (the real quotation PDF, drawn live) on the right; parts
// one line each, opened in the Drawer; the billing plan in words; history in a Drawer; one main next step.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Eye, History, Pencil, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { formatDate, GST_RATES } from "@pulse/invoice-doc/gst";
import type { DocumentInput } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { Badge, styles } from "../../../ui";
import { Drawer, DrawerFooter, DrawerSection, useMedia } from "../../../kit/drawer";
import { Disclosure } from "../../../kit/disclosure";
import { LineList, LineRow } from "../../../kit/line-row";
import { NextStep } from "../../../kit/next-step";
import { LivePreview } from "../../preview";
import { showField, type BillingSetup } from "../../settings/fields";
import type { CatalogItem, Part } from "../../types";
import { EMPTY_PART, MoneyInput, PartDrawer } from "../part-drawer";
import { KIND_LABEL, STATUS_LABEL, STATUS_TONE, deliverableDefault, marginPercent, milestoneText, partTotals, qtyText, rupees, teamText, whenText, type Milestone } from "../model";
import css from "../catalog.module.css";
import { SelectField } from "../../../kit/select-field";

type Data = {
  item: CatalogItem & { createdAt: string }; parts: Part[];
  versions: { version: number; changedAt: string; changedBy: string | null; price: number; cost: number | null; status: string; name: string; parts: number }[];
  usedIn: { id: string; name: string }[]; moves: { id: string; kind: string; qty: number; unitCost: number | null; note: string; onDate: string; by: string | null }[];
  engagements: { id: string; name: string; price: number; packageVersion: number; status: string; projectId: string; project: string | null }[];
  options: { id: string; name: string; kind: string; unit: string; price: number; sac: string | null }[]; inventoryEnabled: boolean; canWrite: boolean;
};
type Preview = { design: unknown; logoId: string | null; signatureId: string | null; sample: DocumentInput; template: string | null };
/** An item's usual add-ons (EST-1236), offered first when it is on a quotation; absent from older APIs. */
type AddOn = { itemId: string; name: string; price: number };
const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
const when = (at: string) => new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** An even split into `n` payments a month apart ("Month 1 · 34% at start", …). */
function evenPlan(n: number): Milestone[] {
  const base = Math.floor(100 / n), extra = 100 - base * n;
  return Array.from({ length: n }, (_, i) => ({ label: n === 1 ? "On start" : `Month ${i + 1}`, percent: base + (i < extra ? 1 : 0), offsetDays: 30 * i }));
}

/** The quotation a customer would get for this item, with the sample client: one line, the package's deliverables
 *  under it, the billing plan as the note. */
function quoteFor(sample: DocumentInput, item: Data["item"] & { milestones: Milestone[] }, parts: Part[]): DocumentInput {
  const delivers = parts.flatMap((p) => (p.deliverables.length ? p.deliverables : p.price === null && !p.itemId ? [] : [deliverableDefault(p)]));
  const details = [item.description.trim(), item.kind === "package" && delivers.length ? `Includes: ${delivers.join(", ")}` : ""].filter(Boolean).join(". ");
  const plan = item.milestones.length ? `Billing plan: ${item.milestones.map((m) => `${m.label ? `${m.label}, ` : ""}${m.percent}% ${whenText(m.offsetDays)} (${rupees(Math.round((item.price * m.percent) / 100))} + GST)`).join("; ")}.` : null;
  return { ...sample, docType: "quotation", status: "draft", number: null, reference: {}, against: null, paid: 0, credited: 0,
    lines: [{ description: item.name.trim() || "Untitled item", details, sac: item.sac, qty: 1, unit: item.unit, rate: item.price, gstRate: item.gstRate }],
    notes: plan ?? sample.notes ?? null };
}

export function ItemEditor({ data, preview, setup }: { data: Data; preview: Preview | null; setup?: BillingSetup }) {
  const show = (key: Parameters<typeof showField>[1]) => showField(setup, key);
  const router = useRouter();
  const ro = !data.canWrite;
  const wide = useMedia("(min-width: 1100px)");
  const initial = () => ({ ...data.item, milestones: (data.item.milestones ?? []) as Milestone[], setup: data.item.setup ?? "" });
  const [item, setItem] = useState(initial);
  const [parts, setParts] = useState<Part[]>(data.parts);
  const [dirty, setDirty] = useState(false), [partsDirty, setPartsDirty] = useState(false), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [sheet, setSheet] = useState<"plan" | "history" | "preview" | null>(null);
  const [plan, setPlan] = useState<Milestone[]>([]);
  const [move, setMove] = useState({ kind: "in", qty: "", note: "" });
  const savedAddOns = (data as Data & { addOns?: AddOn[] }).addOns ?? (data.item as { addOns?: AddOn[] }).addOns;
  const [addOns, setAddOns] = useState<AddOn[]>(savedAddOns ?? []), [addOnsDirty, setAddOnsDirty] = useState(false);
  const setAddOnList = (list: AddOn[]) => { setAddOns(list); setAddOnsDirty(true); };
  const set = (patch: Partial<typeof item>) => { setItem((x) => ({ ...x, ...patch })); setDirty(true); };
  const pkg = item.kind === "package";
  const totals = partTotals(parts);
  const margin = show("costMargin") ? marginPercent(item.price, item.cost) : null;
  const changed = dirty || partsDirty || addOnsDirty;
  const doc = useMemo(() => (preview ? quoteFor(preview.sample, item, parts) : null), [preview, item, parts]);
  const options = data.options;

  async function save(status?: "active" | "archived") {
    setBusy(true);
    try {
      if (dirty || addOnsDirty || status) await post(`erp/items/${item.id}`, { ...item, status: status ?? item.status, ...(savedAddOns ? { addOnIds: addOns.map((a) => a.itemId) } : {}) });
      if (partsDirty) await post(`erp/items/${item.id}/parts`, { parts });
      setDirty(false); setPartsDirty(false); setAddOnsDirty(false);
      notify({ id: "erp-item", tone: "success", title: status === "active" ? (item.status === "archived" ? "Restored: offered on new documents again" : "Approved: now used for new documents") : status === "archived" ? "Archived: no longer offered" : "Saved as a new version", timeout: 3000 });
      router.refresh();
    } catch (e) { notify({ id: "erp-item", tone: "error", title: "Not saved", message: message(e) }); } finally { setBusy(false); }
  }
  const discard = () => { setItem(initial()); setParts(data.parts); setAddOns(savedAddOns ?? []); setDirty(false); setPartsDirty(false); setAddOnsDirty(false); };
  async function addMove() {
    try { await post(`erp/items/${item.id}/stock`, { kind: move.kind, qty: Number(move.qty), note: move.note }); setMove({ kind: "in", qty: "", note: "" }); router.refresh(); }
    catch (e) { notify({ id: "erp-stock", tone: "error", title: "Not recorded", message: message(e) }); }
  }
  const source = item.source as { type?: string; file?: string; sheet?: string; row?: number; note?: string; invoices?: number };
  const planTotal = item.milestones.reduce((n, m) => n + Number(m.percent || 0), 0);
  const draftPlanTotal = plan.reduce((n, m) => n + Number(m.percent || 0), 0);

  // The one next step: save what changed; else approve a draft, archive an active item, restore an archived one.
  const next = changed ? { label: busy ? "Saving…" : `Save version ${item.version + 1}`, run: () => save(), status: "Unsaved changes; the old version stays in the history." }
    : item.status === "draft" ? { label: "Approve", run: () => save("active"), status: pkg ? "Draft: check the parts, prices and SAC, then approve." : "Draft: check the price and SAC, then approve." }
    : item.status === "active" ? { label: "Archive", run: () => save("archived"), status: "Active: new quotations and invoices use this version." }
    : { label: "Restore", run: () => save("active"), status: "Archived: not offered on new documents." };

  const editedPart = editing === "new" ? EMPTY_PART : editing === null ? null : parts[editing];
  return <div className={css.body}>
    {source?.note && item.status === "draft" ? <p className={css.notice}>{source.note}. Source: {source.type === "sheet" ? `“${source.file}” › ${source.sheet}, row ${source.row}` : source.type === "finance-live" ? `${source.invoices} sales invoices in FIN-LIVE` : source.type}.</p> : null}
    <div className={css.page}>
      <div className={css.main}>
        <section className={css.card} aria-label="Item">
          <div className={css.cardHead}>
            <Badge tone="accent">{KIND_LABEL[item.kind]}</Badge>
            <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
            <small className={css.version}>version {item.version}</small>
            <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setSheet("history")}><History size={13} aria-hidden="true" />History</button>
          </div>
          <fieldset className={css.fieldset} disabled={ro}>
            <input className={css.nameInput} aria-label="Name" value={item.name} onChange={(e) => set({ name: e.target.value })} />
            <div className={css.priceGrid}>
              <label className={styles.field}>Price ₹ before GST<MoneyInput label="Price" value={item.price} onChange={(p) => set({ price: p ?? 0 })} /></label>
              <label className={styles.field}>GST<SelectField value={item.gstRate} onChange={(e) => set({ gstRate: Number(e.target.value) })}>{GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}</SelectField></label>
              {show("costMargin") ? <label className={styles.field}>{pkg ? "Delivery cost ₹" : "Cost ₹"}<MoneyInput label="Cost" value={item.cost} placeholder="Not known" onChange={(p) => set({ cost: p })} /></label> : null}
            </div>
            <p className={css.facts}><span>With GST <b>{rupees(Math.round(item.price * (1 + item.gstRate / 100)))}</b></span>{margin !== null ? <span>Margin <b>{margin}%</b></span> : null}
              {pkg && parts.length ? <span>Parts add up to <b>{rupees(totals.price)}</b></span> : null}</p>
            <Disclosure hint={`code, SAC ${item.sac ?? "—"}, unit, description${item.kind === "product" || item.kind === "consumable" ? ", stock" : ""}`}>
              <div className={css.fields}>
                <label className={styles.field}>Code<input value={item.code ?? ""} onChange={(e) => set({ code: e.target.value || null })} placeholder="pkg-4-month" /></label>
                <label className={styles.field}>SAC/HSN<input value={item.sac ?? ""} inputMode="numeric" maxLength={8} onChange={(e) => set({ sac: e.target.value.replace(/\D/g, "") || null })} /></label>
                <label className={styles.field}>Unit<input value={item.unit} onChange={(e) => set({ unit: e.target.value })} /></label>
                <label className={`${styles.field} ${css.wide}`}>Description, printed under the line<textarea rows={2} value={item.description} onChange={(e) => set({ description: e.target.value })} /></label>
                {show("partSetup") ? <label className={`${styles.field} ${css.wide}`}>How it is set up and delivered<textarea rows={2} value={item.setup} onChange={(e) => set({ setup: e.target.value })} /></label> : null}
                {item.kind === "product" || item.kind === "consumable" ? <>
                  <label className={css.check}><input type="checkbox" checked={item.trackStock} onChange={(e) => set({ trackStock: e.target.checked })} />Keep stock of it</label>
                  {item.trackStock ? <label className={styles.field}>Low-stock level<input inputMode="decimal" value={item.reorderLevel ?? ""} onChange={(e) => set({ reorderLevel: e.target.value === "" ? null : Number(e.target.value) })} /></label> : null}
                </> : null}
              </div>
            </Disclosure>
          </fieldset>
        </section>

        {pkg ? <section className={css.card} aria-label="Parts">
          <div className={css.cardHead}><h3>Parts</h3><small>{parts.length} · {rupees(totals.price)}{show("costMargin") && totals.cost ? ` · cost ${rupees(totals.cost)}` : ""}</small>
            {!ro ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setEditing("new")}><Plus size={13} aria-hidden="true" />Part</button> : null}</div>
          {parts.length ? <LineList label="Parts">{parts.map((p, n) => {
            const team = show("partSetup") ? teamText(p.setup) : "", qty = qtyText(p);
            return <LineRow key={p.id ?? `new-${n}`} onOpen={() => setEditing(n)} selected={editing === n} title={p.label} tone={p.price === null ? "muted" : undefined}
              sub={[qty, p.price === null ? "free part" : null, team || null, show("partSetup") && p.price === null && p.derives ? p.derives : null].filter(Boolean).join(" · ") || undefined}
              amount={p.price === null ? "—" : rupees(p.price)} amountSub={show("costMargin") && p.cost !== null ? `cost ${rupees(p.cost)}` : undefined} />;
          })}</LineList> : <p className={css.hint}>No parts yet. Add what the package delivers, one part at a time.</p>}
          {item.price && totals.price && totals.price !== item.price ? <p className={css.hint}>The parts add up to {rupees(totals.price)}; the package sells for {rupees(item.price)}. Invoices bill the package by its plan; part prices are for reference.</p> : null}
        </section> : null}

        {pkg && show("months") ? <section className={css.card} aria-label="Billing plan">
          <div className={css.cardHead}><h3>Billing plan</h3><small>{item.milestones.length ? (planTotal === 100 ? "each sale is invoiced like this" : `adds up to ${planTotal}%: make it 100%`) : "none"}</small>
            {!ro ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { setPlan(item.milestones.map((m) => ({ ...m }))); setSheet("plan"); }}><Pencil size={13} aria-hidden="true" />Change</button> : null}</div>
          {item.milestones.length ? <LineList label="Billing plan">{item.milestones.map((m, n) => <LineRow key={n} title={milestoneText(m)} amount={rupees(Math.round((item.price * m.percent) / 100))} amountSub="+ GST" />)}</LineList>
            : <p className={css.hint}>No plan: a sale is billed in full when it starts.</p>}
        </section> : null}

        {!pkg && show("addOns") && savedAddOns ? <section className={css.card} aria-label="Usual add-ons">
          <div className={css.cardHead}><h3>Usual add-ons</h3><small>offered first when this is on a quotation</small></div>
          {addOns.length ? <LineList label="Usual add-ons">{addOns.map((a) => <LineRow key={a.itemId} title={a.name} amount={a.price ? rupees(a.price) : "Amount to fill"}
            end={!ro ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-label={`Remove ${a.name}`} onClick={() => setAddOnList(addOns.filter((x) => x.itemId !== a.itemId))}>Remove</button> : undefined} />)}</LineList>
            : <p className={css.hint}>None yet. Installation, transport or an extended warranty that usually goes with it, for example.</p>}
          {!ro && addOns.length < 20 ? <SelectField className={styles.input} aria-label="Add an add-on" value="" onChange={(e) => {
            const o = data.options.find((x) => x.id === e.target.value);
            if (o) setAddOnList([...addOns, { itemId: o.id, name: o.name, price: o.price }]);
          }}><option value="">+ Add an add-on…</option>{data.options.filter((o) => !addOns.some((a) => a.itemId === o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</SelectField> : null}
        </section> : null}

        {item.trackStock ? <section className={css.card} aria-label="Stock">
          <div className={css.cardHead}><h3>Stock</h3><small>{item.onHand ?? 0} {item.unit} on hand{item.reorderLevel !== null ? ` · reorder at ${item.reorderLevel}` : ""}</small></div>
          {!data.inventoryEnabled ? <p className={css.notice}>Inventory is off for this company. Turn it on in Billing settings to record stock.</p> : !ro ? <div className={css.stockBar}>
            <SelectField className={styles.input} value={move.kind} onChange={(e) => setMove({ ...move, kind: e.target.value })} aria-label="Movement" style={{ width: 130 }}><option value="in">Stock in</option><option value="out">Stock out</option><option value="adjust">Adjust (±)</option></SelectField>
            <input className={styles.input} inputMode="decimal" placeholder="Quantity" value={move.qty} onChange={(e) => setMove({ ...move, qty: e.target.value })} aria-label="Quantity" style={{ width: 110 }} />
            <input className={styles.input} placeholder="Note (supplier, project…)" value={move.note} onChange={(e) => setMove({ ...move, note: e.target.value })} aria-label="Note" style={{ flex: "1 1 160px", minWidth: 0 }} />
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!Number(move.qty)} onClick={addMove}>Record</button>
          </div> : null}
          {data.moves.length ? <ul className={css.versions}>{data.moves.map((m) => <li key={m.id}><b>{m.kind === "in" ? "+" : m.kind === "out" ? "−" : "±"}{Math.abs(m.qty)} {item.unit}</b>
            <small>{formatDate(m.onDate)} · {m.kind}{m.note ? ` · ${m.note}` : ""}{m.by ? ` · ${m.by}` : ""}</small></li>)}</ul> : null}
        </section> : null}

        {!ro ? <NextStep status={next.status} tone={changed ? "warning" : "info"}
          secondary={<>
            {preview && !wide ? <button type="button" className={`${styles.btn} ${css.previewOpen}`} onClick={() => setSheet("preview")}><Eye size={14} aria-hidden="true" />Preview</button> : null}
            {changed ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={discard}>Discard</button>
              : item.status === "draft" ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => save("archived")}>Archive</button> : null}
          </>}
          primary={<button type="button" className={`${styles.btn} ${changed || item.status !== "active" ? styles.btnPrimary : ""}`} disabled={busy} onClick={next.run}>{next.label}</button>} />
          : preview && !wide ? <button type="button" className={styles.btn} onClick={() => setSheet("preview")}><Eye size={14} aria-hidden="true" />Customer&apos;s copy</button> : null}
      </div>
      {preview && doc ? <aside className={css.side} aria-label="Customer's copy">
        {/* The column is there from the first paint (no jump); the PDF is drawn only where the column shows. */}
        {wide ? <LivePreview design={preview.design} doc={doc} logoId={preview.logoId} signatureId={preview.signatureId} label="Customer's copy · as a quotation" /> : <div className={css.previewWait} aria-hidden="true" />}
        <p className={css.hint}>Drawn with {preview.template ? `the “${preview.template}” template` : "the default template"} for a sample client, exactly as it would be exported. It changes as you type.</p>
      </aside> : null}
    </div>

    {editedPart ? <PartDrawer setup={setup} key={String(editing)} part={editedPart} isNew={editing === "new"} packageName={item.name} options={options} readOnly={ro} doneLabel={editing === "new" ? "Add part" : "Done"}
      onClose={() => setEditing(null)}
      onDone={(p) => { setParts((ps) => (editing === "new" ? [...ps, p] : ps.map((x, n) => (n === editing ? p : x)))); setPartsDirty(true); setEditing(null); }}
      onRemove={() => { setParts((ps) => ps.filter((_, n) => n !== editing)); setPartsDirty(true); setEditing(null); }} /> : null}

    {sheet === "plan" ? <Drawer title="Billing plan" context={<span>{item.name} · {rupees(item.price)} + GST</span>} onClose={() => setSheet(null)} snap="full" noAutofocus
      footer={<DrawerFooter status={draftPlanTotal === 100 || !plan.length ? "" : `Adds up to ${draftPlanTotal}%: make it 100%`}
        primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!plan.length && draftPlanTotal !== 100} onClick={() => { set({ milestones: plan }); setSheet(null); }}>Done</button>} />}>
      <DrawerSection title="Start from">
        <div className={css.presets}>{[1, 2, 3, 4, 6].map((n) => <button key={n} type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPlan(evenPlan(n))}>{n === 1 ? "All at start" : `${n} monthly`}</button>)}
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setPlan([])}>No plan</button></div>
      </DrawerSection>
      <DrawerSection title="Payments" aside={plan.length ? `${draftPlanTotal}%` : undefined}>
        {plan.length ? <div className={css.plan}>
          <div className={css.planHead} aria-hidden="true"><span>Name</span><span>%</span><span>Days after start</span><span /></div>
          {plan.map((m, i) => <div key={i} className={css.planRow}>
            <input aria-label={`Payment ${i + 1} name`} value={m.label} onChange={(e) => setPlan(plan.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))} />
            <input aria-label={`Payment ${i + 1} percent`} inputMode="decimal" value={m.percent} onChange={(e) => setPlan(plan.map((x, n) => (n === i ? { ...x, percent: Number(e.target.value) || 0 } : x)))} />
            <input aria-label={`Payment ${i + 1} days after start`} inputMode="numeric" value={m.offsetDays} onChange={(e) => setPlan(plan.map((x, n) => (n === i ? { ...x, offsetDays: Number(e.target.value) || 0 } : x)))} />
            <button type="button" aria-label={`Remove payment ${i + 1}`} onClick={() => setPlan(plan.filter((_, n) => n !== i))}>×</button>
          </div>)}
          <p className={css.hint}>{plan.map(milestoneText).join(" · ")}</p>
        </div> : <p className={css.hint}>No plan: a sale is billed in full when it starts.</p>}
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPlan([...plan, { label: `Month ${plan.length + 1}`, percent: 0, offsetDays: 30 * plan.length }])}><Plus size={13} aria-hidden="true" />Payment</button>
      </DrawerSection>
    </Drawer> : null}

    {sheet === "history" ? <Drawer title="History" context={<span>{item.name}</span>} onClose={() => setSheet(null)} snap="full"
      panes={[
        { key: "versions", label: "Versions", count: data.versions.length, content: <ul className={css.versions}>{data.versions.map((v) => <li key={v.version}>
          <b>v{v.version} · {rupees(v.price)}{show("costMargin") && v.cost !== null ? ` · cost ${rupees(v.cost)}` : ""}</b>
          <small>{when(v.changedAt)} · {v.changedBy ?? "seeded"} · {STATUS_LABEL[v.status as CatalogItem["status"]] ?? v.status}{pkg ? ` · ${v.parts} parts` : ""}</small></li>)}</ul> },
        { key: "sold", label: "Sold", count: data.engagements.length, content: data.engagements.length ? <ul className={css.versions}>{data.engagements.map((e) => <li key={e.id}>
          <Link href={`/erp/new?project=${e.projectId}`}>{e.project ?? e.name}</Link><small>{rupees(e.price)} · version {e.packageVersion} · {e.status}</small></li>)}</ul>
          : <p className={css.hint}>Not sold yet. A sale appears here when a project buys this {pkg ? "package" : "item"}.</p> },
        ...(!pkg ? [{ key: "used", label: "In packages", count: data.usedIn.length, content: data.usedIn.length ? <ul className={css.versions}>{data.usedIn.map((u) => <li key={u.id}><Link href={`/erp/catalog/${u.id}`}>{u.name}</Link></li>)}</ul>
          : <p className={css.hint}>No package uses it.</p> }] : []),
      ]} /> : null}

    {sheet === "preview" && preview && doc ? <Drawer title="Customer's copy" context={<span>For a sample client, with {preview.template ? `the “${preview.template}” template` : "the default template"}</span>} onClose={() => setSheet(null)} size="xl" snap="full" bare>
      <LivePreview design={preview.design} doc={doc} logoId={preview.logoId} signatureId={preview.signatureId} label="As a quotation" />
    </Drawer> : null}
  </div>;
}
