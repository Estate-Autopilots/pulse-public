"use client";
// CONNECTORS-CONTRACTS: draft a contract from a template (admins, leadership and Finance). This company is one party.
// CONTRACTS-3 (owner, 8 Nov: "the parties must come from existing clients, people and companies, including the point of
// contact"): the other side is picked from real records: one of our clients or vendors (its contact fills in), a company
// on Vitals OS (the directory's CompanyPicker; not on Vitals yet: invite them and the agreement names them meanwhile), a
// person by their @handle, someone in our team, or (last) a name typed in. Each side gets a point of contact (name, phone,
// e-mail), and "who pays whom" shows as the choices are made. The words open on the agreement's page.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Building2, ChevronDown, Plus, Search, Store, User, UserRound, Users } from "lucide-react";
import { post } from "../orgs/client";
import { moneyFlow } from "../lib/agreements.mjs";
import { CompanyLine, CompanyPicker, type CompanyInvite, type DirectoryCompany } from "../directory/company-picker";
import type { Choices, Contract } from "./parts";
import { WhoPays } from "./who-pays";
import { getJson } from "./fetch";
import css from "./contracts.module.css";
import d3 from "./[id]/drafts.module.css";
import { DateField } from "../kit/date-field";
import { Stepper } from "../kit/game";
import { SelectField } from "../kit/select-field";

type Other = "record" | "company" | "account" | "member" | "outside";
type Poc = { name: string; phone: string; email: string };
type PartyRecord = { id: string; name: string; kind: "client" | "vendor"; poc: { name: string | null; phone: string | null; email: string | null } };
type Account = { id: string; name: string; handle?: string } | null;
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const NO_POC: Poc = { name: "", phone: "", email: "" };
const STEPS = ["What it's for", "Who", "Check"] as const;
const OTHERS: { key: Other; label: string; icon: typeof User }[] = [
  { key: "record", label: "Client or vendor", icon: Store },
  { key: "company", label: "A company that uses Vitals", icon: Building2 },
  { key: "account", label: "A person who uses Vitals", icon: UserRound },
  { key: "member", label: "Someone in our team", icon: Users },
  { key: "outside", label: "Someone else", icon: User },
];

export function NewContract({ choices, startOpen, onQuotation }: { choices: Choices; startOpen?: boolean; onQuotation?: () => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(!!startOpen); // CONTRACTS-2: on its own page now (/contracts/new), open from the start
  const [template, setTemplate] = useState<string>(choices.templates[0]?.key ?? "services");
  const [other, setOther] = useState<Other>("record");
  const [company, setCompany] = useState<DirectoryCompany | null>(null);
  const [invite, setInvite] = useState<CompanyInvite | null>(null);
  const [q, setQ] = useState("");
  const [records, setRecords] = useState<PartyRecord[] | null>(null);
  const [record, setRecord] = useState<PartyRecord | null>(null);
  const [account, setAccount] = useState<Account>(null);
  const [memberId, setMemberId] = useState(choices.people[0]?.id ?? "");
  const [outside, setOutside] = useState({ name: "", kind: "company" });
  const [poc, setPoc] = useState<Poc>(NO_POC);
  const [busy, setBusy] = useState(false);
  // CONTRACTS-3 (owner: "click, dropdown, click, click, and a simple contract is done"): one step at a time.
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const t = choices.templates.find((x) => x.key === template);
  const [ourRole, theirRole] = t?.roles ?? ["provider", "client"];

  // /contracts/new?company=<handle> (a company's public profile, "Make an agreement"): that company, picked.
  const preset = params.get("company");
  useEffect(() => {
    if (!preset) return;
    let live = true;
    void fetch(`/api/v1/directory/companies/${encodeURIComponent(preset.replace(/^@/, ""))}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (live && d?.company) { setOpen(true); setOther("company"); setCompany(d.company as DirectoryCompany); setStep(1); }
    }).catch(() => undefined);
    return () => { live = false; };
  }, [preset]);

  // Our records and @handles, as you type.
  useEffect(() => {
    if (!open || (other !== "record" && other !== "account")) return;
    let live = true;
    if (other === "account" && q.trim().replace(/^@/, "").length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const r = await getJson<{ records: PartyRecord[]; account: Account }>(`contracts/parties?q=${encodeURIComponent(q.trim())}`);
        if (!live) return;
        if (other === "record") setRecords(r.records); else setAccount(r.account);
        setError(null);
      } catch (e) { if (live) setError(say(e)); }
    }, 220);
    return () => { live = false; clearTimeout(timer); };
  }, [open, other, q]);

  // A handle shorter than two letters finds nobody (the last answer is not shown for it).
  const found = q.trim().replace(/^@/, "").length >= 2 ? account : null;
  const them = useMemo((): { name: string; body: Record<string, unknown> } | null => {
    switch (other) {
      case "record": return record ? { name: record.name, body: { kind: record.kind === "vendor" ? "person" : "company", role: theirRole, name: record.name } } : null;
      case "company": return company ? { name: company.name, body: { kind: "company", role: theirRole, orgId: company.id } }
        : invite ? { name: invite.companyName, body: { kind: "company", role: theirRole, name: invite.companyName } } : null;
      case "account": return found ? { name: found.name, body: { kind: "person", role: theirRole, accountId: found.id } } : null;
      case "member": { const p = choices.people.find((x) => x.id === memberId); return p ? { name: p.name, body: { kind: "person", role: theirRole, personId: p.id } } : null; }
      default: return outside.name.trim() ? { name: outside.name.trim(), body: { kind: outside.kind === "person" ? "person" : "company", role: theirRole, name: outside.name.trim() } } : null;
    }
  }, [other, record, company, invite, found, memberId, outside, choices.people, theirRole]);

  // Who pays whom, live: the two sides by the template's roles (the price comes on the next page).
  const flow = useMemo(() => moneyFlow({ kind: t?.kind ?? "services", schedule: "one_off", currency: "INR", rates: [], transactions: [],
    parties: [{ key: "us", role: ourRole, name: choices.us.name }, { key: "them", role: theirRole, name: them?.name ?? "The other side" }] }, null, "2000-01-01"),
  [t, ourRole, theirRole, choices.us.name, them]);

  const pocs = { them: poc.name || poc.phone ? { name: poc.name || null, phone: poc.phone || null } : null };
  function pick(r: PartyRecord) { setRecord(r); setPoc({ name: r.poc.name ?? "", phone: r.poc.phone ?? "", email: r.poc.email ?? "" }); }
  function choose(o: Other) { setOther(o); setError(null); setQ(""); setRecords(null); setRecord(null); setPoc(NO_POC); }

  function next() {
    if (step === 1 && !them) { setError(other === "record" ? "Pick the client or vendor first." : other === "company" ? "Find the company first." : other === "account" ? "Find the person first." : "Say who the other side is."); return; }
    setError(null); setStep(step + 1);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step < STEPS.length - 1) { next(); return; } // Enter in a field moves on, it never makes the agreement early
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    if (!them) { setError(other === "record" ? "Pick the client or vendor first." : other === "company" ? "Find the company first." : other === "account" ? "Find the person first." : "Say who the other side is."); return; }
    setBusy(true); setError(null);
    try {
      const contact = poc.name || poc.phone || poc.email ? { poc } : {};
      const r = await post<{ contract: Contract }>("contracts", { template, title: text("title") || undefined, startsOn: text("startsOn") || null,
        ...(other === "record" && record?.kind === "client" ? { clientId: record.id } : {}),
        parties: [{ kind: "company", role: ourRole, orgId: choices.us.id }, { ...them.body, ...contact }] });
      router.push(`/contracts/${r.contract.id}`);
      router.refresh();
    } catch (err) { setError(say(err)); }
    finally { setBusy(false); }
  }

  if (!open) return <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />New contract</button>;
  return <form className={`${css.panel} ${d3.blankForm}`} onSubmit={submit} aria-label="New contract">
    <div className={`${d3.stepWrap} ${d3.stepSpan}`}><Stepper steps={STEPS} current={step} label="Steps" /></div>
    <div className={`${css.form} ${d3.blankMain}`}>
    {step === 0 ? <>
      <p className={d3.stepHead}>What kind of agreement?</p>
    <div className={`${css.templates} ${d3.tplCompact}`} role="group" aria-label="Start from">
      {choices.templates.map((x) => <button key={x.key} type="button" className={`${css.btn} ${css.template}`} aria-pressed={template === x.key} onClick={() => setTemplate(x.key)}>
        {x.name}<span>{x.summary}</span>
      </button>)}
    </div>
    </> : null}
    {step === 1 ? <>
    <fieldset className={d3.fieldset}>
      <legend>Who is the other side?</legend>
      {/* Once a client or a company is picked, the choices step back; "Change" brings them back. */}
      {(other === "record" && record) || (other === "company" && (company || invite)) ? null : <div className={`${css.chips} ${d3.optionGrid}`} role="group" aria-label="The other side is">
        {OTHERS.filter((o) => o.key !== "member" || (t?.kind === "employment" && choices.people.length)).map((o) => <button key={o.key} type="button" aria-pressed={other === o.key} onClick={() => choose(o.key)}>
          <o.icon size={16} aria-hidden="true" />{o.label}</button>)}
      </div>}

      {other === "record" ? <div className={d3.options}>
        {record ? null : <label className={css.field}>Find them in your clients and vendors
          <span className={d3.searchBox}><Search size={16} aria-hidden="true" /><input value={q} onChange={(e) => { setQ(e.target.value); setRecord(null); }} placeholder="Type a name" maxLength={120} /></span>
        </label>}
        {record ? <ul className={css.list} aria-label="Picked"><li className={d3.pickedRow}>
          {record.kind === "vendor" ? <User size={16} aria-hidden="true" /> : <Store size={16} aria-hidden="true" />}
          <span className={css.itemText}><strong>{record.name}</strong><span>{record.kind === "vendor" ? "Vendor" : "Client"}</span></span>
          <button type="button" className={d3.linkBtn} onClick={() => { setRecord(null); setPoc(NO_POC); }}>Change</button></li></ul>
          : records ? records.length ? <ul className={css.list} aria-label="Clients and vendors">
            {records.map((r) => <li key={`${r.kind}-${r.id}`}>
              {r.kind === "vendor" ? <User size={16} aria-hidden="true" /> : <Store size={16} aria-hidden="true" />}
              <span className={css.itemText}><strong>{r.name}</strong><span>{[r.kind === "vendor" ? "Vendor" : "Client", r.poc.name ? `Contact: ${r.poc.name}` : null].filter(Boolean).join(" · ")}</span></span>
              <button type="button" className={css.btn} onClick={() => pick(r)}>Pick</button>
            </li>)}</ul> : <p className={css.hint}>{q ? "No client or vendor has that name. Try another word, or pick Someone else." : "You have no clients or vendors yet. Pick Someone else."}</p> : null}
      </div> : null}

      {other === "company" ? company ? <div className={d3.picked}><CompanyLine company={company} />
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setCompany(null)}>Change</button></div>
        : invite ? <div className={d3.picked}><span className={css.okText}>{`${invite.companyName} is invited. The agreement names them now; they sign once they join.`}</span>
          <button type="button" className={d3.linkBtn} onClick={() => { setInvite(null); setPoc(NO_POC); }}>Change</button></div>
        : <CompanyPicker value={company} onChange={(x) => { setCompany(x); setInvite(null); }} excludeOwn invitePurpose="contract" label="Who is the other company?"
          onInvite={(inv) => { setInvite(inv); setPoc({ name: "", phone: inv.phone ?? "", email: inv.email ?? "" }); }} /> : null}

      {other === "account" ? <label className={css.field}>Their @handle or e-mail
        <span className={d3.searchBox}><Search size={16} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="@their-handle" maxLength={120} /></span>
        {found ? <span className={css.okText}>{`Found: ${found.name}`}</span> : q.replace(/^@/, "").length >= 2 ? <span className={css.hint}>No Vitals OS account has that handle yet.</span> : null}
      </label> : null}

      {other === "member" ? <label className={css.field}>Who
        <SelectField value={memberId} onChange={(e) => setMemberId(e.target.value)}>{choices.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField>
      </label> : null}

      {other === "outside" ? <div className={css.row}>
        <label className={css.field}>Their name<input value={outside.name} onChange={(e) => setOutside({ ...outside, name: e.target.value })} maxLength={160} /></label>
        <label className={css.field}>They are
          <SelectField value={outside.kind} onChange={(e) => setOutside({ ...outside, kind: e.target.value })}><option value="company">A company</option><option value="person">A person</option></SelectField>
        </label>
      </div> : null}
    </fieldset>
    {other !== "member" ? <fieldset className={d3.fieldset}>
      <legend>Their point of contact</legend>
      <div className={css.row}>
        <label className={css.field}>Name<input value={poc.name} onChange={(e) => setPoc({ ...poc, name: e.target.value })} maxLength={160} placeholder="Full name" autoComplete="off" /></label>
        <label className={css.field}>Phone<input type="tel" value={poc.phone} onChange={(e) => setPoc({ ...poc, phone: e.target.value })} maxLength={32} placeholder="+91 …" autoComplete="off" /></label>
        <label className={css.field}>Email<input type="email" value={poc.email} onChange={(e) => setPoc({ ...poc, email: e.target.value })} maxLength={254} placeholder="name@example.com" autoComplete="off" /></label>
      </div>
      {other === "record" && record ? <p className={css.hint}>{record.poc.name ? "From your client records. You can change these." : "This record has no contact person yet. Add one here."}</p> : null}
    </fieldset> : null}
    </> : null}
    {step === 2 ? <>
      <p className={d3.stepHead}>Check and make it</p>
      <div className={`${css.row} ${d3.twoCols}`}>
        <label className={css.field}>Name of the agreement (optional)<input name="title" maxLength={160} placeholder={`For example: ${t?.name ?? "Agreement"}`} /></label>
        <label className={css.field}>Starts on<DateField name="startsOn"/></label>
      </div>
      <div className={d3.narrowOnly}><WhoPays flow={flow} pocs={pocs} us={(k) => k === "us"} /></div>
      <p className={css.hint}>Only {choices.us.name} sees a draft. You write the agreement on the next page, then send it to sign.</p>
    </> : null}
    {/* A narrower screen has no room beside the steps: what is picked so far folds into one line above Next. */}
    {step === 1 ? <details className={d3.soFarFold}>
      <summary><span>So far</span><span>{[t?.name, them?.name].filter(Boolean).join(" · ")}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <WhoPays bare noDoc flow={flow} pocs={pocs} us={(k) => k === "us"} />
    </details> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={`${css.actions} ${d3.stepActions}`}>
      {step > 0 ? <button type="button" className={d3.backLink} onClick={() => { setError(null); setStep(step - 1); }}>‹ Back</button> : null}
      {step < STEPS.length - 1 ? <button type="button" className={`${css.btn} ${css.primary}`} onClick={next}>Next</button>
        : <button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Saving…" : "Make the agreement"}</button>}
      {startOpen || step > 0 ? null : <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(false)}>Cancel</button>}
    </div>
    {onQuotation && step === 0 ? <button type="button" className={d3.linkBtn} onClick={onQuotation}>Or make it from a quotation instead</button> : null}
    </div>
    {/* A wide screen keeps what is picked so far beside the steps. */}
    <aside className={d3.blankSide} aria-label="This agreement so far">
      <WhoPays bare noDoc noGets title="So far" hint={`What it's for: ${t?.name ?? "an agreement"}`} flow={flow} us={(k) => k === "us"} />
    </aside>
  </form>;
}
