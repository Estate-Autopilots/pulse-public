"use client";
// BILLING (18 Oct 2026): one part of a package, in the Drawer. The name is typed once: the deliverable is the part's name
// unless someone writes otherwise, and the catalogue item is the one named like it. Blank optional fields (who sets it up,
// where it lives, what it feeds) stay behind "+ Add …".
import { useState } from "react";
import { Link2, Trash2 } from "lucide-react";
import { styles } from "../../ui";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit/drawer";
import { AddField, AddGroup } from "../../kit/disclosure";
import { Stepper, amountText, toPaiseLoose } from "../../kit/line-row";
import { showField, type BillingSetup } from "../settings/fields";
import type { Part } from "../types";
import { deliverableDefault, deliverablesAreDefault, finishPart, matchOption, rupees, type CatalogOption } from "./model";
import css from "./catalog.module.css";
import { SelectField } from "../../kit/select-field";

/** Rupees typed, paise kept; blank is null ("no price": a free part). */
export function MoneyInput({ value, onChange, label, placeholder, disabled }: { value: number | null; onChange: (p: number | null) => void; label: string; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return <input className={css.money} inputMode="decimal" aria-label={label} placeholder={placeholder} disabled={disabled}
    value={text ?? (value === null ? "" : amountText(value))} onFocus={() => setText(value === null ? "" : String(value / 100))}
    onChange={(e) => { setText(e.target.value); if (e.target.value.trim() === "") onChange(null); else { const p = toPaiseLoose(e.target.value); if (p !== null) onChange(p); } }}
    onBlur={() => setText(null)} />;
}

export const EMPTY_PART: Part = { itemId: null, label: "", quantity: 1, unit: null, deliverables: [], where: "", setup: "", derives: "", price: null, cost: null };

export function PartDrawer({ setup, part, packageName, options, readOnly, busy, isNew, doneLabel, onClose, onDone, onRemove }: {
  setup?: BillingSetup; part: Part; packageName: string; options: CatalogOption[]; readOnly: boolean; busy?: boolean; isNew?: boolean;
  /** "Save part" when pressing it saves at once; "Done" when the page saves everything together. */ doneLabel: string;
  onClose: () => void; onDone: (p: Part) => void; onRemove?: () => void;
}) {
  const show = (key: Parameters<typeof showField>[1]) => showField(setup, key);
  const [p, setP] = useState<Part>(part);
  const [custom, setCustom] = useState(!deliverablesAreDefault(part));
  const [linking, setLinking] = useState(false);
  const [catalogueChoiceTouched, setCatalogueChoiceTouched] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<Part>) => { setP((x) => ({ ...x, ...patch })); setError(""); };
  const matchByName = !!isNew && !catalogueChoiceTouched;
  const item = options.find((o) => o.id === p.itemId) ?? null;
  const guess = !p.itemId && matchByName ? matchOption(p.label, options) : null;
  const linked = item ?? guess;
  const changed = JSON.stringify(p) !== JSON.stringify(part) || catalogueChoiceTouched || isNew;
  function done() {
    if (!p.label.trim()) { setError("Name the part"); return; }
    if (!Number.isFinite(p.quantity) || p.quantity <= 0) { setError("Quantity must be greater than zero"); return; }
    const finished = finishPart(p, options, custom, matchByName);
    onDone({ ...finished, ...(!show("deliverables") ? { deliverables: p.deliverables } : {}) });
  }
  const fieldsRo = readOnly || busy;
  return <Drawer title={isNew ? "New part" : part.label || "Part"} context={<span>Part of {packageName}</span>} onClose={onClose} size="md" snap="full" noAutofocus
    footer={<DrawerFooter status={error}
      primary={readOnly ? <button type="button" className={styles.btn} onClick={onClose}>Close</button>
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !changed} onClick={done}>{busy ? "Saving…" : doneLabel}</button>}>
      {!readOnly && onRemove && !isNew ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />Remove</button> : null}
    </DrawerFooter>}>
    <fieldset className={css.fieldset} disabled={fieldsRo}>
      <DrawerSection title="Part">
        <label className={styles.field}>Name<input value={p.label} onChange={(e) => set({ label: e.target.value })} placeholder="Meta Advertising Engine" data-autofocus={isNew ? "" : undefined} /></label>
        <div className={css.linkLine}>
          <Link2 size={14} aria-hidden="true" />
          {linking ? <SelectField className={styles.input} aria-label="Catalogue item" value={linked?.id ?? ""} autoFocus onChange={(e) => {
            const o = options.find((x) => x.id === e.target.value);
            setCatalogueChoiceTouched(true);
            set({ itemId: o?.id ?? null, ...(o && !p.label.trim() ? { label: o.name } : {}), ...(o && p.price === null ? { price: o.price || null } : {}) });
            setLinking(false);
          }}><option value="">Not in the catalogue (a free part)</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</SelectField>
            : <span className={css.linkText}>{linked ? (linked.name.trim().toLowerCase() === p.label.trim().toLowerCase() ? <>Catalogue item: <b>same as the part</b></> : <>Catalogue item: <b>{linked.name}</b></>) : "Not in the catalogue (a free part)"}
              {!fieldsRo ? <button type="button" className={css.inlineLink} onClick={() => setLinking(true)}>Change</button> : null}</span>}
        </div>
        <div className={css.row2}>
          <div className={styles.field}><span>Quantity</span><Stepper label="Quantity" value={p.quantity} min={0} disabled={fieldsRo}
            onChange={(n) => set({ quantity: n })} onInvalidValue={(n) => set({ quantity: n })} /></div>
          <label className={styles.field}>Unit<input value={p.unit ?? ""} placeholder="month, video…" onChange={(e) => set({ unit: e.target.value || null })} /></label>
        </div>
        <div className={css.row2}>
          <label className={styles.field}>Price ₹<MoneyInput label="Price" value={p.price} placeholder="Free part" onChange={(v) => set({ price: v })} /></label>
          {show("costMargin") ? <label className={styles.field}>Cost ₹<MoneyInput label="Cost" value={p.cost} placeholder="Not known" onChange={(v) => set({ cost: v })} /></label> : null}
        </div>
        {linked && linked.price && p.quantity ? <p className={css.hint}>Catalogue price {rupees(linked.price)} per {linked.unit}
          {p.price !== Math.round(linked.price * p.quantity) ? <>{p.price !== null ? ` · this part: ${rupees(p.price)}` : ""}
            {!fieldsRo ? <button type="button" className={css.inlineLink} onClick={() => set({ price: Math.round(linked.price * p.quantity) })}> Use {rupees(Math.round(linked.price * p.quantity))}</button> : null}</> : " · same as this part"}</p> : null}
      </DrawerSection>
      {show("deliverables") || show("partSetup") ? <DrawerSection title="What it delivers">
        {show("deliverables") ? custom ? <label className={styles.field}>Deliverables, one per line<textarea rows={3} value={p.deliverables.join("\n")}
          onChange={(e) => set({ deliverables: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} /></label>
          : <p className={css.delivers}>{p.label.trim() ? <>Delivers <b>{deliverableDefault(p)}</b></> : "Delivers what the part is called"}
            {!fieldsRo ? <button type="button" className={css.inlineLink} onClick={() => { setCustom(true); set({ deliverables: p.label.trim() ? [deliverableDefault(p)] : [] }); }}>Change</button> : null}</p> : null}
        {show("partSetup") ? <AddGroup label="More about this part">
          <AddField label="Add who sets it up" show={!!p.setup}><label className={styles.field}>Who sets it up<input value={p.setup} placeholder="Team: Performance Marketer" onChange={(e) => set({ setup: e.target.value })} /></label></AddField>
          <AddField label="Add where it lives" show={!!p.where}><label className={styles.field}>Where it lives<input value={p.where} placeholder="Drive folder, ad account, landing page" onChange={(e) => set({ where: e.target.value })} /></label></AddField>
          <AddField label="Add what it feeds" show={!!p.derives}><label className={styles.field}>What it feeds<input value={p.derives} placeholder="Lead reports, the next month's ads" onChange={(e) => set({ derives: e.target.value })} /></label></AddField>
        </AddGroup> : null}
      </DrawerSection> : null}
    </fieldset>
  </Drawer>;
}
