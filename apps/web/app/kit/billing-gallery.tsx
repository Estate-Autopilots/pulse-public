"use client";
// BILLING-KIT: the billing parts on /kit (one-line rows with +/−, an open amount, "More details", "+ Add", the chain bar,
// the next step and a Drawer with section tabs and snap heights), with a made-up quotation. Nothing reads or writes data.
import { useState } from "react";
import { Drawer, DrawerFooter, DrawerSection } from "./drawer";
import { AddField, AddGroup, Disclosure } from "./disclosure";
import { LineList, LineRow, OpenAmount, Stepper, amountText } from "./line-row";
import { ChainBar, NextStep } from "./next-step";
import css from "./gallery.module.css";

const PRICE = 37999900;

export function BillingGallery() {
  const [qty, setQty] = useState(1);
  const [install, setInstall] = useState<number | null>(null), [installNo, setInstallNo] = useState(false);
  const [where, setWhere] = useState("");
  const [open, setOpen] = useState(false);
  const left = install === null && !installNo ? 1 : 0;
  const total = PRICE * qty + (installNo ? 0 : install ?? 0);
  return <section className={css.card} aria-labelledby="k-billing"><h2 id="k-billing">Billing parts</h2>
    <ChainBar steps={[{ key: "quotation", label: "Quotation" }, { key: "proforma", label: "Proforma" }, { key: "invoice", label: "Tax invoice" }]} current="quotation" />
    <LineList label="Lines">
      <LineRow title="PP-15.0L system" sub="₹3,79,999 incl. GST · 6 in stock" amount={`₹${amountText(PRICE * qty)}`} onOpen={() => setOpen(true)}
        end={<Stepper label="Quantity of PP-15.0L" value={qty} min={1} max={20} onChange={setQty} />} />
      <LineRow title="Installation & commissioning" sub="Changes by site" tone={left ? "needed" : undefined}
        end={<OpenAmount label="Installation amount" value={install} notNeeded={installNo} onChange={setInstall} onNotNeeded={setInstallNo} />} />
      <LineRow title="Extended warranty" sub="Free part" tone="muted" amount="—" />
    </LineList>
    <Disclosure hint="delivery basis, validity, notes">
      <AddGroup label="Optional fields">
        <AddField label="Add where it lives" show={!!where}><label className={css.row}><span>Where</span><input className={css.field} value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Drive folder, ad account" /></label></AddField>
        <AddField label="Add a note for the customer" show={false}><input className={css.field} aria-label="Note for the customer" /></AddField>
      </AddGroup>
    </Disclosure>
    <NextStep status={left ? "Fill 1 amount to approve" : `Total ₹${amountText(total)}`} tone={left ? "warning" : "info"}
      secondary={<button type="button" className={css.btn}>Save draft</button>}
      primary={<button type="button" className={css.btn} disabled={!!left}>{left ? "Fill 1 amount" : "Approve"}</button>} />
    {open ? <Drawer title="PP-15.0L system" context={`Total ₹${amountText(total)}`} onClose={() => setOpen(false)} snap="half"
      panes={[{ key: "line", label: "Line", content: <DrawerSection title="Quantity"><Stepper label="Quantity in the sheet" value={qty} min={1} onChange={setQty} /></DrawerSection> },
        { key: "terms", label: "Terms", content: <DrawerSection title="Delivery"><p className={css.note}>Delivered to site · valid 15 days</p></DrawerSection> },
        { key: "activity", label: "Activity", count: 2, content: <DrawerSection title="Activity"><p className={css.note}>Draft made from the call · price request waiting</p></DrawerSection> }]}
      footer={<DrawerFooter primary={<button type="button" className={css.btn} onClick={() => setOpen(false)}>Done</button>} />} /> : null}
  </section>;
}
