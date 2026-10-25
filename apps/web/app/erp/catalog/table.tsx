"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../../records";
import { packOf, type BillingSetup } from "../settings/fields";
import { styles } from "../../ui";

const KIND: Record<string, string> = { service: "Service", product: "Product", consumable: "Consumable", package: "Package" };

export function NewItem({ setup }: { setup?: BillingSetup }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [kind, setKind] = useState<string>(packOf(setup?.pack)?.defaultKind ?? "service"), [name, setName] = useState(""), [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try { const r = await post<{ id: string }>("erp/items", { kind, name, gstRate: 18, unit: kind === "package" ? "package" : "nos" }); router.push(`/erp/catalog/${r.id}`); }
    catch (e) { notify({ id: "erp-item", tone: "error", title: "Not created", message: e instanceof Error ? e.message : "Could not save" }); setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => { setKind(packOf(setup?.pack)?.defaultKind ?? "service"); setOpen(true); }}><Plus size={14} aria-hidden="true" />New item</button>
    {open ? <Modal title="New catalogue item" sub="Parts, prices and the billing plan follow on its page" onClose={() => setOpen(false)}
      foot={<><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !name.trim()} onClick={create}>Create</button></>}>
      <div style={{ display: "grid", gap: 12 }}>
        <div className={styles.segmented} role="group" aria-label="Kind">{["service", "product", "consumable", "package"].map((k) => <button key={k} type="button" className={styles.segment} aria-pressed={k === kind} onClick={() => setKind(k)}>{KIND[k]}</button>)}</div>
        <label className={styles.field}>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "package" ? "4 Month real-estate marketing" : "Model-led brand film"} autoFocus /></label>
      </div>
    </Modal> : null}
  </>;
}
