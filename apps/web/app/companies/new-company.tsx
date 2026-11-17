"use client";
// UX-TENANT: start setting up a company. Only a draft is made here: the company itself is created on the wizard's
// first step, after its name, code and address are checked.
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "../records";
import { styles } from "../ui";
import css from "./companies.module.css";

export function NewCompany() {
  const router = useRouter();
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function start() {
    setBusy(true); setError("");
    try { const r = await post<{ id: string }>("tenants", { name }); router.push(`/companies/${r.id}?step=company`); }
    catch (e) { setError(e instanceof Error ? e.message : "Not started"); setBusy(false); }
  }
  return <form className={css.start} onSubmit={(e) => { e.preventDefault(); void start(); }}>
    <label className={styles.field}>Company name<input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder="e.g. Atlas Crest" autoComplete="off" /></label>
    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || name.trim().length < 2}><Plus size={14} aria-hidden="true" />{busy ? "Starting…" : "Set up a company"}</button>
    {error ? <p role="alert" className={css.error} style={{ flexBasis: "100%", margin: 0 }}>{error}</p> : null}
  </form>;
}
