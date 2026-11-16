"use client";
// COMPANY-SEARCH (owner, 8 Nov 2026): pick another company, for Contracts first. Type a name, an @handle, a GSTIN or a
// CIN; results come as you type with logo, city and the verified badge. Arrow keys, Enter and Esc work (a WAI-ARIA
// combobox). Nothing found: "Not on Vitals? Invite them" makes a pending invite and a join link the person shares from
// their own phone (Vitals sends nothing). Props are the contract in ~/ea-research/flow/reports/COMPANY-SEARCH.md §2.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Copy, Loader2, Mail, MessageCircle, Search, UserPlus, X } from "lucide-react";
import { CompanyMark } from "../company-mark";
import { contactKind, makeInvite, matchWords, nextIndex, searchable, searchCompanies, whatsappInvite,
  type CompanyInvite, type DirectoryCompany } from "../lib/directory.mjs";
import css from "./directory.module.css";

export type { CompanyInvite, DirectoryCompany };

export type CompanyPickerProps = {
  value: DirectoryCompany | null;
  onChange: (company: DirectoryCompany | null) => void;
  /** After the pending invite is made. Leave it out to hide "Not on Vitals? Invite them". */
  onInvite?: (invite: CompanyInvite) => void;
  invitePurpose?: "contract" | "general";
  /** Hide the signed-in person's own company. */
  excludeOwn?: boolean;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The input's id, for an outside <label htmlFor>. */
  id?: string;
};

/** The small green badge: a GSTIN or CIN whose format and check are right (not yet the government's records). */
export function VerifiedBadge({ by, compact = false }: { by: "gstin" | "cin" | null; compact?: boolean }) {
  if (!by) return null;
  const what = by === "gstin" ? "GSTIN" : "CIN";
  return <span className={css.verified} title={`${what} checked: it has the right shape${by === "gstin" ? " and check letter" : ""}. Not yet checked with the government's records.`}>
    <Check size={12} strokeWidth={3} aria-hidden="true" />{compact ? null : "Verified"}<span className={css.srOnly}>{compact ? `Verified ${what}` : ` ${what}`}</span>
  </span>;
}

export function CompanyLine({ company }: { company: DirectoryCompany }) {
  return <span className={css.line}>
    <CompanyMark name={company.name} mark={company.logo} size={32} className={css.mark} />
    <span className={css.lineText}>
      <span className={css.lineName}>{company.name}<VerifiedBadge by={company.verifiedBy} /></span>
      <span className={css.lineSub}>@{company.handle}{company.city ? ` · ${company.city}` : ""}{company.industry ? ` · ${company.industry}` : ""}</span>
    </span>
  </span>;
}

type Shown = { q: string; rows: DirectoryCompany[]; error: string | null } | null;

export function CompanyPicker({ value, onChange, onInvite, invitePurpose = "general", excludeOwn = false, label = "Company",
  placeholder = "Name, @handle, GSTIN or CIN", autoFocus, disabled, id }: CompanyPickerProps) {
  const auto = useId();
  const inputId = id ?? `company-picker-${auto}`;
  const listId = `${inputId}-list`;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Shown>(null);
  const [active, setActive] = useState(-1);
  const [inviting, setInviting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Ask the API after a short pause; a newer question cancels the older one. Loading and errors are read from the last
  // answer (an answer is for one question), so nothing is set while the effect runs.
  useEffect(() => {
    if (!searchable(q)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchCompanies(q, { signal: abort.signal, limit: 8, excludeOwn })
        .then((rows) => { if (!abort.signal.aborted) { setShown({ q, rows, error: null }); setActive(rows.length ? 0 : -1); } })
        .catch((e: Error) => { if (!abort.signal.aborted && e.name !== "AbortError") setShown({ q, rows: [], error: e.message }); });
    }, 150);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [q, excludeOwn]);
  const loading = searchable(q) && shown?.q !== q;
  const error = searchable(q) ? shown?.error ?? null : null;

  const rows = useMemo(() => (searchable(q) ? shown?.rows : null) ?? [], [shown, q]);
  const canInvite = !!onInvite;
  const options = rows.length + (canInvite && shown ? 1 : 0);   // the last option is "Invite them"
  const pick = (c: DirectoryCompany) => { onChange(c); setOpen(false); setQ(""); setInviting(false); };
  const startInvite = () => { setInviting(true); setOpen(false); };

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && options > 0) {
      if ((e.key === "Home" || e.key === "End") && !open) return;
      e.preventDefault(); setOpen(true); setActive((a) => nextIndex(a, options, e.key));
    } else if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      if (active < rows.length) pick(rows[active]); else startInvite();
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); setOpen(false); } else if (q) { e.preventDefault(); setQ(""); }
    }
  };

  if (value) {
    return <div className={css.picker}>
      <span className={css.label} id={`${inputId}-label`}>{label}</span>
      <div className={css.picked} aria-labelledby={`${inputId}-label`}>
        <CompanyLine company={value} />
        {disabled ? null : <button type="button" className={css.quiet} onClick={() => { onChange(null); requestAnimationFrame(() => input.current?.focus()); }}>Change</button>}
      </div>
    </div>;
  }

  const expanded = open && !!shown && searchable(q);
  const optionId = (i: number) => `${inputId}-opt-${i}`;
  return <div className={css.picker}>
    <label className={css.label} htmlFor={inputId}>{label}</label>
    <div className={css.box} data-open={expanded || undefined}>
      <Search size={18} className={css.boxIcon} aria-hidden="true" />
      <input ref={input} id={inputId} className={css.input} type="text" inputMode="search" autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={expanded} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={placeholder} value={q} disabled={disabled} autoFocus={autoFocus}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setInviting(false); }}
        onFocus={() => { if (shown) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={keys} />
      {loading ? <Loader2 size={16} className={css.spin} aria-hidden="true" /> : q ? <button type="button" className={css.clear} aria-label="Clear" onClick={() => { setQ(""); input.current?.focus(); }}><X size={16} /></button> : null}
    </div>
    <p className={css.srOnly} role="status" aria-live="polite">{expanded ? rows.length ? `${rows.length} ${rows.length === 1 ? "company" : "companies"} found` : "No company found" : ""}</p>
    {expanded ? <ul id={listId} role="listbox" className={css.list} aria-label="Companies">
      {rows.map((c, i) => <li key={c.id} id={optionId(i)} role="option" aria-selected={i === active} className={css.option} data-active={i === active || undefined}
        onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setActive(i)}>
        <CompanyLine company={c} />
        {matchWords(c.match) ? <span className={css.why}>{matchWords(c.match)}</span> : null}
      </li>)}
      {!rows.length ? <li role="presentation" className={css.none}>{error ?? <>No company called <b>“{shown!.q}”</b> on Vitals yet.</>}</li> : null}
      {canInvite ? <li id={optionId(rows.length)} role="option" aria-selected={active === rows.length} className={`${css.option} ${css.inviteOption}`}
        data-active={active === rows.length || undefined} onMouseDown={(e) => { e.preventDefault(); startInvite(); }} onMouseEnter={() => setActive(rows.length)}>
        <span className={css.inviteIcon} aria-hidden="true"><UserPlus size={16} /></span>
        <span>Not on Vitals? <b>Invite them</b></span>
      </li> : null}
    </ul> : null}
    {inviting && onInvite ? <InviteForm name={q} purpose={invitePurpose} onDone={onInvite} onCancel={() => { setInviting(false); input.current?.focus(); }} /> : null}
  </div>;
}

function InviteForm({ name, purpose, onDone, onCancel }: { name: string; purpose: "contract" | "general"; onDone: (i: CompanyInvite) => void; onCancel: () => void }) {
  const [companyName, setCompanyName] = useState(name.trim());
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<CompanyInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const base = useId();
  const kind = contactKind(contact);

  if (made) {
    return <div className={css.invite} role="region" aria-label="Invite link">
      <p className={css.inviteTitle}><Check size={18} aria-hidden="true" className={css.drawCheck} /> Invite ready for {made.companyName}</p>
      <p className={css.inviteNote}>Send this link yourself. When they join, they show up here.</p>
      <div className={css.linkRow}><input className={css.linkInput} readOnly value={made.link ?? ""} aria-label="Invite link" onFocus={(e) => e.target.select()} />
        <button type="button" className={css.secondary} onClick={() => { void navigator.clipboard?.writeText(made.link ?? "").then(() => setCopied(true)); }}>
          <Copy size={16} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button></div>
      <div className={css.shareRow}>
        {made.phone ? <a className={css.secondary} href={whatsappInvite(made)} target="_blank" rel="noreferrer"><MessageCircle size={16} aria-hidden="true" />WhatsApp</a> : null}
        {made.email ? <a className={css.secondary} href={`mailto:${made.email}?subject=${encodeURIComponent("Join me on Vitals")}&body=${encodeURIComponent(`Join here: ${made.link ?? ""}`)}`}><Mail size={16} aria-hidden="true" />E-mail</a> : null}
      </div>
    </div>;
  }
  const submit = async () => {
    setBusy(true); setError(null);
    try { const invite = await makeInvite({ companyName, contact, purpose }); setMade(invite); onDone(invite); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <form className={css.invite} onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Invite a company">
    <p className={css.inviteTitle}>Invite them to Vitals</p>
    <label className={css.field} htmlFor={`${base}-name`}><span>Company name</span>
      <input id={`${base}-name`} className={css.text} value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={160} required autoFocus /></label>
    <label className={css.field} htmlFor={`${base}-contact`}><span>E-mail or phone</span>
      <input id={`${base}-contact`} className={css.text} value={contact} onChange={(e) => setContact(e.target.value)} inputMode="email" autoComplete="off" placeholder="name@company.com or 98xxxxxxxx" required />
      {contact && !kind ? <small className={css.hint}>Type an e-mail, or a phone number with 10 numbers.</small> : null}</label>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}>
      <button type="submit" className={css.primary} disabled={busy || !companyName.trim() || !kind}>{busy ? "Making…" : "Make invite link"}</button>
      <button type="button" className={css.quiet} onClick={onCancel}>Cancel</button>
    </div>
    <p className={css.inviteNote}>Vitals sends nothing. You share the link.</p>
  </form>;
}
