import Link from "next/link";
import { PhoneBatch } from "../components/phone-batch";
import { ContactRound, Info, Search } from "lucide-react";
import { api, workWords } from "../lib/api";
import { count } from "../lib/format";
import { Avatar, Empty, Message, Page, PageHeader, Pager, styles } from "../ui";
import { ContactStatusBadge, css, month, tagLabel } from "../clients/shared";
import type { ContactList, ContactRow } from "../clients/types";
import { TypeBadge, type RecordType } from "../record-types";
import { AddPerson, type CompanyLite } from "./book";
import { BookTabs } from "./tabs";

type Show = string;

export default async function Contacts({ searchParams }: { searchParams: Promise<{ type?: string; q?: string; all?: string; company?: string; add?: string; tag?: string }> }) {
  const params = await searchParams;
  const [r, co, words] = await Promise.all([api<ContactList>("contacts"), api<{ companies: CompanyLite[]; clientCount?: number }>("companies"), workWords()]);
  const one = words.clients.replace(/s$/, "") || "Client";
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const { contacts, canEdit } = r.data; const types: RecordType[] = r.data.types;
  // PEOPLE-CONTACTS: the organisation's own types (Settings → Organisation), each with its count; archived ones only
  // while records still have them.
  // COMPANIES-MODEL: only the types somebody has (an empty row of zeros is clutter); "No type" only when someone is.
  const FILTERS: [Show, string][] = [["all", "All"], ...types.filter((t) => t.count > 0).map((t): [Show, string] => [t.key, t.plural]), ...(contacts.some((c) => !c.contactType && !c.clientId) ? [["unset", "No type"] as [Show, string]] : [])];
  const show: Show = FILTERS.some(([key]) => key === params.type) ? params.type as Show : "all";
  const q = (params.q ?? "").trim().toLowerCase();
  const noCompany = params.company === "none";
  // AC-CONTACTS (2397): the tags people have, most used first; ?tag= shows only them ("who is testing?").
  const tagCounts = new Map<string, number>(); for (const c of contacts) for (const t of c.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tag = params.tag && tagCounts.has(params.tag) ? params.tag : null;
  // COMPANIES-MODEL: project columns only where people have projects (a column of zeros says nothing).
  const anyProjects = contacts.some((c) => c.projects > 0);
  // AC-CONTACTS: a Status column only where someone has a status or a tag (as Projects above).
  const anyTracked = contacts.some((c) => c.status || c.tags?.length);
  const matches = contacts.filter((c) => (!noCompany || !c.companyId) && (!tag || (c.tags ?? []).includes(tag)) && (!q || `${c.name} ${c.designation ?? ""} ${c.city ?? ""} ${c.clientName ?? ""} ${c.companyName ?? ""}`.toLowerCase().includes(q)));
  const sets = Object.fromEntries(FILTERS.map(([key]) => [key, matches.filter((c) => key === "all" || (key === "unset" ? !c.contactType && !c.clientId : c.contactType === key))])) as Record<Show, ContactRow[]>;
  // MODULES-1024: the first 120 rows render unless "Show all" is asked for (447 rows were a 1.57 MB page and ~3-7 s of server render), as Clients does.
  const all = sets[show], rows = params.all === "1" ? all : all.slice(0, 120);
  const link = (type: Show, all?: boolean, withTag: string | null = tag) => {
    const s = new URLSearchParams(); if (type !== "all") s.set("type", type); if (withTag) s.set("tag", withTag); if (q) s.set("q", params.q!.trim()); if (noCompany) s.set("company", "none"); if (all) s.set("all", "1");
    const text = s.toString(); return text ? `/contacts?${text}` : "/contacts";
  };
  return (
    <Page fit>
      <PageHeader title="Contacts" context={[`${count(contacts.length)} ${contacts.length === 1 ? "person" : "people"} you work with`]}
        actions={<>{show === "talent" ? <Link className={styles.btn} href="/contacts/models">Benefit ranking</Link> : null}{canEdit && (contacts.length || params.add === "1") ? <AddPerson companies={co.data?.companies ?? []} types={types} tags={tags.map(([t]) => t)} canAddTypes={canEdit} words={{ client: one }} startOpen={params.add === "1"} /> : null}</>} />
      <BookTabs current="people" clients={words.clients} counts={{ people: contacts.length, companies: co.data?.companies.length, clients: co.data?.clientCount }} />
      {/* Judges r6: an empty book has nothing to filter or search; its one step is Add contact. */}
      {contacts.length ? <div className={`${styles.toolbar} ${css.shrink}`}>
        <div className={css.tools}>
          <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Filter contacts by type">
            {FILTERS.map(([key, label]) => <Link key={key} href={link(key)} className={styles.segment} aria-current={show === key ? "true" : undefined}>{label}<span className={styles.muted}>{count(sets[key].length)}</span></Link>)}
          </div>
        </div>
        <div className={css.tools}>
          {tags.length ? <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Filter contacts by tag">
            <Link href={link(show, false, null)} className={styles.segment} aria-current={!tag ? "true" : undefined}>Any tag</Link>
            {tags.slice(0, 6).map(([t, n]) => <Link key={t} href={link(show, false, t)} className={styles.segment} aria-current={tag === t ? "true" : undefined}>{tagLabel(t)}<span className={styles.muted}>{count(n)}</span></Link>)}
          </div> : null}
          <form className={styles.search} action="/contacts" role="search">
            {show !== "all" ? <input type="hidden" name="type" value={show} /> : null}
            {tag ? <input type="hidden" name="tag" value={tag} /> : null}
            <Search size={14} aria-hidden="true" />
            <input className={styles.input} type="search" name="q" defaultValue={params.q ?? ""} placeholder="Search contacts…" title="Matches name, designation, city, client or company" aria-label="Search contacts, clients and places" />
          </form>
        </div>
      </div> : null}
      {show === "unset" && rows.length ? <p className={css.note} style={{ margin: 0 }}><Info size={14} aria-hidden="true" /><span>Pulse could not tell these people’s type. Open one and set it.</span></p> : null}
      {rows.length ? <Pager primary unit="contacts" mobile={20}><PhoneBatch step={20} unit="contacts">
        <div className={`${styles.panel} ${css.sheet}`} data-enter=""><table className={styles.table}>
          <thead className={styles.hideSmall}><tr><th>Contact</th><th className={styles.hideSmall}>Type</th>{anyTracked ? <th className={styles.hideSmall}>Status</th> : null}<th className={styles.hideSmall}>Company</th>{anyProjects ? <><th className={styles.right}>Projects</th><th className={styles.hideSmall}>Latest project</th></> : null}</tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td className={css.lead}><span className={css.personCell}><Avatar name={c.name} id={c.id} photoAt={c.photoAt} size={32} /><span>
                <Link href={`/contacts/${c.id}`} className={styles.cellLink} title={c.name}>{c.name}</Link>
                <span className={styles.cellSub}><span className={css.smallOnly}>{[c.contactType ? types.find((t) => t.key === c.contactType)?.label ?? c.contactType : c.clientId ? one : "No type", c.clientName && c.clientName !== c.name ? c.clientName : null].filter(Boolean).join(" · ")}{c.designation || c.city ? " · " : ""}</span>{[c.designation, c.city].filter(Boolean).join(" · ")}</span>
                {c.status ? <span className={css.smallOnly}><ContactStatusBadge status={c.status} /></span> : null}
              </span></span></td>
              <td className={styles.hideSmall}><TypeBadge types={types} entity="contact" value={c.contactType} empty={c.clientId ? one : "No type"} /></td>
              {anyTracked ? <td className={`${styles.hideSmall} ${css.statusCell}`}>{c.status ? <ContactStatusBadge status={c.status} /> : <span className={styles.muted}>Not set</span>}
                {c.tags?.length ? <span className={styles.cellSub}>{c.tags.map(tagLabel).join(" · ")}</span> : null}</td> : null}
              <td className={`${styles.hideSmall} ${css.companyCell}`}>{c.companyId ? <Link href={`/contacts/companies/${c.companyId}`} className={styles.cellLink}>{c.companyName}</Link> : c.companyName ? <span>{c.companyName}</span> : <span className={styles.muted}>No company</span>}
                {c.clientId ? <span className={styles.cellSub}><Link href={`/clients/${c.clientId}`} className={styles.cellLink}>{c.clientName === c.name ? `A ${one.toLowerCase()} themselves` : `${one}: ${c.clientName}`}</Link></span> : null}</td>
              {anyProjects ? <><td className={`${styles.right} ${styles.num}`}>{count(c.projects)}</td>
              <td className={`${styles.nowrap} ${styles.hideSmall}`}>{c.lastMonth ? month(c.lastMonth) : <span className={styles.muted}>None dated</span>}</td></> : null}
            </tr>
          ))}</tbody>
        </table></div>
      </PhoneBatch></Pager> : <section className={styles.panel}><Empty icon={ContactRound} first title={contacts.length ? "Nobody matches" : "No contacts yet"} text={q ? `Nothing matches “${params.q}” in this view.` : tag ? `Nobody here is tagged ${tagLabel(tag)}.` : canEdit ? "Add the people you work with: clients, suppliers and partners." : "Nobody here yet."} action={show !== "all" || q || noCompany || tag ? { href: "/contacts", label: "Show everyone" } : canEdit && !contacts.length ? { href: "/contacts?add=1", label: "Add contact", primary: true } : undefined} /></section>}
      {all.length > rows.length ? <p className={styles.muted} data-cap="">Showing the first {count(rows.length)} of {count(all.length)} contacts. <Link href={link(show, true)}>Show all {count(all.length)}</Link> or search above.</p> : null}
    </Page>
  );
}
