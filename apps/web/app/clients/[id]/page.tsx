import Link from "next/link";
import { MasterProfile } from "../master";
import { ClientSalesXray } from "../../apps/sales-xray/linked";
import { Clock, FolderSearch, History as HistoryIcon, Mail, Megaphone, PackageOpen, Phone, UsersRound } from "lucide-react";
import { api } from "../../lib/api";
import { ago, count, dayYear, plural } from "../../lib/format";
import { RecordForm, SuggestCorrection } from "../../records";
import { Avatar, Badge, DeliveryFeed, Empty, History, Kpi, Message, Page, PageHeader, Panel, QueryTabs, Tiles, Why, styles } from "../../ui";
import { CLIENT_STATUS, clientFields, contactFields, Detail, EDIT_NOTE, ProjectsTable, SOURCES, css, groupProjects, month, today } from "../shared";
import { CustomFacts, TypeBadge, customValues, findType, typeLabel } from "../../record-types";
import type { ClientDetail } from "../types";
import { WaChatsSection, WaInsightKpis } from "../../chats/whatsapp/wa";
import { ClientAccessPanel, type PanelData } from "../access-panel";

const TABS = ["overview", "projects", "contacts", "chats", "campaigns", "history", "identity", "access", "salesxray"] as const;
type Tab = typeof TABS[number];

export default async function Client({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params; const query = await searchParams;
  const [r, sxStatus] = await Promise.all([api<ClientDetail>(`clients/${encodeURIComponent(id)}`), api<{ configured?: boolean }>("sales-xray/status")]);
  // XRAY-LINK: the Sales X-Ray tab when the app is on and set up on this server.
  const sxOn = !!sxStatus.data?.configured;
  if (r.error) return <Message text={r.error} />; const c = r.data; if (!c) return null;
  const tab: Tab = TABS.includes(query.tab as Tab) ? query.tab as Tab : "overview";
  const base = `/clients/${c.id}`;
  const groups = groupProjects(c.projects); const repeated = groups.filter((g) => g.length > 1).length;
  const deliveries = c.projects.reduce((n, p) => n + p.total, 0);
  const dated = c.projects.map((p) => p.startMonth).filter((m): m is string => !!m).sort();
  const last = c.projects.map((p) => p.lastDeliveredAt).filter((d): d is string => !!d).sort().at(-1);
  const status = c.status ? CLIENT_STATUS[c.status] : null;
  // PEOPLE-CONTACTS: the organisation's own client types, and the fields of this client's type.
  const types = c.types ?? [], ctype = findType(types, "client", c.clientType);
  const edit = c.canEdit ? { path: `clients/${c.id}`, title: `Edit ${c.name}`, fields: clientFields(types, c.clientType),
    values: { displayName: c.name, companyName: c.companyName, clientType: c.clientType, status: c.status, website: c.website, email: c.email, phone: c.phone, city: c.city, notes: c.notes, ...customValues(ctype, c.custom) } } : undefined;
  const addContact = c.canEdit ? <RecordForm path="contacts" title={`Add a contact at ${c.name}`} fields={contactFields(types)} extra={{ clientId: c.id }} label="Add contact" icon="add" created="/contacts/"
    note={c.contacts.length ? "The new contact is linked to this client." : "The new contact is linked to this client and becomes its primary contact."} /> : null;
  const maxYear = Math.max(1, ...c.byYear.map((y) => y.engagements));
  // WA-IMPORT: the client's WhatsApp groups (the ones the viewer reads), a tab only when there are any.
  const chats = (await api<{ total: number }>(`chats/whatsapp?client=${c.id}&limit=1`)).data?.total ?? 0;
  return (
    <Page fit>
      {/* The record's identity lives in the window toolbar, so every tab gets the height under it. */}
      <PageHeader title={c.name} back={{ href: "/clients", label: "Clients" }} recent={{ kind: "client" }}
        context={[
          c.editedBy ? `Edited by ${c.editedBy}` : null,
          <span key="type" title={c.typeBasis === "inferred" ? "Pulse inferred this type from folder names. Edit the client to confirm it." : undefined}>{typeLabel(types, "client", c.clientType)}{c.typeBasis === "inferred" ? " (inferred)" : ""}</span>,
          c.projects.length > 1 ? <Badge key="repeat" tone="accent">Repeat · {c.projects.length}×</Badge> : null,
          status ? <Badge key="status" tone={status.tone}>{status.label}</Badge> : null,
          c.companyName && c.companyName !== c.name ? c.companyName : null,
          c.contactId && c.contactName !== c.name ? <span key="contact">Contact <Link href={`/contacts/${c.contactId}`} className={styles.fill}>{c.contactName}</Link></span> : null,
          c.city,
          last ? `Last delivery ${ago(last)}` : "No deliveries indexed",
        ]}
        actions={<><Link className={styles.btn} href={`${base}/visits`}>Site visits</Link>{edit ? <><Link className={styles.btn} href={`/stewardship/client/${c.id}`}>Correct data & links</Link>{addContact}<RecordForm {...edit} label="Edit" variant="primary" note={EDIT_NOTE} /></> : <SuggestCorrection entity="client" id={c.id} name={c.name} />}</>} />
      <QueryTabs base={base} current={tab} items={[{ key: "overview", label: "Overview" }, { key: "projects", label: "Projects", count: c.projects.length }, { key: "contacts", label: "Contacts", count: c.contacts.length }, ...(chats || tab === "chats" ? [{ key: "chats", label: "WhatsApp chats", count: chats }] : []), ...(c.campaigns.length ? [{ key: "campaigns", label: "Ad campaigns", count: c.campaigns.length }] : []), { key: "history", label: "History" }, {key:"identity",label:"Identity & health"}, ...(c.canEdit ? [{ key: "access", label: "Pulse access" }] : []), ...(sxOn ? [{ key: "salesxray", label: "Sales X-Ray" }] : [])]} />
      {tab === "salesxray" && sxOn ? <ClientSalesXray clientId={c.id} clientName={c.name} /> : null}

      {tab === "identity" ? <MasterProfile id={c.id}/> : null}
      {/* CLIENT-PORTAL: their sign-in to Pulse, their people there and the onboarding steps. */}
      {tab === "access" ? <ClientAccessPanel id={c.id} name={c.name} initial={(await api<PanelData>(`clients/${encodeURIComponent(c.id)}/access`)).data ?? null} /> : null}
      {/* Overview: key numbers and years, the latest work and the record, side by side at full height. */}
      {tab === "overview" ? <div className={css.profileGrid} data-grow="" data-enter="">
        <div className={css.glance}>
          <Tiles count={4}>
            <Kpi label="Engagements" value={count(c.projects.length)} href={`${base}?tab=projects`} note="Project folders, one per shoot" />
            <Kpi label="Distinct projects" value={count(groups.length)} href={`${base}?tab=projects`} note={repeated ? `${plural(repeated, "project")} shot more than once` : "No project repeated yet"} />
            <Kpi label="Deliveries" value={count(deliveries)} note={last ? `Latest ${ago(last)}` : "None indexed yet"} />
            <Kpi label="Working since" value={dated.length ? month(dated[0]) : "—"} note={dated.length ? `Latest engagement ${month(dated.at(-1)!)}` : "No dated project"} />
          </Tiles>
          <Panel fill title="By year" sub="Engagements and deliveries">
            {c.byYear.length ? <ul className={css.years}>{c.byYear.map((y) => (
              <li key={y.year} className={css.year}>
                <b>{y.year}</b>
                <span className={css.bar} aria-hidden="true"><i style={{ width: `${(y.engagements / maxYear) * 100}%` }} /></span>
                <span className={css.yearNums}><span><b>{count(y.engagements)}</b> {y.engagements === 1 ? "engagement" : "engagements"}</span><span><b>{count(y.deliveries)}</b> {y.deliveries === 1 ? "delivery" : "deliveries"}</span></span>
              </li>
            ))}</ul> : <Empty icon={Clock} first title="No dated projects" text="History appears once a project with a start month is linked to this client." />}
          </Panel>
        </div>
        <Panel fill title="Latest deliveries" sub={c.latest.length ? `Last ${c.latest.length}` : undefined} action={c.projects.length ? { href: `${base}?tab=projects`, label: "All projects" } : undefined}>
          {c.latest.length ? <DeliveryFeed items={c.latest} today={today()} /> : <Empty icon={PackageOpen} first title="No deliveries indexed" text="Deliveries show here once files land in this client's project folders." />}
        </Panel>
        <Panel fill title="Details" tools={edit ? <RecordForm {...edit} label="Edit" variant="ghost" note={EDIT_NOTE} /> : undefined}>
          <dl className={styles.facts}>
            <dt>Type</dt><dd><TypeBadge types={types} entity="client" value={c.clientType} />{c.typeBasis === "inferred" ? <span className={styles.muted}> · inferred</span> : null}</dd>
            <dt>Company</dt><dd><Detail value={c.companyName} add="Add company name" edit={edit} /></dd>
            <dt>Status</dt><dd><Detail value={c.status} show={status?.label} add="Set status" edit={edit} /></dd>
            <dt>Contact</dt><dd>{c.contactId ? <Link href={`/contacts/${c.contactId}`} className={styles.fill}>{c.contactName}</Link> : <Link href={`${base}?tab=contacts`} className={styles.fill}>Add a contact</Link>}</dd>
            <dt>Website</dt><dd><Detail value={c.website} show={c.website ? <a className={styles.fill} href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer">{c.website.replace(/^https?:\/\//, "")}</a> : null} add="Add website" edit={edit} /></dd>
            <dt>E-mail</dt><dd><Detail value={c.email} show={<a className={styles.fill} href={`mailto:${c.email}`}>{c.email}</a>} add="Add e-mail" edit={edit} /></dd>
            <dt>Phone</dt><dd><Detail value={c.phone} show={<a className={styles.fill} href={`tel:${c.phone}`}>{c.phone}</a>} add="Add phone" edit={edit} /></dd>
            <dt>City</dt><dd><Detail value={c.city} add="Add city" edit={edit} /></dd>
            <dt>Notes</dt><dd className={css.pre}><Detail value={c.notes} add="Add notes" edit={edit} /></dd>
            <CustomFacts type={ctype} custom={c.custom} />
          </dl>
        </Panel>
      </div> : null}

      {tab === "projects" ? (
        <Panel fill primary unit="engagements" title="Projects" sub={`${plural(c.projects.length, "engagement")} · ${plural(groups.length, "distinct project")}`} tools={c.projects.length ? <Why detail="Newest first. Folders for the same development are grouped as one repeat project." /> : undefined}>
          {c.projects.length ? <ProjectsTable projects={c.projects} /> : <Empty icon={FolderSearch} first title="No projects linked" text="Open a project and set its client to see it here." action={{ href: "/projects", label: "Open projects" }} />}
        </Panel>
      ) : null}

      {tab === "contacts" ? (
        <Panel fill unit="contacts" title="Contacts" sub={count(c.contacts.length)} tools={addContact}>
          {c.contacts.length ? <div className={css.contactCards} data-items="">{c.contacts.map((p) => (
            <article key={p.id} className={css.contactCard}>
              <Avatar name={p.name} size={40} />
              <div className={css.contactText}>
                <Link href={`/contacts/${p.id}`} className={styles.rowTitle}>{p.name}</Link>
                <span className={styles.muted}>{p.designation ?? (p.contactType ? typeLabel(types, "contact", p.contactType) : "Type not set")}</span>
                {p.email ? <a className={css.contactLine} href={`mailto:${p.email}`} title={p.email}><Mail size={13} aria-hidden="true" />{p.email}</a> : null}
                {p.phone ? <a className={css.contactLine} href={`tel:${p.phone}`}><Phone size={13} aria-hidden="true" />{p.phone}</a> : null}
              </div>
              {p.primary ? <Badge tone="accent">Primary</Badge> : null}
            </article>
          ))}</div> : <Empty icon={UsersRound} first title="No contacts yet" text={c.canEdit ? "Add the person the team talks to at this client." : "An admin can add the person the team talks to at this client."}>{addContact}</Empty>}
        </Panel>
      ) : null}

      {tab === "chats" ? <Panel fill title="WhatsApp chats" sub="The client's groups, imported from WhatsApp"><WaInsightKpis subject="client" id={c.id} /><WaChatsSection filter={{ client: c.id }} title="Chats" empty="No imported chat of this client is visible to you." /></Panel> : null}
      {tab === "campaigns" ? (
        <Panel fill primary unit="campaigns" title="Campaigns" sub={count(c.campaigns.length)}>
          {c.campaigns.length ? <ul className={styles.list}>{c.campaigns.map((g) => (
            <li key={g.id} className={styles.row}>
              <span className={styles.rowIcon} aria-hidden="true"><Megaphone size={12} /></span>
              <div className={styles.rowMain}><span className={styles.rowTitle}>{g.name}</span><span className={styles.rowMeta}><span>{g.projectName}</span>{g.objective ? <span>{g.objective}</span> : null}</span></div>
              {g.platform ? <span className={styles.rowEnd}><Badge>{g.platform}</Badge></span> : null}
            </li>
          ))}</ul> : <Empty icon={Megaphone} first title="No campaigns yet" text="Ad campaigns linked to this client's projects will show here." />}
        </Panel>
      ) : null}

      {tab === "history" ? (
        <div className={css.halves} data-grow="" data-enter="">
          <Panel fill title="Record changes" sub={c.history.length ? count(c.history.length) : undefined}>
            {c.history.length ? <History items={c.history} /> : <Empty icon={HistoryIcon} first title="No edits yet" text="Changes made in Pulse are listed here with who made them." />}
          </Panel>
          <Panel fill title="How Pulse knows this">
            <dl className={styles.facts}>
              <dt>Source</dt><dd>{SOURCES[c.source ?? ""] ?? c.source ?? "Not recorded"}</dd>
              <dt>Type</dt><dd>{c.typeBasis === "inferred" ? "Inferred by Pulse from how the client is named in folders. Editing the type confirms it." : c.typeBasis === "manual" ? "Set by a person in Pulse." : c.typeBasis ?? "Not recorded"}</dd>
              <dt>Names seen</dt><dd>{c.aliases.length ? <span className={styles.chips}>{c.aliases.map((a, i) => <Badge key={i}>{a.raw}<span className={styles.muted} title={`Matched by: ${a.method}`}> · {a.method.replace(/_/g, " ")} · source rule</span></Badge>)}</span> : <span className={styles.muted}>No other spellings matched to this client</span>}</dd>
              <dt>Kept fields</dt><dd>{c.locked.length ? <>{c.locked.map((f) => f.replace(/_/g, " ")).join(", ")} <span className={styles.muted}>· edited in Pulse, not overwritten by the sync</span></> : <span className={styles.muted}>None. Every field still follows the source.</span>}</dd>
              <dt>Created</dt><dd>{dayYear(c.createdAt)}</dd>
            </dl>
          </Panel>
        </div>
      ) : null}
    </Page>
  );
}
