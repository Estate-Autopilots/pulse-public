"use client";
// CONNECTORS-CONTRACTS: draft a contract from a template (admins, leadership and Finance). This company is one party;
// the other is a company on Vitals OS (its exact handle), someone in this company, anyone with a Vitals OS account (their
// exact handle or e-mail), or a company or person off Vitals OS by name. The terms open on the contract's page.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { post } from "../orgs/client";
import { ROLE_WORDS } from "../lib/contracts.mjs";
import type { Choices, Contract } from "./parts";
import css from "./contracts.module.css";
import { DateField } from "../kit/date-field";

type Other = "company" | "member" | "account" | "outside";
type Found = { id: string; name: string } | null;
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function NewContract({ choices }: { choices: Choices }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<string>(choices.templates[0]?.key ?? "services");
  const [other, setOther] = useState<Other>("company");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = choices.templates.find((x) => x.key === template);
  const [ourRole, theirRole] = t?.roles ?? ["provider", "client"];

  async function find() {
    setError(null); setFound(null);
    try {
      const r = await fetch(`/api/v0/contracts-find?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const d = r.ok ? await r.json() as { account: Found; company: Found } : null;
      const hit = other === "company" ? d?.company : d?.account;
      if (hit) setFound(hit); else setError(other === "company" ? "No company on Vitals OS has that handle." : "No Vitals OS account has that handle or e-mail.");
    } catch { setError("Could not look that up. Try again."); }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const them = other === "company" ? (found ? { kind: "company", role: theirRole, orgId: found.id } : null)
      : other === "account" ? (found ? { kind: "person", role: theirRole, accountId: found.id } : null)
      : other === "member" ? { kind: "person", role: theirRole, personId: text("personId") }
      : { kind: text("outsideKind") === "person" ? "person" : "company", role: theirRole, name: text("outsideName") };
    if (!them) { setError("Find the other party first."); return; }
    setBusy(true); setError(null);
    try {
      const r = await post<{ contract: Contract }>("contracts", { template, title: text("title") || undefined, startsOn: text("startsOn") || null,
        parties: [{ kind: "company", role: ourRole, orgId: choices.us.id }, them] });
      router.push(`/contracts/${r.contract.id}`);
      router.refresh();
    } catch (err) { setError(say(err)); }
    finally { setBusy(false); }
  }

  if (!open) return <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />New contract</button>;
  return <form className={`${css.panel} ${css.form}`} onSubmit={submit} aria-label="New contract">
    <h2>New contract</h2>
    <div className={css.templates} role="group" aria-label="Start from">
      {choices.templates.map((x) => <button key={x.key} type="button" className={`${css.btn} ${css.template}`} aria-pressed={template === x.key} onClick={() => setTemplate(x.key)}>
        {x.name}<span>{x.summary}</span>
      </button>)}
    </div>
    <label className={css.field}>Name<input name="title" maxLength={160} placeholder={t?.name ?? "Contract"} /></label>
    <div className={css.row}>
      <label className={css.field}>{`${choices.us.name} is the`}<input value={(ROLE_WORDS as Record<string, string>)[ourRole] ?? ourRole} readOnly /></label>
      <label className={css.field}>The other party
        <select value={other} onChange={(e) => { setOther(e.target.value as Other); setFound(null); setError(null); }}>
          <option value="company">A company on Vitals OS</option>
          <option value="member">{`Someone in ${choices.us.name}`}</option>
          <option value="account">A person with a Vitals OS account</option>
          <option value="outside">{`A company or person off Vitals OS`}</option>
        </select>
      </label>
      <label className={css.field}>Starts on<DateField name="startsOn"/></label>
    </div>
    {other === "company" || other === "account" ? <div className={css.actions}>
      <label className={css.field} style={{ flex: 1 }}>{other === "company" ? "Their company handle" : "Their handle or e-mail"}
        <input value={query} onChange={(e) => { setQuery(e.target.value); setFound(null); }} placeholder={other === "company" ? "For example: their-company" : "name@example.com"} />
      </label>
      <button type="button" className={css.btn} onClick={find} disabled={!query.trim()}>Find</button>
      {found ? <p className={css.hint}>{`Found: ${found.name} (${(ROLE_WORDS as Record<string, string>)[theirRole] ?? theirRole})`}</p> : null}
    </div> : null}
    {other === "member" ? <label className={css.field}>{`Who (${(ROLE_WORDS as Record<string, string>)[theirRole] ?? theirRole})`}
      <select name="personId" required>{choices.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    </label> : null}
    {other === "outside" ? <div className={css.row}>
      <label className={css.field}>Their name<input name="outsideName" required maxLength={160} /></label>
      <label className={css.field}>They are
        <select name="outsideKind"><option value="company">A company</option><option value="person">A person</option></select>
      </label>
    </div> : null}
    <p className={css.hint}>Only {choices.us.name} sees a draft. Change the terms on the next page, then send it for acceptance.</p>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}>
      <button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Saving…" : "Draft contract"}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  </form>;
}
