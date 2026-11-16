"use client";

// BILLING (owner, 4 Nov 2026; Kazuk, 3 Nov): "Select client" searches Clients and Contacts (leads included), so a
// quotation never waits for a client project. Picking a client brings its billing details and point of contact; picking a
// contact brings their name, phone and e-mail (and their client, when they have one). Nobody new is written to Clients or
// Contacts here: a new client typed into the quotation is booked when the invoice is issued or paid.
// BILLING-WL (owner, 4 Nov 2026; Akabod: "Ajay" and "Asohiv Mifos" were not found though they exist): the search is
// forgiving (any case, spacing or word order; name, company, phone or e-mail) and also finds Sales X-Ray's leads (Meta
// ads, the website, the DMS or added by hand). Picking a lead attaches the quotation to its profile; approving the
// quotation books a new customer in Clients and Contacts (as a Prospect), so nobody types them in twice.
import { useEffect, useState } from "react";
import { Building2, Radar, UserPlus, UserRound } from "lucide-react";
import { LineList, LineRow } from "../kit/line-row";
import { initials, styles } from "../ui";
import type { Buyer } from "./types";
import css from "./documents/documents.module.css";

export type PartyClient = { id: string; name: string; companyName: string | null; city: string | null; gstin: string | null; billing: boolean; contactName: string | null; phone: string | null; email: string | null };
export type PartyContact = { id: string; name: string; designation: string | null; contactType: string | null; email: string | null; phone: string | null; city: string | null; clientId: string | null; clientName: string | null };
export type PartyLead = { id: string; name: string; company: string | null; city: string | null; phone: string | null; email: string | null; stage: string | null; source: string | null; owner: string | null };
export type Picked = { clientId: string | null; contactPersonId: string | null; buyer: Buyer; siteLocation: string | null; sxLeadId?: string | null };
export type PartyChoice = { client?: string; contact?: string; lead?: string };

/** The people a document can be for, as Billing's /erp/parties answers them. `null` while it looks. */
export function useParties(q: string) {
  const [found, setFound] = useState<{ q: string; clients: PartyClient[]; contacts: PartyContact[]; leads: PartyLead[]; failed?: boolean } | null>(null);
  useEffect(() => {
    let gone = false;
    const t = setTimeout(() => {
      fetch(`/api/v0/erp/parties?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => { if (!gone) setFound({ q, clients: d.clients ?? [], contacts: d.contacts ?? [], leads: d.leads ?? [] }); })
        .catch(() => { if (!gone) setFound({ q, clients: [], contacts: [], leads: [], failed: true }); });
    }, q ? 200 : 0);
    return () => { gone = true; clearTimeout(t); };
  }, [q]);
  return found;
}

/** What a picked client or contact fills in (their billing details, contact and the project location they last had). */
export async function pickParty(choice: PartyChoice): Promise<Picked> {
  const qs = new URLSearchParams(Object.entries(choice).filter(([, v]) => !!v) as [string, string][]);
  const r = await fetch(`/api/v0/erp/parties/pick?${qs}`, { cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? "That client could not be loaded");
  return body as Picked;
}

/** The search box and the two lists. `onNew` takes what was typed, to start a new client with that name. */
export function PartyPicker({ onPick, onNew, busy, autoFocus, selectedClient, selectedContact, selectedLead }: {
  onPick: (choice: PartyChoice, label: string) => void; onNew?: (name: string) => void; busy?: boolean; autoFocus?: boolean;
  selectedClient?: string | null; selectedContact?: string | null; selectedLead?: string | null;
}) {
  const [q, setQ] = useState("");
  const found = useParties(q);
  const typed = q.trim();
  const none = found && !found.clients.length && !found.contacts.length && !found.leads.length;
  return <div className={css.picker}>
    <label className={css.search} style={{ maxWidth: "none" }}><span className={styles.srOnly}>Find the client</span>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, company, phone or GSTIN" autoFocus={autoFocus} aria-label="Search Clients and Contacts" /></label>
    {found === null ? <p className={css.note} role="status">Looking in Clients, Contacts and leads…</p> : null}
    {found?.failed ? <p className={css.note} role="alert">Clients and Contacts could not be searched just now. Type the client below instead.</p> : null}
    {found && found.clients.length ? <LineList label="Clients">
      {found.clients.map((c) => <LineRow key={c.id} lead={<span className={css.avatar} aria-hidden="true">{initials(c.name)}</span>} selected={selectedClient === c.id}
        title={c.name} sub={[c.companyName && c.companyName !== c.name ? c.companyName : null, c.contactName, c.phone, c.gstin ? `GSTIN ${c.gstin}` : null, c.city].filter(Boolean).join(" · ") || "Client"}
        amountSub={c.billing ? "billing details ✓" : "client"} amount="" onOpen={busy ? undefined : () => onPick({ client: c.id }, c.name)} label={`Choose client ${c.name}`} />)}
    </LineList> : null}
    {found && found.contacts.length ? <div style={{ marginTop: 8 }}><LineList label="Contacts">
      {found.contacts.map((p) => <LineRow key={p.id} lead={<UserRound size={16} aria-hidden="true" />} selected={selectedContact === p.id}
        title={`${p.name}${p.designation ? ` · ${p.designation}` : ""}`} sub={[p.clientName ? `of ${p.clientName}` : p.contactType ?? "contact", p.phone, p.email].filter(Boolean).join(" · ")}
        amountSub={p.clientName ? "contact" : "lead / contact"} amount="" onOpen={busy ? undefined : () => onPick({ contact: p.id }, p.name)} label={`Choose contact ${p.name}`} />)}
    </LineList></div> : null}
    {found && found.leads.length ? <div style={{ marginTop: 8 }}><LineList label="Leads">
      {found.leads.map((l) => <LineRow key={l.id} lead={<Radar size={16} aria-hidden="true" />} selected={selectedLead === l.id}
        title={l.company && l.company !== l.name ? `${l.name} · ${l.company}` : l.name} sub={[l.source ?? "Sales X-Ray lead", l.stage, l.phone, l.email, l.city].filter(Boolean).join(" · ")}
        amountSub="lead" amount="" onOpen={busy ? undefined : () => onPick({ lead: l.id }, l.name)} label={`Choose lead ${l.name}`} />)}
    </LineList></div> : null}
    {none && !found.failed ? <p className={css.note}>{typed ? `No client, contact or lead matches “${typed}”.` : "No clients or contacts yet."} {onNew ? "Start a new client: the quotation needs only a name and a phone or e-mail." : null}</p> : null}
    {onNew ? <div style={{ marginTop: 8 }}><LineList label="New client">
      <LineRow lead={typed ? <Building2 size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />} title={typed ? `New client “${typed}”` : "A new client"}
        sub="Type their name and phone; approving the quotation adds them to Clients and Contacts" onOpen={busy ? undefined : () => onNew(typed)} label={typed ? `New client ${typed}` : "A new client"} />
    </LineList></div> : null}
  </div>;
}
