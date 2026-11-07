"use client";

// BILLING (owner, 4 Nov 2026; Kazuk, 3 Nov): a project its paid invoice started tells the project heads "a new client has
// come in"; either head chooses who owns it (the growth strategist) and the client category (sell-out, competitive or
// normal, from the delivery template). Until then the project has no owner, and this is the one thing its page asks.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import { SelectField } from "../kit/select-field";
import css from "./overview.module.css";

export type Assign = { id: string; title: string; location: string | null; client: string | null; invoice: string | null; quotation: string | null; ownerId: string | null; category: string | null;
  needed: boolean; canAssign: boolean; categories: { key: string; label: string }[]; owners: { id: string; name: string; strategist: boolean }[];
  /** KAZUK-FLOW G11: the suggested PGS (the client's earlier one, else the least loaded), for a person to confirm. */
  suggest?: { id: string; name: string; pod: string | null; load: number; why: string }[] };

export function AssignClient({ a }: { a: Assign }) {
  const router = useRouter();
  const [owner, setOwner] = useState(a.ownerId ?? a.suggest?.[0]?.id ?? ""), [category, setCategory] = useState(a.category ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const from = [a.client, a.invoice ? `invoice ${a.invoice} paid` : null, a.quotation ? `from quotation ${a.quotation}` : null, a.location].filter(Boolean).join(" · ");
  if (!a.canAssign) return <div className={css.planCallout} role="status"><UserCheck size={18} aria-hidden="true" />
    <div><b>New client: waiting for a project head</b><span>{from}. A project head chooses who owns it and the client category.</span></div></div>;
  async function save() {
    setBusy(true); setError("");
    try {
      await post(`projects/${a.id}/assign`, { ownerId: owner, category });
      notify({ id: "assign", tone: "success", title: "Project assigned", message: "The PGS is told; the handover and the quotation's work are theirs.", timeout: 4000 });
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  const strategists = a.owners.filter((p) => p.strategist), others = a.owners.filter((p) => !p.strategist);
  return <section className={css.planCallout} aria-label="Assign the new client">
    <UserCheck size={18} aria-hidden="true" />
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, flex: 1 }}>
      <div style={{ display: "grid", gap: 2 }}><b>New client: choose the PGS and the client category</b><span>{from}</span></div>
      {a.suggest?.length ? <p style={{ margin: 0 }} data-pgs-suggest="">Suggested: {a.suggest.slice(0, 3).map((x, n) => <span key={x.id}>{n ? "; " : ""}<button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`}
        onClick={() => setOwner(x.id)} aria-pressed={owner === x.id}>{x.name}</button> {x.why}{x.pod ? ` · ${x.pod}` : ""}</span>)}</p> : null}
      <div className={css.twoFields} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
        <label className={styles.field}>PGS (head and point of contact)<SelectField value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Choose…</option>
          {strategists.length ? <optgroup label="Growth strategists">{strategists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup> : null}
          {others.length ? <optgroup label="Everyone else">{others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup> : null}
        </SelectField></label>
        <label className={styles.field}>Client category<SelectField value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Choose…</option>{a.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</SelectField></label>
      </div>
      {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      <div><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !owner || !category} onClick={() => void save()}>Assign the project</button></div>
    </div>
  </section>;
}
