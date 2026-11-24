"use client";
// CONTRACTS-3 (owner, 8 Nov: "the parties must come from existing clients, people and companies, including the point of
// contact and their details"): a side's point of contact (name, phone, e-mail) under its name, filled from the quotation
// or the client's contacts; who runs the agreement changes it in place.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Mail, Pencil, Phone } from "lucide-react";
import { post } from "../../orgs/client";
import { toast } from "../../kit/dialogs";
import type { Party } from "../parts";
import css from "../contracts.module.css";
import d3 from "./drafts.module.css";

export function PartyContact({ contractId, p, run, ours }: { contractId: string; p: Party; run: boolean; /** Our own side: its contact is optional, so no empty "Add" line for it. */ ours?: boolean }) {
  const router = useRouter();
  const poc = p.poc ?? { name: null, phone: null, email: null };
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await post(`contracts/${contractId}/parties/${p.key}/contact`, { name: String(f.get("name") ?? ""), phone: String(f.get("phone") ?? ""), email: String(f.get("email") ?? "") });
      toast.success("Contact saved"); setOpen(false); router.refresh();
    } catch (x) { setError(x instanceof Error ? x.message : "That did not work. Try again."); } finally { setBusy(false); }
  }
  const has = poc.name || poc.phone || poc.email;
  if (open) return <form className={`${css.form} ${d3.pocForm}`} onSubmit={save} aria-label={`Point of contact for ${p.name}`}>
    <div className={css.row}>
      <label className={css.field}>Contact name<input name="name" defaultValue={poc.name ?? ""} maxLength={160} placeholder="Full name" autoComplete="off" /></label>
      <label className={css.field}>Phone<input name="phone" type="tel" defaultValue={poc.phone ?? ""} maxLength={32} placeholder="+91 …" autoComplete="off" /></label>
      <label className={css.field}>Email<input name="email" type="email" defaultValue={poc.email ?? ""} maxLength={254} placeholder="name@example.com" autoComplete="off" /></label>
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}>
      <button type="submit" className={css.btn} disabled={busy}>{busy ? "Saving…" : "Save contact"}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  </form>;
  if (!has && (!run || ours)) return null;
  return <span className={d3.pocLine}>
    {has ? <>
      <span>{`Contact: ${poc.name ?? "not named"}`}</span>
      {poc.phone ? <a href={`tel:${poc.phone.replace(/[^0-9+]/g, "")}`}><Phone size={13} aria-hidden="true" />{poc.phone}</a> : null}
      {poc.email ? <a href={`mailto:${poc.email}`}><Mail size={13} aria-hidden="true" />{poc.email}</a> : null}
    </> : null}
    {run ? <button type="button" className={d3.linkBtn} onClick={() => setOpen(true)}><Pencil size={13} aria-hidden="true" />{has ? "Change" : "Add a contact"}</button> : null}
  </span>;
}
