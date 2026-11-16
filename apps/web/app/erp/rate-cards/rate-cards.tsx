"use client";
// KAZUK-REST (6 Nov 2026; Kazuk's Quotation Builder v2, A8): the rate cards and their editor. A card belongs to a service
// in the catalogue: its base price per month, the multiplier X (what it counts and its range), the talent levels and
// periods with their factors, and the add-ons (per month or once). The example price under the form is worked out as the
// composer and the database do. Only leadership and admins save (their prices are approved prices).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, Calculator, Plus, RotateCcw, Trash2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { styles } from "../../ui";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit/drawer";
import { LineList, LineRow, amountText } from "../../kit/line-row";
import { Card, EmptyState, SectionHeader } from "../../components/calm";
import { SelectField } from "../../kit/select-field";
import { MoneyInput } from "../catalog/part-drawer";
import { cardPrice, type RateCardPick } from "../../lib/rate-card.mjs";
import css from "./rate-cards.module.css";

export type Service = { id: string; name: string; price: number; unit: string };
type Form = Omit<RateCardPick, "id"> & { id?: string };
const inr = (p: number) => `₹${amountText(p)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : "Not saved");
/** A new card starts from example levels and periods: placeholders to replace with the company's own numbers. */
const blank = (services: Service[]): Form => ({ itemId: services[0]?.id ?? "", name: services[0]?.name ?? "", base: services[0]?.price || 0, xLabel: "Scale", xMin: 1, xMax: 10,
  talents: [{ key: "junior", label: "Junior", factor: 0.8 }, { key: "standard", label: "Standard", factor: 1 }, { key: "senior", label: "Senior", factor: 1.5 }],
  periods: [{ key: "month", label: "Per month", months: 1, factor: 1 }, { key: "quarter", label: "Per quarter", months: 3, factor: 1 }], addOns: [] });
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

export function RateCards({ cards, services, canEdit }: { cards: RateCardPick[]; services: Service[]; canEdit: boolean }) {
  const [open, setOpen] = useState<Form | null>(null);
  const live = cards.filter((c) => c.status !== "archived"), old = cards.filter((c) => c.status === "archived");
  const row = (c: RateCardPick) => {
    const ex = cardPrice(c, { x: c.xMin, talent: c.talents[0]?.key ?? "", period: c.periods[0]?.key ?? "" });
    return <LineRow key={c.id} title={c.name} label={`${c.name}: ${canEdit ? "edit" : "details"}`} onOpen={() => setOpen(c)} tone={c.status === "archived" ? "muted" : undefined}
      sub={[c.serviceName, `${inr(c.base)} a month`, `${c.xLabel} ${c.xMin}–${c.xMax}`, `${c.talents.length} talent level${c.talents.length === 1 ? "" : "s"}`,
        c.periods.map((p) => p.label).join(", "), c.addOns.length ? `${c.addOns.length} add-on${c.addOns.length === 1 ? "" : "s"}` : null, c.status === "archived" ? "archived" : null].filter(Boolean).join(" · ")}
      amount={ex !== null ? inr(ex) : undefined} amountSub={ex !== null ? "from, before GST" : undefined} />;
  };
  return <div className={css.body}>
    <Card label="Rate cards" flat>
      <SectionHeader icon={<Calculator size={16} aria-hidden="true" />} title="Rate cards" count={live.length || undefined}
        hint="Base price × X × talent level × period, plus add-ons. Quotations pick them under Rate card."
        action={canEdit && services.length ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => setOpen(blank(services))}><Plus size={14} aria-hidden="true" />New rate card</button> : undefined} />
      {live.length ? <LineList label="Rate cards">{live.map(row)}</LineList>
        : <EmptyState icon={<Calculator size={18} aria-hidden="true" />} title="No rate cards yet"
          text={!services.length ? "Add a service in Catalogue first: a rate card prices one service." : canEdit ? "Make one for a service: its base price a month, what X counts, the talent levels and the periods." : "Leadership or an admin makes rate cards."} />}
    </Card>
    {old.length ? <Card label="Archived" flat><SectionHeader title="Archived" count={old.length} /><LineList label="Archived rate cards">{old.map(row)}</LineList></Card> : null}
    {!canEdit ? <p className={css.note}>Only leadership or an admin changes a rate card: its prices are approved prices. A different price on a quotation is a request they approve.</p> : null}
    {open ? <CardDrawer form={open} services={services} canEdit={canEdit} onClose={() => setOpen(null)} /> : null}
  </div>;
}

function CardDrawer({ form, services, canEdit, onClose }: { form: Form; services: Service[]; canEdit: boolean; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState<Form>(form), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [xs, setXs] = useState({ min: String(form.xMin), max: String(form.xMax) });
  const set = (patch: Partial<Form>) => { setF((x) => ({ ...x, ...patch })); setError(null); };
  const ex = cardPrice(f, { x: f.xMin, talent: f.talents[0]?.key ?? "", period: f.periods[f.periods.length - 1]?.key ?? "" });
  const exT = f.talents[0], exP = f.periods[f.periods.length - 1];
  async function save(status?: "archived" | "active") {
    setBusy(true); setError(null);
    try {
      const { id, ...body } = f;
      await post(id ? `erp/rate-cards/${id}` : "erp/rate-cards", status ? { status } : body);
      notify({ id: "rate-card", tone: "success", title: status === "archived" ? "Rate card archived" : status === "active" ? "Rate card back in use" : "Rate card saved", timeout: 2500 });
      onClose(); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const ro = !canEdit || busy;
  return <Drawer title={form.id ? form.name : "New rate card"} context={form.id ? `Version ${form.version ?? 1}` : "Prices a service from the catalogue"} onClose={onClose} size="md" snap="full" noAutofocus
    footer={<DrawerFooter status={error} primary={canEdit ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save rate card"}</button>
      : <button type="button" className={styles.btn} onClick={onClose}>Close</button>}>
      {canEdit && form.id ? form.status === "archived" ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => void save("active")}><RotateCcw size={14} aria-hidden="true" />Use again</button>
        : <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => void save("archived")}><Archive size={14} aria-hidden="true" />Archive</button> : null}
    </DrawerFooter>}>
    <fieldset className={css.fieldset} disabled={ro}>
      <DrawerSection title="Service">
        <label className={styles.field}>Service in the catalogue<SelectField value={f.itemId} onChange={(e) => { const s = services.find((x) => x.id === e.target.value); set({ itemId: e.target.value, ...(s && !f.id && (!f.name || services.some((x) => x.name === f.name)) ? { name: s.name } : {}) }); }}>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField></label>
        <label className={styles.field}>Name on quotations<input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} /></label>
        <label className={styles.field}>Base price a month (before GST) ₹<MoneyInput label="Base price a month" value={f.base || null} onChange={(p) => set({ base: p ?? 0 })} /></label>
      </DrawerSection>
      <DrawerSection title="Multiplier X" help="What X counts (creatives, platforms, shoots) and the range a quotation may choose.">
        <div className={css.grid3}>
          <label className={styles.field}>X counts<input value={f.xLabel} onChange={(e) => set({ xLabel: e.target.value })} maxLength={40} /></label>
          <label className={styles.field}>Lowest<input inputMode="decimal" value={xs.min} onChange={(e) => { setXs({ ...xs, min: e.target.value }); set({ xMin: num(e.target.value) }); }} /></label>
          <label className={styles.field}>Highest<input inputMode="decimal" value={xs.max} onChange={(e) => { setXs({ ...xs, max: e.target.value }); set({ xMax: num(e.target.value) }); }} /></label>
        </div>
      </DrawerSection>
      <DrawerSection title="Talent levels" help="Each level's factor multiplies the base (1 = the base price).">
        {f.talents.map((t, i) => <div key={i} className={css.grid3}>
          <label className={styles.field}>Level<input value={t.label} onChange={(e) => set({ talents: f.talents.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)) })} /></label>
          <label className={styles.field}>Factor<input inputMode="decimal" defaultValue={String(t.factor)} onChange={(e) => set({ talents: f.talents.map((x, n) => (n === i ? { ...x, factor: num(e.target.value) } : x)) })} /></label>
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} aria-label={`Remove ${t.label || "this level"}`} disabled={f.talents.length < 2} onClick={() => set({ talents: f.talents.filter((_, n) => n !== i) })}><Trash2 size={14} aria-hidden="true" /></button>
        </div>)}
        {f.talents.length < 8 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => set({ talents: [...f.talents, { key: "", label: "", factor: 1 }] })}><Plus size={13} aria-hidden="true" />Add a level</button> : null}
      </DrawerSection>
      <DrawerSection title="Periods" help="Months billed together; a factor below 1 is the discount for the longer period.">
        {f.periods.map((p, i) => <div key={i} className={css.grid4}>
          <label className={styles.field}>Period<input value={p.label} onChange={(e) => set({ periods: f.periods.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)) })} /></label>
          <label className={styles.field}>Months<input inputMode="numeric" defaultValue={String(p.months)} onChange={(e) => set({ periods: f.periods.map((x, n) => (n === i ? { ...x, months: num(e.target.value) } : x)) })} /></label>
          <label className={styles.field}>Factor<input inputMode="decimal" defaultValue={String(p.factor)} onChange={(e) => set({ periods: f.periods.map((x, n) => (n === i ? { ...x, factor: num(e.target.value) } : x)) })} /></label>
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} aria-label={`Remove ${p.label || "this period"}`} disabled={f.periods.length < 2} onClick={() => set({ periods: f.periods.filter((_, n) => n !== i) })}><Trash2 size={14} aria-hidden="true" /></button>
        </div>)}
        {f.periods.length < 8 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => set({ periods: [...f.periods, { key: "", label: "", months: 6, factor: 1 }] })}><Plus size={13} aria-hidden="true" />Add a period</button> : null}
      </DrawerSection>
      <DrawerSection title="Add-ons" help="Extras a quotation can tick: priced per month of the period, or once.">
        {f.addOns.map((a, i) => <div key={i} className={css.grid4}>
          <label className={styles.field}>Add-on<input value={a.label} onChange={(e) => set({ addOns: f.addOns.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)) })} /></label>
          <label className={styles.field}>Price ₹<MoneyInput label={`${a.label || "Add-on"} price`} value={a.price} onChange={(p) => set({ addOns: f.addOns.map((x, n) => (n === i ? { ...x, price: p ?? 0 } : x)) })} /></label>
          <label className={styles.field}>Charged<SelectField value={a.per} onChange={(e) => set({ addOns: f.addOns.map((x, n) => (n === i ? { ...x, per: e.target.value === "once" ? "once" : "month" } : x)) })}>
            <option value="month">Per month</option><option value="once">Once</option></SelectField></label>
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} aria-label={`Remove ${a.label || "this add-on"}`} onClick={() => set({ addOns: f.addOns.filter((_, n) => n !== i) })}><Trash2 size={14} aria-hidden="true" /></button>
        </div>)}
        {f.addOns.length < 12 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => set({ addOns: [...f.addOns, { key: "", label: "", price: 0, per: "month" }] })}><Plus size={13} aria-hidden="true" />Add an add-on</button> : null}
      </DrawerSection>
    </fieldset>
    <DrawerSection title="Example">
      <p className={css.note}>{ex !== null && exT && exP ? <>{exT.label}, {exP.label.toLowerCase()}, {f.xLabel.toLowerCase()} {f.xMin}: <b>{inr(ex)}</b> before GST</> : "Fill the base price, a level, a period and X to see a price."}</p>
    </DrawerSection>
  </Drawer>;
}
