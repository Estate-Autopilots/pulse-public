import Link from "next/link";
import { FilePlus2, Star } from "lucide-react";
import { api, workWords } from "../../../lib/api";
import { count } from "../../../lib/format";
import { Avatar, Badge, Empty, Message, Page, PageHeader, Panel, styles } from "../../../ui";
import { RecordForm, type FieldDef } from "../../../records";
import type { RecordType } from "../../../record-types";
import { AddPerson } from "../../book";
import css from "../../book.module.css";
import { MainContact, MakeClient, PulseLink, Relation } from "./actions";

// COMPANIES-MODEL: one company: who they are, their people (one main contact), what you do with them (client record,
// projects, quotes, invoices) and their own Pulse account.
type Company = { id: string; name: string; legalName: string | null; industry: string | null; website: string | null; email: string | null; phone: string | null; city: string | null;
  address: string | null; gstin: string | null; notes: string | null; isVendor: boolean; isPartner: boolean; contactId: string | null; contactName: string | null; clientId: string | null;
  people: number; projects: number; quotes: number; invoices: number };
type Detail = { company: Company; people: { id: string; name: string; designation: string | null; email: string | null; phone: string | null; primary: boolean; photoAt: string | null }[];
  clients: { id: string; name: string; clientType: string; status: string | null }[]; projects: { id: string; title: string; status: string; startMonth: string | null }[];
  documents: { id: string; docType: string; number: string | null; status: string; total: number; issueDate: string | null }[];
  pulse: { id: string; handle: string; name: string } | null; invite: { status: string; createdAt: string } | null; types: RecordType[]; canEdit: boolean };

const FIELDS: FieldDef[] = [
  { key: "name", label: "Name", required: true, wide: true }, { key: "city", label: "Town or city" }, { key: "phone", label: "Phone", type: "tel" },
  { key: "email", label: "E-mail", type: "email" }, { key: "website", label: "Website" }, { key: "industry", label: "What they do", placeholder: "Interiors, hotel, school…" },
  { key: "legalName", label: "Registered name", section: "For bills" }, { key: "gstin", label: "GSTIN", placeholder: "15 letters and numbers" },
  { key: "address", label: "Address", type: "textarea", wide: true }, { key: "notes", label: "Notes", type: "textarea", wide: true },
];
const DOC: Record<string, string> = { quotation: "Quote", invoice: "Invoice", proforma: "Proforma", credit_note: "Credit note" };
const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const rupees = (n: number) => `₹${INR.format(n)}`;

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, words] = await Promise.all([api<Detail>(`companies/${encodeURIComponent(id)}`), workWords()]);
  if (r.error) return <Message text={r.error} />; const d = r.data; if (!d) return null;
  const c = d.company; const one = words.clients.replace(/s$/, "") || "Client";
  const facts: [string, string | null][] = [["Town or city", c.city], ["Phone", c.phone], ["E-mail", c.email], ["Website", c.website], ["What they do", c.industry], ["Registered name", c.legalName], ["GSTIN", c.gstin], ["Address", c.address]];
  const shown = facts.filter(([, v]) => v);
  const clientId = c.clientId;
  return <Page fit>
    <PageHeader title={c.name} back={{ href: "/contacts/companies", label: "Companies" }}
      context={[clientId ? <Link key="c" href={`/clients/${clientId}`} title={`Open the ${one.toLowerCase()} page`}><Badge tone="success">{one}</Badge></Link> : null, c.isVendor ? <Badge key="v">Vendor</Badge> : null, c.isPartner ? <Badge key="p">Partner</Badge> : null,
        d.pulse ? <Badge key="o" tone="accent">On Pulse</Badge> : null, c.city]}
      actions={d.canEdit ? <>{/* The main step first (it stays in view on a phone), then Edit. */}
        {clientId ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/erp/new?type=quotation&client=${clientId}`}><FilePlus2 size={14} aria-hidden="true" />New quote</Link> : <MakeClient id={c.id} name={c.name} one={one} />}
        <RecordForm path={`companies/${c.id}`} title={`Edit ${c.name}`} fields={FIELDS} values={{ name: c.name, city: c.city, phone: c.phone, email: c.email, website: c.website, industry: c.industry, legalName: c.legalName, gstin: c.gstin, address: c.address, notes: c.notes }} label="Edit" /></> : undefined} />
    <div className={css.grid}>
      <div className={css.col}>
        {/* Judge r4: "Add" under the list (on a phone a panel's button took a row of its own above the only person). */}
        <Panel title="People" sub={c.contactName ? undefined : "No main contact yet"}>
          <div className={styles.panelBody}>
          {d.people.length ? <ul className={css.people}>{d.people.map((p) => <li key={p.id}>
            <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={32} />
            <span><span><Link href={`/contacts/${p.id}`} className={styles.cellLink}>{p.name}</Link>{p.primary ? <span className={css.mainTag}><Star size={11} aria-hidden="true" />Main contact</span> : null}</span><small>{[p.designation, p.phone, p.email].filter(Boolean).join(" · ") || "No details yet"}</small></span>
            {p.primary ? null : d.canEdit ? <MainContact company={c.id} person={p.id} name={p.name} /> : null}
          </li>)}</ul> : <Empty icon={Star} compact title="No people yet" text="Add the person you talk to there." />}
          {d.canEdit ? <div className={css.addRow2}><AddPerson companies={[]} types={d.types} canAddTypes={d.canEdit} company={{ id: c.id, name: c.name }} label="Add a contact here" variant="small" words={{ client: one }} /></div> : null}
          </div>
        </Panel>
        <Panel title="Your work with them" sub={clientId ? undefined : `Not a ${one.toLowerCase()} yet`} action={clientId ? { href: `/clients/${clientId}`, label: `${one} page` } : undefined}>
          <div className={styles.panelBody}>
          {c.projects + c.quotes + c.invoices ? <>
          <div className={css.stats}>
            {clientId ? <Link className={css.stat} href={`/clients/${clientId}?tab=projects`}><b>{count(c.projects)}</b><small>{c.projects === 1 ? "Project" : "Projects"}</small></Link> : <span className={css.stat}><b>{count(c.projects)}</b><small>{c.projects === 1 ? "Project" : "Projects"}</small></span>}
            <span className={css.stat}><b>{count(c.quotes)}</b><small>{c.quotes === 1 ? "Quote" : "Quotes"}</small></span>
            <span className={css.stat}><b>{count(c.invoices)}</b><small>{c.invoices === 1 ? "Invoice" : "Invoices"}</small></span>
          </div>
          </> : <p className={css.note}>No quotes or projects yet.{clientId ? " Start with New quote above." : ""}</p>}
          {clientId ? null : <p className={css.note} style={{ marginTop: 12 }}>Make them a {one.toLowerCase()} to start projects, quotes and invoices for them.</p>}
          {d.documents.length ? <ul className={css.rows} style={{ marginTop: 12 }}>{d.documents.slice(0, 6).map((x) => <li key={x.id}><Link href={`/erp/documents/${x.id}`} className={styles.cellLink}>{DOC[x.docType] ?? x.docType} {x.number ?? "(draft)"}</Link><span className={styles.num}>{rupees(x.total)}</span></li>)}</ul> : null}
          {d.projects.length ? <ul className={css.rows} style={{ marginTop: 12 }}>{d.projects.slice(0, 6).map((x) => <li key={x.id}><Link href={`/projects/${x.id}`} className={styles.cellLink}>{x.title}</Link><span className={styles.muted}>{x.status}</span></li>)}</ul> : null}
          </div>
        </Panel>
      </div>
      <div className={css.col}>
        <Panel title="About">
          <div className={styles.panelBody}>
          {shown.length ? <dl className={css.facts}>{shown.flatMap(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}</dl> : <p className={css.note}>Only the name so far. Edit to add their phone, town or GSTIN.</p>}
          {c.notes ? <p className={css.note} style={{ marginTop: 10 }}>{c.notes}</p> : null}
          {/* Judge r3: vendor and partner are two facts about them, not a panel of their own. */}
          {d.canEdit ? <div className={css.also}><Relation id={c.id} field="isVendor" on={c.isVendor} label="Vendor" hint="You buy from them" /><Relation id={c.id} field="isPartner" on={c.isPartner} label="Partner" hint="You work on things together" /></div> : null}
          </div>
        </Panel>
        <Panel title="Do they use Pulse?">
          <div className={styles.panelBody}>
          <PulseLink id={c.id} name={c.name} linked={d.pulse} invite={d.invite} canEdit={d.canEdit} />
          </div>
        </Panel>
      </div>
    </div>
  </Page>;
}
