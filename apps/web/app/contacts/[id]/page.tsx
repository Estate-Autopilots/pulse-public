import Link from "next/link";
import { Building2, FileText, FolderSearch, History as HistoryIcon, IndianRupee, Lock, Mail, MapPin, MessagesSquare, NotebookPen, Phone, Sparkles, Video } from "lucide-react";
import { api, type Delivery } from "../../lib/api";
import { ago, count, dayYear, plural } from "../../lib/format";
import { PhotoControls, RecordForm, SuggestCorrection } from "../../records";
import { Avatar, Badge, DeliveryFeed, Empty, Message, Page, Panel, QueryTabs, Why, styles } from "../../ui";
import { contactFields, Detail, EDIT_NOTE, ProjectsTable, SOURCES, StageBadge, css as records, groupProjects, month, today } from "../../clients/shared";
import type { ContactDetail } from "../../clients/types";
import { ProfileHeader } from "../../profile-header";
import { CustomFacts, TypeBadge, customValues, findType, typeLabel } from "../../record-types";
import type { TalentProfile } from "../models/talent";
import { TalentMedia, TalentOverview, TalentShoots } from "./talent";
import { LinkSuggestion, MailWith, NoteComposer, RemoveNote } from "./parts";
import css from "./contact.module.css";

// PEOPLE-CONTACTS part 5 (owner, 11 Oct 2026): a contact's own profile, like a person's: who they are, every client
// and project they are part of, what was delivered for them, the conversations (team chats that name them, the viewer's
// own mail with them), their files, the money (finance grants only), notes and one timeline. "Campaigns" is gone (no
// agency campaign is a contact's); talent keeps Shoots and Photos & videos. Each tab reads only its own part.
const TABS = ["overview", "shoots", "media", "projects", "deliveries", "conversations", "files", "money", "timeline"] as const;
type Tab = typeof TABS[number];
type More = {
  deliveries?: Delivery[]; byMonth?: { month: string; n: number }[];
  files?: { fileId: string; name: string; mime: string; path: string; modifiedAt: string | null; projectId: string | null; projectName: string | null; namesThem: boolean }[];
  messages?: { id: string; channelId: string; channel: string; kind: string; body: string; at: string; author: string | null }[]; query?: string; email?: string | null;
  money?: { amounts: boolean; invoices: { source: string; id?: string; number: string; date: string; client: string; clientId: string; total: number | null; due: number | null; status: string; type?: string }[] } | null;
  suggestions?: { kind: "project" | "client"; id: string; name: string; why: string; score: number; sample?: string }[]; canLink?: boolean;
  notes?: { id: string; body: string; at: string; author: string | null; authorId: string | null }[]; events?: { kind: string; title: string; at: string; ref: string | null }[]; viewer?: string | null; canRemoveAny?: boolean;
};
/** How sure Pulse is of a type it read from folder names (contact_profile.type_status), in words. */
const TYPE_STATUS: Record<string, string> = { unresolved: "Type unsure", suggested: "Type suggested", inferred: "Type guessed" };
const EVENT: Record<string, string> = { project: "Project started", delivery: "Delivered", change: "Record" };
const inr = (n: number | null) => n === null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const more = (id: string, part: string) => api<More>(`contacts/${encodeURIComponent(id)}/more?part=${part}`).then((x) => x.data ?? {});

export default async function Contact({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params; const query = await searchParams;
  const r = await api<ContactDetail>(`contacts/${encodeURIComponent(id)}`);
  if (r.error) return <Message text={r.error} />; const c = r.data; if (!c) return null;
  // R55: a model (contact type talent) has a talent profile: shoots, videos and what they bring.
  const talent = c.contactType === "talent" ? (await api<TalentProfile>(`talent/${encodeURIComponent(id)}`)).data ?? null : null;
  const asked = query.tab === "history" ? "timeline" : query.tab === "campaigns" ? "deliveries" : query.tab;   // old links keep working
  const tab: Tab = TABS.includes(asked as Tab) && (talent || !["shoots", "media"].includes(asked!)) ? asked as Tab : "overview";
  const base = `/contacts/${c.id}`, first = c.name.replace(/^(mr|mrs|ms|dr)\.?\s+/i, "").split(/\s+/)[0];
  const types = c.types ?? [], ctype = findType(types, "contact", c.contactType);
  const [part, extra, suggestions] = await Promise.all([
    ["deliveries", "files", "money", "timeline"].includes(tab) ? more(c.id, tab) : tab === "conversations" ? more(c.id, "chats") : Promise.resolve({} as More),
    tab === "overview" ? more(c.id, "timeline") : Promise.resolve({} as More),
    tab === "overview" ? more(c.id, "suggestions") : Promise.resolve({} as More),
  ]);
  const edit = c.canEdit ? { path: `contacts/${c.id}`, title: `Edit ${c.name}`, fields: contactFields(types, c.contactType),
    values: { name: c.name, contactType: c.contactType, designation: c.designation, email: c.email, phone: c.phone, city: c.city, notes: c.notes, ...customValues(ctype, c.custom) } } : undefined;
  const primary = c.clients.find((x) => x.primary) ?? c.clients[0];
  const tabs = [{ key: "overview", label: "Overview" }, ...(talent ? [{ key: "shoots", label: "Shoots", count: talent.shoots.length }, { key: "media", label: "Photos & videos", count: talent.media.length }] : []),
    { key: "projects", label: "Projects", count: c.projects.length }, { key: "deliveries", label: "Deliveries" }, { key: "conversations", label: "Conversations" },
    { key: "files", label: "Files" }, { key: "money", label: "Money" }, { key: "timeline", label: "Notes & timeline" }];
  const details = <Panel fill title="Details" tools={edit ? <RecordForm {...edit} label="Edit" variant="ghost" note={EDIT_NOTE} /> : undefined}>
    <dl className={styles.facts}>
      <dt>Type</dt><dd>{c.contactType ? <TypeBadge types={types} entity="contact" value={c.contactType} /> : <Detail value={null} add="Set type" edit={edit} />}</dd>
      <dt>Designation</dt><dd><Detail value={c.designation} add="Add designation" edit={edit} /></dd>
      <dt>Phone</dt><dd><Detail value={c.phone} show={<a className={styles.fill} href={`tel:${c.phone}`}>{c.phone}</a>} add="Add phone" edit={edit} /></dd>
      <dt>E-mail</dt><dd><Detail value={c.email} show={<a className={styles.fill} href={`mailto:${c.email}`}>{c.email}</a>} add="Add e-mail" edit={edit} /></dd>
      <dt>City</dt><dd><Detail value={c.city} add="Add city" edit={edit} /></dd>
      <CustomFacts type={ctype} custom={c.custom} />
      <dt>About</dt><dd className={records.pre}><Detail value={c.notes} add={talent ? "Rates, availability…" : "A line about them"} edit={edit} /></dd>
      <dt>Source</dt><dd className={styles.muted}>{SOURCES[c.source ?? ""] ?? c.source ?? "Not recorded"}{c.locked.length ? " · edited in Pulse" : ""}</dd>
    </dl>
  </Panel>;
  const noteList = (notes: More["notes"], viewer?: string | null, any?: boolean, limit?: number) => (notes ?? []).slice(0, limit).map((n) => <li key={n.id} className={css.note}>
    <p>{n.body}</p><small>{n.author ?? "Someone"} · {ago(n.at)}{n.authorId === viewer || any ? <RemoveNote id={n.id} /> : null}</small></li>);

  return (
    <Page fit>
      <ProfileHeader name={c.name} id={c.id} photoAt={c.photoAt} back={{ href: "/contacts", label: "Contacts" }}
        picker={c.canPhoto ? <PhotoControls personId={c.id} hasPhoto={!!c.photoAt} name={c.name} /> : null}
        badges={<>{c.contactType ? <TypeBadge types={types} entity="contact" value={c.contactType} /> : <Badge>Type not set</Badge>}
          {c.typeStatus && c.typeStatus !== "confirmed" ? <Badge tone="warning">{TYPE_STATUS[c.typeStatus] ?? "Type to confirm"}{c.confidence != null ? ` · ${Math.round(c.confidence * 100)}% sure` : ""}</Badge> : null}</>}
        subtitle={[c.designation, primary && (primary.companyName ?? primary.name) !== c.name ? primary.companyName ?? primary.name : null].filter(Boolean).join(" · ") || undefined}
        chips={[
          primary ? { icon: <Building2 size={13} aria-hidden="true" />, value: primary.name, href: `/clients/${primary.id}`, title: "Client" } : null,
          c.clients.length > 1 ? { value: `+${c.clients.length - 1} more`, href: `${base}#clients` } : null,
          c.projects.length ? { icon: <FolderSearch size={13} aria-hidden="true" />, value: plural(c.projects.length, "project"), href: `${base}?tab=projects` } : null,
          c.city ? { icon: <MapPin size={13} aria-hidden="true" />, value: c.city } : null,
          c.phone ? { icon: <Phone size={13} aria-hidden="true" />, value: c.phone, href: `tel:${c.phone}` } : null,
          c.email ? { icon: <Mail size={13} aria-hidden="true" />, value: c.email, href: `mailto:${c.email}` } : null,
        ]}
        actions={<>{c.phone ? <a className={styles.btn} href={`https://wa.me/${c.phone.replace(/[^\d]/g, "").replace(/^0+/, "").replace(/^(\d{10})$/, "91$1")}`} target="_blank" rel="noreferrer">WhatsApp</a> : null}
          {edit ? <><Link className={styles.btn} href={`/stewardship/contact/${c.id}`}>Correct data & links</Link><RecordForm {...edit} label="Edit" variant="primary" note={EDIT_NOTE} /></> : <SuggestCorrection entity="contact" id={c.id} name={c.name} />}</>} />
      <QueryTabs base={base} current={tab} items={tabs} />

      {talent && tab === "overview" ? <TalentOverview t={talent} details={details} /> : null}
      {talent && tab === "shoots" ? <TalentShoots t={talent} /> : null}
      {talent && tab === "media" ? <TalentMedia t={talent} /> : null}

      {!talent && tab === "overview" ? (
        <div className={records.profileGrid} data-grow="" data-enter="">
          {details}
          <Panel fill title="Clients and projects" sub={c.clients.length || c.projects.length ? `${plural(c.clients.length, "client")} · ${plural(c.projects.length, "project")}` : undefined} action={c.projects.length ? { href: `${base}?tab=projects`, label: "All projects" } : undefined}>
            {c.clients.length ? <ul className={styles.list} id="clients">{c.clients.map((x) => (
              <li key={x.id} className={styles.row}><Avatar name={x.name} shape="square" size={32} />
                <div className={styles.rowMain}><Link href={`/clients/${x.id}`} className={styles.rowTitle}>{x.name}</Link>
                  <span className={styles.rowMeta}><span>{typeLabel(types, "client", x.clientType)}</span>{x.companyName && x.companyName !== x.name ? <span>{x.companyName}</span> : null}</span></div>
                <span className={styles.rowEnd}>{x.primary ? <Badge tone="accent">Primary contact</Badge> : null}</span></li>))}</ul> : null}
            {c.projects.length ? <ul className={styles.list}>{c.projects.slice(0, 8).map((p) => (
              <li key={p.projectId} className={styles.row}><div className={styles.rowMain}><Link href={`/projects/${p.projectId}`} className={styles.rowTitle} title={p.folderName}>{p.title}</Link>
                <span className={styles.rowMeta}>{[c.clients.length !== 1 ? p.clientName : null, p.location, p.startMonth ? month(p.startMonth) : null, plural(p.total, "delivery", "deliveries")].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}</span></div>
                <span className={styles.rowEnd}><StageBadge stage={p.stage} /></span></li>))}</ul> : null}
            {!c.clients.length && !c.projects.length ? <Empty icon={Building2} first title="Not linked to a client or project yet" text={c.canEdit ? "Link one from the suggestions, or add this contact from a client’s Contacts tab." : "An admin links contacts to clients and projects."} /> : null}
          </Panel>
          <div className={css.side}>
            {suggestions.suggestions?.length ? <Panel title="Pulse found" sub="From Drive files and e-mail domains">
              <ul className={css.found}>{suggestions.suggestions.slice(0, 5).map((s) => <li key={`${s.kind}:${s.id}`}>
                <span><Link href={`/${s.kind === "project" ? "projects" : "clients"}/${s.id}`}><b>{s.name}</b></Link><small>{s.why}{s.score < 0.6 ? " · a guess" : ""}</small></span>
                {suggestions.canLink ? <LinkSuggestion contactId={c.id} kind={s.kind} targetId={s.id} name={s.name} /> : null}</li>)}</ul>
            </Panel> : null}
            <Panel title="Notes" sub={extra.notes?.length ? plural(extra.notes.length, "note") : undefined} action={extra.notes?.length ? { href: `${base}?tab=timeline`, label: "Timeline" } : undefined}>
              <div className={css.notesBody}>
                <NoteComposer contactId={c.id} name={c.name} compact />
                {extra.notes?.length ? <ul className={css.notes}>{noteList(extra.notes, extra.viewer, extra.canRemoveAny, 3)}</ul> : <p className={css.quiet}><NotebookPen size={14} aria-hidden="true" />No notes yet. What did you last talk about?</p>}
              </div>
            </Panel>
          </div>
        </div>
      ) : null}

      {tab === "projects" ? (
        <Panel fill primary unit="engagements" title="Projects" sub={`${plural(c.projects.length, "engagement")} · ${plural(groupProjects(c.projects).length, "distinct project")}`} tools={c.projects.length ? <Why detail="Projects where this person is a named contact, every project of the clients they belong to, and (for models) the shoots they were in. Newest first; folders for the same development are grouped as one repeat project." /> : undefined}>
          {c.projects.length ? <ProjectsTable projects={c.projects} showClient={c.clients.length !== 1} /> : <Empty icon={FolderSearch} first title="No projects yet" text="Projects appear when this person is a contact on a project or on its client." />}
        </Panel>
      ) : null}

      {tab === "deliveries" ? (
        <Panel fill primary unit="deliveries" title="What we delivered" sub={part.deliveries?.length ? `Latest ${part.deliveries.length} on their projects` : undefined}>
          {part.byMonth?.length ? <div className={css.months} aria-label="Deliveries per month, last 12 months">{part.byMonth.map((m) => { const max = Math.max(...part.byMonth!.map((x) => x.n)); return <span key={m.month} title={`${month(m.month + "-01")}: ${m.n}`}><i style={{ height: `${Math.max(6, Math.round((m.n / max) * 100))}%` }} /><small>{month(m.month + "-01").slice(0, 3)}</small></span>; })}</div> : null}
          {part.deliveries?.length ? <DeliveryFeed items={part.deliveries} today={today()} /> : <Empty icon={Video} first title="Nothing delivered yet" text="Videos and photos delivered on this contact’s projects appear here, newest first." />}
        </Panel>
      ) : null}

      {tab === "conversations" ? (
        <div className={records.halves} data-grow="" data-enter="">
          <Panel fill title="Team chats" sub={part.query ? `Messages that name ${part.query}` : undefined}>
            {part.messages?.length ? <ul className={css.chats}>{part.messages.map((m) => <li key={m.id}><Link href={`/chats?channel=${m.channelId}&message=${m.id}`}>
              <span className={css.mailTop}><b>{m.channel}</b><time dateTime={m.at}>{ago(m.at)}</time></span><small>{m.author ? `${m.author}: ` : ""}{m.body}</small></Link></li>)}</ul>
              : <Empty icon={MessagesSquare} first title="No team chat names them yet" text="Messages in your chats that mention this contact by name show here." />}
          </Panel>
          <Panel fill title="Your mail" sub={c.email ? `With ${c.email}` : "Their full name, in your mailbox"}><div className={css.mailBody}><MailWith email={c.email} name={c.name.replace(/^(mr|mrs|ms|dr)\.?\s+/i, "")} /></div></Panel>
        </div>
      ) : null}

      {tab === "files" ? (
        <Panel fill primary unit="files" title="Files" sub="Documents in their projects’ Drive folders, and any Drive file that names them">
          {part.files?.length ? <ul className={styles.list}>{part.files.map((f) => <li key={f.fileId} className={styles.row}>
            <span className={styles.rowIcon} aria-hidden="true"><FileText size={13} /></span>
            <div className={styles.rowMain}><a className={styles.rowTitle} href={`https://drive.google.com/file/d/${encodeURIComponent(f.fileId)}/view`} target="_blank" rel="noreferrer" title={f.path}>{f.name}</a>
              <span className={styles.rowMeta}>{[f.projectName, f.modifiedAt ? `changed ${ago(f.modifiedAt)}` : null, f.namesThem ? `names ${first}` : null].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}</span></div></li>)}</ul>
            : <Empty icon={FileText} first title="No files found" text="Documents in their projects’ Drive folders, and files that name them, appear here once Drive is indexed." />}
        </Panel>
      ) : null}

      {tab === "money" ? (
        <Panel fill primary unit="invoices" title="Money" sub={part.money ? "Invoices to their clients, from finance and ERP" : undefined}>
          {!part.money ? <Empty icon={Lock} first title="For leadership with finance access" text="Invoices and payments are visible to the people who hold the finance permission." />
            : part.money.invoices.length ? <table className={styles.table}><thead><tr><th>Invoice</th><th>Client</th><th className={styles.right}>Total</th><th className={styles.right}>Due</th><th>Status</th></tr></thead>
              <tbody>{part.money.invoices.map((i) => <tr key={`${i.source}:${i.number}:${i.date}`}><td>{i.source === "erp" && i.id ? <Link href={`/erp/documents/${i.id}`}>{i.number}</Link> : i.number}<span className={styles.cellSub}>{i.date ? dayYear(i.date) : ""}{i.source === "erp" ? " · ERP" : ""}</span></td>
                <td><Link href={`/clients/${i.clientId}`}>{i.client}</Link></td><td className={`${styles.right} ${styles.num}`}>{part.money!.amounts ? inr(i.total) : "Hidden"}</td><td className={`${styles.right} ${styles.num}`}>{part.money!.amounts ? inr(i.due) : "Hidden"}</td>
                <td><Badge tone={i.status === "paid" ? "success" : i.status === "open" || i.status === "issued" ? "warning" : "neutral"}>{i.status}</Badge></td></tr>)}</tbody></table>
              : <Empty icon={IndianRupee} first title="No invoices to their clients yet" text="Invoices appear when finance matches an invoice party to one of this contact’s clients." />}
        </Panel>
      ) : null}

      {tab === "timeline" ? (
        <div className={records.halves} data-grow="" data-enter="">
          <Panel fill title="Notes" sub={part.notes?.length ? count(part.notes.length) : undefined}>
            <div className={css.notesBody}><NoteComposer contactId={c.id} name={c.name} />
              {part.notes?.length ? <ul className={css.notes}>{noteList(part.notes, part.viewer, part.canRemoveAny)}</ul> : <p className={css.quiet}><NotebookPen size={14} aria-hidden="true" />No notes yet.</p>}</div>
          </Panel>
          <Panel fill title="Timeline" sub="Projects, deliveries and changes, newest first">
            {part.events?.length ? <ol className={css.timeline}>{part.events.map((e, i) => <li key={i} data-kind={e.kind}>
              <span className={css.dot} aria-hidden="true">{e.kind === "project" ? <FolderSearch size={11} /> : e.kind === "delivery" ? <Video size={11} /> : e.kind === "change" ? <HistoryIcon size={11} /> : <Sparkles size={11} />}</span>
              <span>{e.kind !== "change" && e.ref ? <Link href={`/projects/${e.ref}`}>{e.title}</Link> : e.title}<small>{EVENT[e.kind] ?? "Note"} · {e.kind === "project" ? month(e.at.slice(0, 10)) : dayYear(e.at)}</small></span></li>)}</ol>
              : <Empty icon={HistoryIcon} first title="Nothing yet" text="Projects, deliveries and edits appear here as they happen." />}
          </Panel>
        </div>
      ) : null}
    </Page>
  );
}
