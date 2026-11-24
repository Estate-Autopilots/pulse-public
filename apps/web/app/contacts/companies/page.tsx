import Link from "next/link";
import { Building2, Search } from "lucide-react";
import { api, workWords } from "../../lib/api";
import { count } from "../../lib/format";
import { Avatar, Badge, Empty, Message, Page, PageHeader, styles } from "../../ui";
import { AddCompany, type ContactLite } from "../book";
import { BookTabs } from "../tabs";
import css from "../book.module.css";

// COMPANIES-MODEL (owner, 16 Nov 2026: "There is no database for companies."): every organisation you work with, its
// main contact and people, and what it is to you (client, vendor, partner, on Pulse).
type Row = { id: string; name: string; city: string | null; industry: string | null; contactId: string | null; contactName: string | null; clientId: string | null;
  isVendor: boolean; isPartner: boolean; pulseOrgId: string | null; people: number; projects: number; quotes: number; invoices: number };
type Show = "all" | "clients" | "vendors" | "partners" | "pulse";

export default async function Companies({ searchParams }: { searchParams: Promise<{ show?: string; q?: string }> }) {
  const p = await searchParams;
  const [r, people, words] = await Promise.all([api<{ companies: Row[]; canEdit: boolean; clientCount?: number }>("companies"), api<{ contacts: (ContactLite & { companyId?: string | null })[] }>("contacts"), workWords()]);
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const all = r.data.companies; const one = words.clients.replace(/s$/, "") || "Client";
  const sets: Record<Show, Row[]> = { all, clients: all.filter((c) => c.clientId), vendors: all.filter((c) => c.isVendor), partners: all.filter((c) => c.isPartner), pulse: all.filter((c) => c.pulseOrgId) };
  const show: Show = (["clients", "vendors", "partners", "pulse"] as const).find((k) => k === p.show) ?? "all";
  const q = (p.q ?? "").trim().toLowerCase();
  const rows = sets[show].filter((c) => !q || `${c.name} ${c.city ?? ""} ${c.contactName ?? ""} ${c.industry ?? ""}`.toLowerCase().includes(q));
  const contacts = people.data?.contacts ?? [];
  const loose = contacts.filter((c) => !c.companyId).length;
  const link = (s: Show) => { const u = new URLSearchParams(); if (s !== "all") u.set("show", s); if (q) u.set("q", p.q!.trim()); const t = u.toString(); return `/contacts/companies${t ? `?${t}` : ""}`; };
  const filters: [Show, string][] = [["all", "All"], ["clients", words.clients], ["vendors", "Vendors"], ["partners", "Partners"], ["pulse", "On Pulse"]];
  return <Page fit>
    <PageHeader title="Companies" context={[`${count(all.length)} ${all.length === 1 ? "company" : "companies"}`, sets.clients.length && sets.clients.length < all.length ? `${count(sets.clients.length)} of them ${sets.clients.length === 1 ? "is a" : "are"} ${(sets.clients.length === 1 ? one : words.clients).toLowerCase()}` : null]}
      actions={r.data.canEdit ? <AddCompany contacts={contacts} words={{ client: one }} /> : undefined} />
    <BookTabs current="companies" clients={words.clients} counts={{ people: contacts.length, companies: all.length, clients: r.data.clientCount }} />
    <div className={css.bar}>
      {/* Only when there is more than clients to tell apart (Clients has its own tab). */}
      {filters.some(([k]) => k !== "all" && k !== "clients" && sets[k].length) ? <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Show companies">
        {filters.filter(([k]) => k === "all" || k === "clients" || sets[k].length).map(([k, label]) => <Link key={k} href={link(k)} className={styles.segment} aria-current={show === k ? "true" : undefined}>{label}<span className={styles.muted}>{count(sets[k].length)}</span></Link>)}
      </div> : null}
      <form className={styles.search} action="/contacts/companies" role="search">
        {show !== "all" ? <input type="hidden" name="show" value={show} /> : null}
        <Search size={14} aria-hidden="true" />
        <input className={styles.input} type="search" name="q" defaultValue={p.q ?? ""} placeholder="Search companies…" aria-label="Search companies" />
      </form>
    </div>
    {loose && all.length ? <p className={css.hint}><span>{count(loose)} {loose === 1 ? "person has" : "people have"} no company yet.</span><Link href="/contacts?company=none" className={styles.fill}>Show them</Link></p> : null}
    {rows.length ? <div className={`${styles.panel} ${css.tableWrap}`} data-enter=""><table className={styles.table}>
      <thead><tr><th>Company</th><th className={styles.hideSmall}>Main contact</th><th className={styles.right}>People</th><th className={`${styles.right} ${styles.hideSmall}`}>Projects</th><th className={`${styles.right} ${styles.hideSmall}`}>Quotes</th></tr></thead>
      <tbody>{rows.map((c) => <tr key={c.id}>
        <td><span className={css.who}><Avatar name={c.name} shape="square" size={32} /><span>
          <Link href={`/contacts/companies/${c.id}`} className={styles.cellLink} title={c.name}>{c.name}</Link>
          <span className={css.tags}>{c.clientId ? <Badge tone="success">{one}</Badge> : null}{c.isVendor ? <Badge>Vendor</Badge> : null}{c.isPartner ? <Badge>Partner</Badge> : null}{c.pulseOrgId ? <Badge tone="accent">On Pulse</Badge> : null}{c.city ? <span className={styles.cellSub}>{c.city}</span> : null}</span>
        </span></span></td>
        <td className={styles.hideSmall}>{c.contactId ? <Link href={`/contacts/${c.contactId}`} className={styles.cellLink}>{c.contactName}</Link> : <span className={styles.muted}>Not set</span>}</td>
        <td className={`${styles.right} ${styles.num}`}>{count(c.people)}</td>
        <td className={`${styles.right} ${styles.num} ${styles.hideSmall}`}>{count(c.projects)}</td>
        <td className={`${styles.right} ${styles.num} ${styles.hideSmall}`}>{count(c.quotes)}</td>
      </tr>)}</tbody>
    </table></div> : <section className={styles.panel}><Empty icon={Building2} first title={all.length ? "No companies match" : "No companies yet"}
      text={q ? `Nothing matches “${p.q}”.` : all.length ? "No companies in this view." : "Add the businesses you work with. Their people, quotes and projects stay together."}
      action={all.length ? { href: "/contacts/companies", label: "Show all companies" } : undefined} /></section>}
  </Page>;
}
