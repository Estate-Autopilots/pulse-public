import Link from "next/link";
import { ContactRound, Info, Search } from "lucide-react";
import { api } from "../lib/api";
import { count } from "../lib/format";
import { RecordForm, type FieldDef } from "../records";
import { Avatar, Empty, Message, Page, PageHeader, Pager, styles } from "../ui";
import { css, month } from "../clients/shared";
import type { ClientList, ContactList, ContactRow } from "../clients/types";
import { TypeBadge, typeOptions, type RecordType } from "../record-types";

type Show = string;

export default async function Contacts({ searchParams }: { searchParams: Promise<{ type?: string; q?: string; all?: string }> }) {
  const params = await searchParams;
  const [r, cl] = await Promise.all([api<ContactList>("contacts"), api<ClientList>("clients")]);
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const { contacts, canEdit } = r.data; const types: RecordType[] = r.data.types;
  // PEOPLE-CONTACTS: the organisation's own types (Settings → Organisation), each with its count; archived ones only
  // while records still have them.
  const FILTERS: [Show, string][] = [["all", "All"], ...types.filter((t) => !t.archived || t.count).map((t): [Show, string] => [t.key, t.plural]), ["unset", "Type not set"]];
  const show: Show = FILTERS.some(([key]) => key === params.type) ? params.type as Show : "all";
  const q = (params.q ?? "").trim().toLowerCase();
  const matches = contacts.filter((c) => !q || `${c.name} ${c.designation ?? ""} ${c.city ?? ""} ${c.clientName ?? ""} ${c.companyName ?? ""}`.toLowerCase().includes(q));
  const sets = Object.fromEntries(FILTERS.map(([key]) => [key, matches.filter((c) => key === "all" || (key === "unset" ? !c.contactType : c.contactType === key))])) as Record<Show, ContactRow[]>;
  // MODULES-1024: the first 120 rows render unless "Show all" is asked for (447 rows were a 1.57 MB page and ~3-7 s of server render), as Clients does.
  const all = sets[show], rows = params.all === "1" ? all : all.slice(0, 120);
  const link = (type: Show, all?: boolean) => {
    const s = new URLSearchParams(); if (type !== "all") s.set("type", type); if (q) s.set("q", params.q!.trim()); if (all) s.set("all", "1");
    const text = s.toString(); return text ? `/contacts?${text}` : "/contacts";
  };
  const cities = [...new Set(contacts.map((c) => c.city).filter((c): c is string => !!c))].sort();
  const roles = [...new Set(contacts.map((c) => c.designation).filter((c): c is string => !!c))].sort().slice(0, 40);
  const fields: FieldDef[] = [
    { key: "name", label: "Name", required: true, wide: true, section: "Who", placeholder: "Full name" },
    { key: "contactType", label: "Type", type: "choice", options: typeOptions(types, "contact"), hint: "Hover a type for what it means. Admins add types in Settings → Organisation." },
    { key: "designation", label: "Designation", suggest: roles, placeholder: "Sales head, founder, model…" }, { key: "city", label: "City", suggest: cities },
    { key: "clientId", label: "Client", type: "select", wide: true, section: "Works with", hint: "Links this person to the client and its projects. Leave empty for models, talent and anyone not tied to one client.",
      options: [...(cl.data?.clients ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.companyName && c.companyName !== c.name ? `${c.name} (${c.companyName})` : c.name })) },
    { key: "phone", label: "Phone", type: "tel", section: "Reach them", placeholder: "+91 …" }, { key: "email", label: "E-mail", type: "email" },
    { key: "notes", label: "Notes", type: "textarea", placeholder: "Rates, availability, how they prefer to be contacted…" },
  ];
  return (
    <Page fit>
      <PageHeader title="Contacts" context={[`${count(contacts.length)} contacts`, "People outside the team", `${count(contacts.filter((c) => !c.contactType).length)} without a type`]}
        actions={<>{show === "talent" ? <Link className={styles.btn} href="/contacts/models">Benefit ranking</Link> : null}<Link className={styles.btn} href="/contacts/identity">Identity review</Link>{canEdit ? <RecordForm path="contacts" title="Add a contact" sub="Someone outside the team: a developer, a channel partner, a model." fields={fields} label="Add contact" icon="add" variant="primary" created="/contacts/" /> : null}</>} />
      <div className={`${styles.toolbar} ${css.shrink}`}>
        <div className={css.tools}>
          <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Filter contacts by type">
            {FILTERS.map(([key, label]) => <Link key={key} href={link(key)} className={styles.segment} aria-current={show === key ? "true" : undefined}>{label}<span className={styles.muted}>{count(sets[key].length)}</span></Link>)}
          </div>
        </div>
        <div className={css.tools}>
          <form className={styles.search} action="/contacts" role="search">
            {show !== "all" ? <input type="hidden" name="type" value={show} /> : null}
            <Search size={14} aria-hidden="true" />
            <input className={styles.input} type="search" name="q" defaultValue={params.q ?? ""} placeholder="Search contacts…" title="Matches name, designation, city, client or company" aria-label="Search contacts, clients and places" />
          </form>
        </div>
      </div>
      {show === "unset" && rows.length ? <p className={css.note} style={{ margin: 0 }}><Info size={14} aria-hidden="true" /><span>These contacts came from folder names where Pulse could not tell the type. Open one and set it.</span></p> : null}
      {rows.length ? <Pager primary unit="contacts" mobile={20}>
        <div className={`${styles.panel} ${css.sheet}`} data-enter=""><table className={styles.table}>
          <thead><tr><th>Contact</th><th className={styles.hideSmall}>Type</th><th className={styles.hideSmall}>Client</th><th className={styles.right}>Projects</th><th className={styles.hideSmall}>Latest project</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td className={css.lead}><span className={css.personCell}><Avatar name={c.name} id={c.id} photoAt={c.photoAt} size={32} /><span>
                <Link href={`/contacts/${c.id}`} className={styles.cellLink} title={c.name}>{c.name}</Link>
                <span className={styles.cellSub}><span className={css.smallOnly}>{[c.contactType ? types.find((t) => t.key === c.contactType)?.label ?? c.contactType : "Type not set", c.clientName && c.clientName !== c.name ? c.clientName : null].filter(Boolean).join(" · ")}{c.designation || c.city ? " · " : ""}</span>{[c.designation, c.city].filter(Boolean).join(" · ")}</span>
              </span></span></td>
              <td className={styles.hideSmall}><TypeBadge types={types} entity="contact" value={c.contactType} empty="Not set" /></td>
              <td className={styles.hideSmall}>{c.clientId ? <><Link href={`/clients/${c.clientId}`} className={styles.cellLink}>{c.clientName === c.name ? <span className={styles.muted}>Own client record</span> : c.clientName}</Link>{c.companyName && c.companyName !== c.clientName ? <span className={styles.cellSub}>{c.companyName}</span> : null}</> : <span className={styles.muted}>No client</span>}</td>
              <td className={`${styles.right} ${styles.num}`}>{count(c.projects)}</td>
              <td className={`${styles.nowrap} ${styles.hideSmall}`}>{c.lastMonth ? month(c.lastMonth) : <span className={styles.muted}>None dated</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Pager> : <section className={styles.panel}><Empty icon={ContactRound} first title={show === "talent" && !q ? "No models yet" : "No contacts match"} text={q ? `Nothing matches “${params.q}” in this view.` : canEdit ? "Add a contact, or set a type on an existing one, to see it here." : "No contacts of this type are recorded yet."} action={show !== "all" || q ? { href: "/contacts", label: "Show all contacts" } : undefined} /></section>}
      {all.length > rows.length ? <p className={styles.muted} data-cap="">Showing the first {count(rows.length)} of {count(all.length)} contacts. <Link href={link(show, true)}>Show all {count(all.length)}</Link> or search above.</p> : null}
    </Page>
  );
}
