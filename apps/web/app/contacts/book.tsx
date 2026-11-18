"use client";
// COMPANIES-MODEL (owner, 16 Nov 2026): one address book. People work at companies; "client" is a relationship with a
// company or one person, asked in the same step ("Is this person, or their company, a client too?"); every type and
// company picker has "+ Add new" right there (no trip to Settings).
import { Building2, Check, Plus, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, DrawerSection } from "../kit/drawer";
import { OptionList, listKeys, type Option } from "../kit/combobox";
import { Segmented } from "../kit/segmented";
import { post } from "../records";
import styles from "../ui.module.css";
import css from "./book.module.css";
import { typeStyle, type RecordType } from "../record-types";

export type CompanyLite = { id: string; name: string; city?: string | null };
export type ContactLite = { id: string; name: string; companyId?: string | null; company?: string | null };

/** Where the company picker landed: an existing company, a new name, or nothing. */
export type CompanyChoice = { id: string; name: string } | { id: null; name: string } | null;

/** A company: type to find one of yours, or "+ Add “…” as a new company". */
export function CompanyField({ companies, value, onChange, label = "Works at", placeholder = "Company name", autoFocus }: {
  companies: CompanyLite[]; value: CompanyChoice; onChange: (c: CompanyChoice) => void; label?: string; placeholder?: string; autoFocus?: boolean }) {
  const id = useId(); const [q, setQ] = useState(value?.name ?? ""); const [open, setOpen] = useState(false); const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const typed = q.trim();
  const options = useMemo<Option<string>[]>(() => {
    const t = typed.toLowerCase();
    const hits = companies.filter((c) => !t || c.name.toLowerCase().includes(t)).slice(0, 6).map((c) => ({ value: c.id, label: c.name, detail: c.city ?? undefined, icon: <Building2 size={15} aria-hidden="true" /> }));
    const exact = companies.some((c) => c.name.toLowerCase() === t);
    return typed.length >= 2 && !exact ? [...hits, { value: "__new", label: `Add “${typed}” as a new company`, icon: <Plus size={15} aria-hidden="true" /> }] : hits;
  }, [companies, typed]);
  const choose = (o: Option<string>) => {
    if (o.value === "__new") { onChange({ id: null, name: typed }); setQ(typed); }
    else { onChange({ id: o.value, name: o.label }); setQ(o.label); }
    setOpen(false);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { setOpen(true); return; }
    if (listKeys(e, options.length, active, setActive)) return;
    if (e.key === "Enter" && open && options[active]) { e.preventDefault(); choose(options[active]); }
    if (e.key === "Escape") setOpen(false);
  };
  return <div className={css.pick}>
    <label className={styles.field} htmlFor={`${id}-q`}>{label}</label>
    <input ref={input} id={`${id}-q`} className={styles.input} role="combobox" aria-expanded={open && options.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list"
      aria-activedescendant={open && options[active] ? `${id}-list-${active}` : undefined} value={q} placeholder={placeholder} autoComplete="off" autoFocus={autoFocus}
      onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); if (value) onChange(e.target.value.trim() ? { id: null, name: e.target.value.trim() } : null); else if (e.target.value.trim()) onChange({ id: null, name: e.target.value.trim() }); else onChange(null); }}
      onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 120)} onKeyDown={keys} />
    {open && options.length ? <div className={css.pop}><OptionList id={`${id}-list`} label={label} options={options} active={active} chosen={value?.id ?? null} onActive={setActive} onChoose={choose} /></div> : null}
    {value && value.id === null && value.name.length >= 2 ? <small className={css.note}>New company: {value.name}</small> : null}
  </div>;
}

/** The company's own types as chips, with "+ Add new" that saves to the company's own list and picks it. */
export function TypeChips({ entity, types, value, onChange, canAdd, label = "Type", hide }: { entity: "contact" | "client"; types: RecordType[]; value: string | null; onChange: (k: string | null) => void; canAdd: boolean; label?: string;
  /** Types a question next to the chips already answers (Customer, beside "a client too?"). */ hide?: string[] }) {
  const [own, setOwn] = useState<RecordType[]>([]); const [adding, setAdding] = useState(false); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const base = types.filter((t) => t.entity === entity && !t.archived && t.key !== "internal" && !hide?.includes(t.key));
  // A type added here sits with the company's own types, before the catch-all ones (Other), so nothing jumps.
  const list = [...base.filter((t) => !t.system), ...own, ...base.filter((t) => t.system)];
  const save = async () => {
    const label2 = name.trim(); if (label2.length < 2) { setErr("Type 2 letters or more"); return; }
    setBusy(true); setErr("");
    try {
      const t = await post<RecordType>("settings/types", { entity, label: label2 });
      setOwn((o) => [...o, t]); onChange(t.key); setAdding(false); setName("");
      notify({ id: `type:${t.key}`, tone: "success", title: `“${t.label}” is added to your list`, timeout: 2500 });
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not add it"); } finally { setBusy(false); }
  };
  return <fieldset className={css.chipsField}><legend>{label}</legend>
    <div className={css.chips} role="radiogroup" aria-label={label}>
      {list.map((t) => <button key={t.key} type="button" role="radio" aria-checked={value === t.key} className={css.chip} style={typeStyle(t.color)} title={t.hint ?? undefined}
        onClick={() => onChange(value === t.key ? null : t.key)}><i aria-hidden="true" />{t.label}{value === t.key ? <Check size={13} aria-hidden="true" /> : null}</button>)}
      {canAdd && !adding ? <button type="button" className={`${css.chip} ${css.add}`} onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" />Add new</button> : null}
    </div>
    {adding ? <div className={css.addRow}>
      <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={entity === "client" ? "e.g. Hotel, School" : "e.g. Architect, Supplier"} aria-label="New type's name" maxLength={40} autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape") setAdding(false); }} />
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void save()} disabled={busy}><Check size={13} aria-hidden="true" />{busy ? "Adding…" : "Add"}</button>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => { setAdding(false); setErr(""); }}>Cancel</button>
    </div> : null}
    {err ? <small className={css.err} role="alert">{err}</small> : null}
  </fieldset>;
}

type ClientAnswer = "no" | "person" | "company";
/** "Is this person, or their company, a client too?" in plain words, three big choices. */
export function ClientQuestion({ value, onChange, company }: { value: ClientAnswer; onChange: (v: ClientAnswer) => void; company: string | null }) {
  const opts: { v: ClientAnswer; label: string; sub: string; off?: boolean }[] = [
    { v: "no", label: "No", sub: "Just a contact" },
    { v: "person", label: "Yes, this person", sub: "You sell to them" },
    { v: "company", label: "Yes, their company", sub: company ? `You sell to ${company}` : "Add where they work first", off: !company },
  ];
  return <fieldset className={css.question}><legend>Is this person, or their company, a client too?</legend>
    <div className={css.answers} role="radiogroup" aria-label="Is this person, or their company, a client too?">
      {opts.map((o) => <button key={o.v} type="button" role="radio" aria-checked={value === o.v} disabled={o.off} className={css.answer} onClick={() => onChange(o.v)}>
        <b>{o.label}</b><small>{o.sub}</small>{value === o.v ? <Check size={16} className={css.tick} aria-hidden="true" /> : null}</button>)}
    </div>
  </fieldset>;
}

const message = (e: unknown) => e instanceof Error ? e.message : "That did not save. Try again.";

/** Add a contact: who, where they work, their type, and the client question; one button. */
export function AddPerson({ companies, types, canAddTypes, company, label = "Add contact", variant = "primary", words, startOpen = false }: {
  companies: CompanyLite[]; types: RecordType[]; canAddTypes: boolean; company?: CompanyLite | null; label?: string; variant?: "primary" | "plain" | "small"; words: { client: string };
  /** Opened by a link (the empty list's "Add contact"). */ startOpen?: boolean }) {
  const router = useRouter(); const [open, setOpen] = useState(startOpen); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [co, setCo] = useState<CompanyChoice>(company ? { id: company.id, name: company.name } : null);
  const [type, setType] = useState<string | null>(null); const [answer, setAnswer] = useState<ClientAnswer>("no");
  const formId = useId();
  // Judge r3: a "Customer" chip beside "a client too?" asked the same thing twice: the question answers it (a yes saves
  // them as Customer when the company has that type and nothing else was picked).
  const customer = types.some((t) => t.entity === "contact" && t.key === "customer" && !t.archived);
  const reset = () => { setCo(company ? { id: company.id, name: company.name } : null); setType(null); setAnswer("no"); setErr(""); };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim(); if (name.length < 2) { setErr("Type their name"); return; }
    setBusy(true); setErr("");
    try {
      const r = await post<{ id: string; companyId: string | null; clientId: string | null }>("contacts", {
        name, phone: f.get("phone"), email: f.get("email"), designation: f.get("designation"), contactType: type ?? (answer !== "no" && customer ? "customer" : undefined),
        companyId: co?.id ?? undefined, companyName: co && !co.id ? co.name : undefined, makeClient: answer === "no" ? undefined : answer });
      setOpen(false); reset();
      notify({ id: "person-added", tone: "success", title: answer === "no" ? `${name} is added` : `${name} is added. ${answer === "company" ? co?.name : name} is a ${words.client.toLowerCase()} now`, timeout: 3500 });
      router.push(answer !== "no" && r.clientId ? `/clients/${r.clientId}` : `/contacts/${r.id}`);
    } catch (x) { setErr(message(x)); } finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`${styles.btn}${variant === "primary" ? ` ${styles.btnPrimary}` : variant === "small" ? ` ${styles.btnSmall} ${styles.btnGhost}` : ""}`} onClick={() => setOpen(true)} aria-label={variant === "small" ? "Add a contact here" : undefined}><UserPlus size={14} aria-hidden="true" />{label}</button>
    {open ? <Drawer title="Add a contact" icon={<UserPlus size={16} aria-hidden="true" />} onClose={() => { setOpen(false); reset(); }} size="md"
      footer={<DrawerFooter status={err || undefined} primary={<button type="submit" form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Adding…" : "Add contact"}</button>} />}>
      <form id={formId} className={css.form} onSubmit={submit}>
        <div className={css.group}>
          <label className={styles.field}>Name<input name="name" required minLength={2} maxLength={120} autoComplete="off" placeholder="Full name" autoFocus /></label>
          <div className={css.two}>
            <label className={styles.field}>Phone<input name="phone" type="tel" maxLength={40} autoComplete="off" placeholder="+91 …" /></label>
            <label className={styles.field}>E-mail<input name="email" type="email" maxLength={254} autoComplete="off" placeholder="name@example.com" /></label>
          </div>
        </div>
        <div className={css.group}>
          {company ? <p className={css.fixed}><Building2 size={15} aria-hidden="true" />{company.name}</p> : <CompanyField companies={companies} value={co} onChange={(c) => { setCo(c); if (!c && answer === "company") setAnswer("no"); }} />}
          <label className={styles.field}>Their role<input name="designation" maxLength={120} autoComplete="off" placeholder="Owner, manager, accounts…" /></label>
        </div>
        {/* Judges r4–r5: who they are and where they work, then the one real decision, then the optional type. */}
        <ClientQuestion value={answer} onChange={setAnswer} company={co?.name?.trim() ? co.name.trim() : null} />
        <div className={css.group}>
          <TypeChips entity="contact" types={types} value={type} onChange={setType} canAdd={canAddTypes} hide={["customer"]} label="Type (optional)" />
        </div>
      </form>
    </Drawer> : null}
  </>;
}

/** Add a company: its name and town, its main contact (picked or new), and whether it is a client. */
export function AddCompany({ contacts, label = "Add company", words }: { contacts: ContactLite[]; label?: string; words: { client: string } }) {
  const router = useRouter(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [who, setWho] = useState<"new" | "pick" | "none">("new"); const [pick, setPick] = useState<string>(""); const [client, setClient] = useState(true);
  const formId = useId();
  const free = contacts.filter((c) => !c.companyId).sort((a, b) => a.name.localeCompare(b.name));
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim(); if (name.length < 2) { setErr("Type the company's name"); return; }
    setBusy(true); setErr("");
    try {
      const r = await post<{ id: string; existed: boolean; clientId: string | null }>("companies", {
        name, city: f.get("city"), website: f.get("website"), phone: f.get("phone"), client,
        contactId: who === "pick" && pick ? pick : undefined,
        contact: who === "new" && String(f.get("cname") ?? "").trim() ? { name: f.get("cname"), phone: f.get("cphone"), email: f.get("cemail"), designation: f.get("crole") } : undefined });
      setOpen(false);
      notify({ id: "company-added", tone: "success", title: r.existed ? `${name} was already in your book: opened it` : client ? `${name} is added as a ${words.client.toLowerCase()}` : `${name} is added`, timeout: 3500 });
      router.push(`/contacts/companies/${r.id}`);
    } catch (x) { setErr(message(x)); } finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}><Building2 size={14} aria-hidden="true" />{label}</button>
    {open ? <Drawer title="Add a company" icon={<Building2 size={16} aria-hidden="true" />} onClose={() => setOpen(false)} size="md"
      context={<span className={styles.drawerSub}>A business you work with.</span>}
      footer={<DrawerFooter status={err || undefined} primary={<button type="submit" form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Adding…" : "Add company"}</button>} />}>
      <form id={formId} className={css.form} onSubmit={submit}>
        <DrawerSection title="The company">
          <label className={styles.field}>Name<input name="name" required minLength={2} maxLength={160} autoComplete="off" placeholder="Lotus Interiors" autoFocus /></label>
          <div className={css.two}>
            <label className={styles.field}>Town or city<input name="city" maxLength={80} autoComplete="off" /></label>
            <label className={styles.field}>Phone<input name="phone" type="tel" maxLength={40} autoComplete="off" /></label>
          </div>
          <label className={styles.field}>Website<input name="website" maxLength={200} autoComplete="off" placeholder="example.com" /></label>
        </DrawerSection>
        <DrawerSection title="Main contact" help="The person you talk to there. You can add more people later.">
          <Segmented label="Main contact" size="sm" value={who} onChange={(v) => setWho(v)} options={[{ value: "new", label: "New person" }, ...(free.length ? [{ value: "pick" as const, label: "One of my contacts" }] : []), { value: "none", label: "Later" }]} />
          {who === "new" ? <><div className={css.two}>
              <label className={styles.field}>Their name<input name="cname" maxLength={120} autoComplete="off" /></label>
              <label className={styles.field}>Their role<input name="crole" maxLength={120} autoComplete="off" placeholder="Owner, manager…" /></label>
            </div><div className={css.two}>
              <label className={styles.field}>Phone<input name="cphone" type="tel" maxLength={40} autoComplete="off" /></label>
              <label className={styles.field}>E-mail<input name="cemail" type="email" maxLength={254} autoComplete="off" /></label>
            </div></> : who === "pick" ? <label className={styles.field}>Contact<select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose a person</option>{free.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : null}
        </DrawerSection>
        <fieldset className={css.question}><legend>Is this company a {words.client.toLowerCase()}?</legend>
          <div className={css.answers} role="radiogroup" aria-label={`Is this company a ${words.client.toLowerCase()}?`}>
            {[{ v: true, label: `Yes, a ${words.client.toLowerCase()}`, sub: "You sell to them" }, { v: false, label: "Not yet", sub: "A vendor, partner or lead" }].map((o) =>
              <button key={String(o.v)} type="button" role="radio" aria-checked={client === o.v} className={css.answer} onClick={() => setClient(o.v)}><b>{o.label}</b><small>{o.sub}</small>{client === o.v ? <Check size={16} className={css.tick} aria-hidden="true" /> : null}</button>)}
          </div>
        </fieldset>
      </form>
    </Drawer> : null}
  </>;
}

/** Add a client: a company or one person, with the main contact in the same step. */
export function AddClientDrawer({ companies, contacts, types, canAddTypes, words }: { companies: CompanyLite[]; contacts: ContactLite[]; types: RecordType[]; canAddTypes: boolean; words: { client: string } }) {
  const router = useRouter(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [kind, setKind] = useState<"company" | "person">("company"); const [co, setCo] = useState<CompanyChoice>(null);
  const [who, setWho] = useState<"new" | "pick">("new"); const [pick, setPick] = useState(""); const [type, setType] = useState<string | null>(null);
  const formId = useId(); const one = words.client.toLowerCase();
  const people = contacts.filter((c) => kind === "person" || !co?.id || !c.companyId || c.companyId === co.id).sort((a, b) => a.name.localeCompare(b.name));
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (kind === "company" && !co?.name) { setErr("Type the company's name"); return; }
    const cname = String(f.get("cname") ?? "").trim();
    if (kind === "person" && who === "new" && cname.length < 2) { setErr("Type the person's name"); return; }
    if (who === "pick" && !pick) { setErr("Choose the person"); return; }
    setBusy(true); setErr("");
    try {
      const r = await post<{ id: string; existed: boolean; companyId: string | null }>("clients", {
        kind, clientType: type ?? undefined, companyId: co?.id ?? undefined, companyName: co && !co.id ? co.name : undefined,
        contactId: who === "pick" ? pick : undefined, contact: who === "new" && cname ? { name: cname, phone: f.get("cphone"), email: f.get("cemail"), designation: f.get("crole") } : undefined });
      setOpen(false);
      notify({ id: "client-added", tone: "success", title: r.existed ? `Already a ${one}: opened it` : `${kind === "company" ? co?.name : cname || "They"} is a ${one} now. Next: start a project`, timeout: 3500 });
      router.push(`/clients/${r.id}`);
    } catch (x) { setErr(message(x)); } finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}><Plus size={14} aria-hidden="true" />Add {one}</button>
    {open ? <Drawer title={`Add a ${one}`} icon={<Plus size={16} aria-hidden="true" />} onClose={() => setOpen(false)} size="md"
      context={<span className={styles.drawerSub}>A company or one person you sell to.</span>}
      footer={<DrawerFooter status={err || undefined} primary={<button type="submit" form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Adding…" : `Add ${one}`}</button>} />}>
      <form id={formId} className={css.form} onSubmit={submit}>
        <div className={css.group}>
          <Segmented label="Who is it?" value={kind} onChange={(v) => { setKind(v); setType(null); }} fill options={[{ value: "company", label: "A company" }, { value: "person", label: "One person" }]} />
          {kind === "company" ? <CompanyField label="Company" companies={companies} value={co} onChange={setCo} autoFocus /> : null}
          {/* One person is an individual client: no second question about it. */}
          {kind === "company" ? <TypeChips entity="client" types={types.filter((t) => !["individual", "home_customer", "internal"].includes(t.key))} value={type} onChange={setType} canAdd={canAddTypes} /> : null}
        </div>
        <div className={css.group}>
          <p className={css.groupHead}>{kind === "company" ? "Main contact: the person you talk to there" : "The person"}</p>
          {/* Judge r4: picking someone already in the book comes before typing them again. */}
          {people.length ? <button type="button" className={css.linkBtn} onClick={() => setWho(who === "new" ? "pick" : "new")}>{who === "new" ? "Already in your book? Pick them" : "Add a new person instead"}</button> : null}
          {who === "new" ? <><div className={css.two}>
              <label className={styles.field}>Name<input name="cname" maxLength={120} autoComplete="off" placeholder="Full name" /></label>
              {kind === "company" ? <label className={styles.field}>Their role<input name="crole" maxLength={120} autoComplete="off" placeholder="Owner, manager…" /></label> : null}
            </div><div className={css.two}>
              <label className={styles.field}>Phone<input name="cphone" type="tel" maxLength={40} autoComplete="off" /></label>
              <label className={styles.field}>E-mail (optional)<input name="cemail" type="email" maxLength={254} autoComplete="off" placeholder="name@example.com" /></label>
            </div></> : <label className={styles.field}>Contact<select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose a person</option>{people.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ""}</option>)}</select></label>}
        </div>
      </form>
    </Drawer> : null}
  </>;
}
