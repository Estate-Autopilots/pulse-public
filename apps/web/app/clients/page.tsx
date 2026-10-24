import Link from "next/link";
import { MasterListView } from "./master";
import { RenewalsView } from "../research/views";
import { Building2, CalendarRange, FolderOpen, LayoutGrid, MapPin, Rows3, Search } from "lucide-react";
import { api, workWords } from "../lib/api";
import { ago, count, plural } from "../lib/format";
import { RecordForm } from "../records";
import { Avatar, Badge, Empty, Message, Page, PageHeader, Pager, Why, styles } from "../ui";
import { ClientTabs } from "./tabs";
import { clientFields, css, months } from "./shared";
import type { ClientList, ClientRow } from "./types";
import { TypeBadge } from "../record-types";

type Show = string;
type Sort = "work" | "recent" | "name";
const SORTS: Record<Sort, { label: string; hint: string; by: (a: ClientRow, b: ClientRow) => number }> = {
  work: { label: "Most work", hint: "most engagements first", by: (a, b) => b.engagements - a.engagements || b.deliveries - a.deliveries || a.name.localeCompare(b.name) },
  recent: { label: "Recent", hint: "latest engagement first", by: (a, b) => (b.lastMonth ?? "").localeCompare(a.lastMonth ?? "") || (b.lastDeliveredAt ?? "").localeCompare(a.lastDeliveredAt ?? "") || a.name.localeCompare(b.name) },
  name: { label: "A–Z", hint: "by name", by: (a, b) => a.name.localeCompare(b.name) },
};

export default async function Clients({ searchParams }: { searchParams: Promise<{ type?: string; sort?: string; repeat?: string; q?: string; all?: string; view?: string;tab?:string }> }) {
  const params = await searchParams;
  if(params.tab==='master')return <Page fit><PageHeader title="Clients" context={['Shared identity for delivery, finance and sales']}/><ClientTabs current="/clients?tab=master"/><MasterListView/></Page>;
  if(params.tab==='renewals')return <Page fit><PageHeader title="Clients" context={['Observed recency and repeat engagements']}/><ClientTabs current="/clients?tab=renewals"/><RenewalsView/></Page>;
  const r = await api<ClientList>("clients");
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const { clients, unassigned, canEdit } = r.data;
  // PEOPLE-CONTACTS: the organisation's own client types, each a filter (archived ones only while clients have them).
  const types = r.data.types ?? [];
  const show: Show = params.type && types.some((t) => t.key === params.type) ? params.type : "all";
  const sort: Sort = params.sort === "recent" || params.sort === "name" ? params.sort : "work";
  const view: "cards" | "list" = params.view === "list" ? "list" : "cards";
  const repeat = params.repeat === "1"; const q = (params.q ?? "").trim().toLowerCase();
  const matches = clients.filter((c) => (!repeat || c.engagements > 1) && (!q || `${c.name} ${c.companyName ?? ""} ${c.contactName ?? ""} ${c.city ?? ""} ${(c.locations ?? []).join(" ")}`.toLowerCase().includes(q)));
  const sets: Record<Show, ClientRow[]> = Object.fromEntries([["all", matches], ...types.map((t) => [t.key, matches.filter((c) => c.clientType === t.key)])]);
  const sorted = [...sets[show]].sort(SORTS[sort].by);
  // QA-1024: the page renders the first 120 clients unless "Show all" is asked for (283 cards were 1.9 MB of page on a
  // phone, the slowest page after Projects); counts, filters and search still cover every client.
  const rows = params.all === "1" ? sorted : sorted.slice(0, 120);
  const repeats = clients.filter((c) => c.engagements > 1).length;
  const link = (next: { type?: Show; sort?: Sort; repeat?: boolean; all?: boolean; view?: "cards" | "list" }) => {
    const s = new URLSearchParams(); const type = next.type ?? show, order = next.sort ?? sort;
    if ((next.view ?? view) === "list") s.set("view", "list");
    if (type !== "all") s.set("type", type); if (order !== "work") s.set("sort", order);
    if (next.repeat ?? repeat) s.set("repeat", "1"); if (q) s.set("q", params.q!.trim()); if (next.all) s.set("all", "1");
    const text = s.toString(); return text ? `/clients?${text}` : "/clients";
  };
  const filters: [Show, string][] = [["all", "All"], ...types.filter((t) => (!t.archived || t.count) && (t.key !== "internal" || t.count)).map((t): [Show, string] => [t.key, t.plural])];
  const words = await workWords();
  return (
    <Page fit>
      <PageHeader title={words.clients} meta={<Why detail="Engagements are project folders, one per shoot. Projects counts each development once, so a client who returns for the same development has more engagements than projects." more="Repeat clients have more than one engagement." />} context={[`${count(clients.length)} clients`, `${count(repeats)} repeat`, `${count(clients.reduce((n, c) => n + c.engagements, 0))} engagements`]}
        actions={canEdit ? <RecordForm path="clients" title="Add a client" fields={clientFields(types)} label="Add client" icon="add" variant="primary" created="/clients/" note="Projects are linked to a client from the project page." /> : undefined} />
      <ClientTabs current="/clients" words={words} />
      <div className={`${styles.toolbar} ${css.shrink}`}>
        <div className={css.tools}>
          <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Filter clients by type">
            {filters.map(([key, label]) => <Link key={key} href={link({ type: key })} className={styles.segment} aria-current={show === key ? "true" : undefined}>{label}<span className={styles.muted}>{count(sets[key].length)}</span></Link>)}
          </div>
          <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Repeat clients">
            <Link href={link({ repeat: !repeat })} className={styles.segment} aria-current={repeat ? "true" : undefined} title="Clients with more than one engagement">Repeat only<span className={styles.muted}>{count(repeats)}</span></Link>
          </div>
        </div>
        <div className={css.tools}>
          <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Sort clients">
            {(Object.keys(SORTS) as Sort[]).map((key) => <Link key={key} href={link({ sort: key })} className={styles.segment} aria-current={sort === key ? "true" : undefined}>{SORTS[key].label}</Link>)}
          </div>
          <form className={styles.search} action="/clients" role="search">
            {show !== "all" ? <input type="hidden" name="type" value={show} /> : null}
            {sort !== "work" ? <input type="hidden" name="sort" value={sort} /> : null}
            {repeat ? <input type="hidden" name="repeat" value="1" /> : null}
            {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
            <Search size={14} aria-hidden="true" />
            <input className={styles.input} type="search" name="q" defaultValue={params.q ?? ""} placeholder="Search clients…" title="Matches client, company, contact, city or project location" aria-label="Search clients, contacts and places" />
          </form>
          <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="View">
            <Link href={link({ view: "cards" })} className={styles.segment} aria-current={view === "cards" ? "true" : undefined} title="Cards view"><LayoutGrid size={14} aria-hidden="true" /><span className={styles.srOnly}>Cards view</span></Link>
            <Link href={link({ view: "list" })} className={styles.segment} aria-current={view === "list" ? "true" : undefined} title="List view"><Rows3 size={14} aria-hidden="true" /><span className={styles.srOnly}>List view</span></Link>
          </div>
        </div>
      </div>
      {unassigned ? <p className={css.note} style={{ margin: 0 }}><FolderOpen size={14} aria-hidden="true" /><span><b>{plural(unassigned, "client-work project")}</b> {unassigned === 1 ? "has" : "have"} no client yet. Open a project to set its client.</span><Link href="/projects">Open projects</Link></p> : null}
      {rows.length && view === "list" ? <Pager primary unit="clients" mobile={20}>
        <div className={`${styles.panel} ${css.sheet}`} data-enter=""><table className={styles.table}>
          <thead><tr><th>Client</th><th className={styles.hideSmall}>Type</th><th className={styles.right}>Engagements</th><th className={`${styles.right} ${styles.hideSmall}`}>Projects</th><th className={styles.right}>Deliveries</th><th className={styles.hideSmall}>Working period</th><th className={css.roomy}>Places</th><th className={styles.hideSmall}>Last delivery</th></tr></thead>
          <tbody>{rows.map((c) => {
            const sub = [c.companyName && c.companyName !== c.name ? c.companyName : null, c.contactName && c.contactName !== c.name ? c.contactName : null].filter(Boolean).join(" · ");
            return (
              <tr key={c.id}>
                <td className={css.lead}><span className={css.personCell}><Avatar name={c.name} shape="square" size={32} /><span>
                  <Link href={`/clients/${c.id}`} className={styles.cellLink} title={c.name}>{c.name}</Link>
                  {sub ? <span className={styles.cellSub} title={sub}>{sub}</span> : null}
                </span></span></td>
                <td className={styles.hideSmall}><span className={css.tags}><TypeBadge types={types} entity="client" value={c.clientType} />{c.engagements > 1 ? <Badge tone="accent">Repeat</Badge> : null}</span></td>
                <td className={`${styles.right} ${styles.num}`}>{count(c.engagements)}</td>
                <td className={`${styles.right} ${styles.num} ${styles.hideSmall}`}>{count(c.projects)}</td>
                <td className={`${styles.right} ${styles.num}`}>{count(c.deliveries)}</td>
                <td className={`${styles.nowrap} ${styles.hideSmall}`}>{months(c.firstMonth, c.lastMonth) ?? <span className={styles.muted}>Not dated</span>}</td>
                <td className={`${css.roomy} ${css.places}`} title={c.locations?.join(", ") || undefined}>{c.locations?.length ? <>{c.locations.slice(0, 2).join(", ")}{c.locations.length > 2 ? <span className={styles.muted}> +{c.locations.length - 2}</span> : null}</> : <span className={styles.muted}>—</span>}</td>
                <td className={`${styles.nowrap} ${styles.hideSmall}`}>{c.lastDeliveredAt ? ago(c.lastDeliveredAt) : <span className={styles.muted}>None indexed</span>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Pager> : rows.length ? <Pager primary unit="clients" mobile={12}>
        <div className={`${styles.cards} ${css.clientGrid}`} data-items="" data-enter="">
          {rows.map((c) => {
            const sub = [c.companyName, c.contactName && c.contactName !== c.name ? c.contactName : null].filter(Boolean).join(" · ");
            return (
              <Link key={c.id} href={`/clients/${c.id}`} className={styles.card}>
                <div className={styles.cardTop}>
                  <Avatar name={c.name} shape="square" size={38} />
                  <div className={styles.cardText}>
                    <span className={styles.cardTitle} title={c.name}>{c.name}</span>
                    <span className={`${styles.cardSub} ${css.wrap2}`} title={sub || undefined}>{sub || (c.contactName ? "Is their own primary contact" : "No primary contact yet")}</span>
                  </div>
                </div>
                <div className={css.tags}>
                  <TypeBadge types={types} entity="client" value={c.clientType} />
                  {c.engagements > 1 ? <Badge tone="accent">Repeat · {c.engagements}×</Badge> : null}
                </div>
                <div className={`${styles.cardStats} ${css.cardStats}`}>
                  <span><b>{count(c.engagements)}</b>{c.engagements === 1 ? "Engagement" : "Engagements"}</span>
                  <span><b>{count(c.projects)}</b>{c.projects === 1 ? "Project" : "Projects"}</span>
                  <span><b>{count(c.deliveries)}</b>{c.deliveries === 1 ? "Delivery" : "Deliveries"}</span>
                </div>
                <div className={`${styles.cardFoot} ${css.cardFoot}`}>
                  <span><CalendarRange size={12} aria-hidden="true" />{months(c.firstMonth, c.lastMonth) ?? "No dated project"}</span>
                  {c.locations?.length ? <span title={c.locations.join(", ")}><MapPin size={12} aria-hidden="true" /><span className={css.clip}>{c.locations[0]}</span>{c.locations.length > 1 ? <span>+{c.locations.length - 1}</span> : null}</span> : null}
                </div>
              </Link>
            );
          })}
        </div>
      </Pager> : (
        <section className={styles.panel}><Empty icon={Building2} first title={clients.length ? "No clients match" : "No clients yet"} text={q ? `Nothing matches “${params.q}” in this view.` : clients.length ? "No clients in this view." : "Clients appear here once projects are indexed or someone adds one."} action={clients.length ? { href: "/clients", label: "Show all clients" } : undefined} /></section>
      )}
      {sorted.length > rows.length ? <p className={styles.muted} data-cap="">Showing the first {count(rows.length)} of {count(sorted.length)} clients ({SORTS[sort].hint}). <Link href={link({ all: true })}>Show all {count(sorted.length)}</Link> or search above.</p> : null}
    </Page>
  );
}
