import Link from "next/link";
import { AlertTriangle, BookOpen, CalendarClock, FileText, FileSignature, PackageOpen, Plus, ReceiptText } from "lucide-react";
import { formatDate } from "@pulse/invoice-doc/gst";
import { api } from "../lib/api";
import { Badge, Empty, Kpi, Message, Page, PageHeader, Panel, Tiles, styles } from "../ui";
import { LineList, LineRow } from "../kit/line-row";
import { MilestoneActions } from "./actions";
import { ErpNav } from "./nav";
import { DocLine, rupees } from "./parts";
import type { Overview } from "./types";
import css from "./erp.module.css";
import home from "./home.module.css";

export const metadata = { title: "Billing" };

// BILLING (18 Oct 2026): the Billing home. Big buttons for what people come to do, then one tray of what waits for
// someone (drafts to approve, invoices due, overdue ones), the key numbers, and the recent documents one line each.
export default async function Erp() {
  const r = await api<Overview>("erp");
  if (!r.data) return <Message text={r.error ?? "Billing is unavailable"} />;
  const d = r.data, k = d.kpis;
  const company = d.settings.company;
  const ready = !!(company.legalName && company.gstin);
  const waiting = [
    d.catalog.drafts ? { key: "catalog", title: `${d.catalog.drafts} catalogue item${d.catalog.drafts === 1 ? "" : "s"} to approve`, sub: "Drafted from the cost sheet and past invoices: check, then approve", href: "/erp/catalog?view=draft", icon: <PackageOpen size={17} aria-hidden="true" /> } : null,
    k.drafts ? { key: "drafts", title: `${k.drafts} draft document${k.drafts === 1 ? "" : "s"}`, sub: k.openQuotes ? `${k.openQuotes} quotation${k.openQuotes === 1 ? "" : "s"} waiting for the client's answer` : "Finish and issue them", href: "/erp/documents?view=drafts", icon: <FileText size={17} aria-hidden="true" /> } : null,
    d.due.length ? { key: "due", title: `${d.due.length} invoice${d.due.length === 1 ? "" : "s"} due within two weeks`, sub: "Package milestones not yet invoiced", href: "#due", icon: <CalendarClock size={17} aria-hidden="true" />, amount: rupees(d.due.reduce((n, m) => n + m.amount, 0)) } : null,
    k.overdueCount ? { key: "overdue", title: `${k.overdueCount} overdue invoice${k.overdueCount === 1 ? "" : "s"}`, sub: "Past their due date and not fully paid", href: "/erp/documents?view=overdue", icon: <AlertTriangle size={17} aria-hidden="true" />, amount: rupees(k.overdue), tone: "needed" as const } : null,
    d.settings.inventoryEnabled && d.lowStock.length ? { key: "stock", title: `${d.lowStock.length} item${d.lowStock.length === 1 ? "" : "s"} low on stock`, sub: d.lowStock.slice(0, 3).map((s) => s.name).join(", "), href: "/erp/inventory", icon: <PackageOpen size={17} aria-hidden="true" /> } : null,
  ].filter((x) => x !== null);
  return <Page>
    <PageHeader title="Billing" context={[`FY ${d.fy}`, d.accountant ? "Accountant · read only" : company.legalName ?? ""]}
      actions={d.canWrite ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/new"><Plus size={14} aria-hidden="true" />New document</Link> : undefined} />
    <ErpNav current="overview" inventory={d.settings.inventoryEnabled} />
    <div className={css.body}>
      {!ready && d.canWrite ? <p className={css.warn}>Fill in the company profile (legal name, GSTIN, address) in <Link href="/erp/settings"><b>Billing settings</b></Link> before issuing a tax invoice.</p> : null}
      {d.canWrite ? <nav className={home.quick} aria-label="Make">
        <Link className={home.big} href="/erp/new?type=quotation"><FileSignature size={20} aria-hidden="true" /><span><b>New quotation</b><small>From a project or a package</small></span></Link>
        <Link className={home.big} href="/erp/new?type=invoice"><ReceiptText size={20} aria-hidden="true" /><span><b>New invoice</b><small>GST tax invoice</small></span></Link>
        <Link className={home.big} href="/erp/catalog"><BookOpen size={20} aria-hidden="true" /><span><b>Catalogue</b><small>{d.catalog.packages} packages · {d.catalog.items} services</small></span></Link>
        <Link className={home.big} href="/erp/documents"><FileText size={20} aria-hidden="true" /><span><b>Documents</b><small>Quotations, invoices, credit notes</small></span></Link>
      </nav> : null}
      <section className={home.tray} aria-labelledby="needs-you">
        <h3 id="needs-you" className={home.trayHead}>Needs you{waiting.length ? <span>{waiting.length}</span> : null}</h3>
        {waiting.length ? <LineList label="Waiting">{waiting.map((w) => <LineRow key={w.key} href={w.href} lead={w.icon} title={w.title} sub={w.sub} amount={"amount" in w ? w.amount : undefined} tone={"tone" in w ? w.tone : undefined} />)}</LineList>
          : <p className={home.calm}>Nothing waits for you. New drafts, due invoices and late payments show here.</p>}
      </section>
      <Tiles count={4}>
        <Kpi label="Outstanding" value={rupees(k.outstanding)} note="Issued invoices not yet paid" href="/erp/documents?view=open" />
        <Kpi label="Overdue" value={rupees(k.overdue)} note={`${k.overdueCount} invoice${k.overdueCount === 1 ? "" : "s"} past due`} tone={k.overdue ? "danger" : undefined} href="/erp/documents?view=overdue" />
        <Kpi label="Collected this month" value={rupees(k.collected)} note="Payments recorded, TDS included" />
        <Kpi label={`Invoiced in FY ${d.fy}`} value={rupees(k.invoiced)} note="Issued invoices, with GST" />
      </Tiles>
      <div className={css.grid2}>
        <div id="due" className={home.anchor}>
          <Panel title="Invoices due" sub="Client-package milestones due within two weeks and not yet invoiced">
            {d.due.length ? <ul className={css.rows}>{d.due.map((m) => <li key={m.id}>
              <span className={css.rowMain}>
                <Link className={css.rowLink} href={`/erp/new?project=${m.projectId}`}>{m.project ?? m.engagement} · {m.label}</Link>
                <span className={css.rowSub}>{m.client ?? "No client"} · {m.engagement} · milestone {m.position + 1} · due {formatDate(m.dueOn)}{m.assignee ? ` · ${m.assignee} (${m.taskStatus === "done" ? "done" : "task open"})` : ""}</span>
              </span>
              <span className={css.rowEnd}>
                <span className={css.num}>{rupees(m.amount)}</span>
                {m.dueOn < d.today ? <Badge tone="danger">Late</Badge> : <Badge tone="warning">Due</Badge>}
                {d.canWrite ? <MilestoneActions milestoneId={m.id} documentId={m.documentId} assignees={m.taskId ? [] : d.assignees} dueOn={m.dueOn < d.today ? d.today : m.dueOn} /> : null}
              </span>
            </li>)}</ul> : <Empty icon={CalendarClock} compact title="Nothing due" text="Milestones of client packages appear here two weeks before they are due. Sell a package from New document → a project." />}
          </Panel>
        </div>
        <Panel title="Recent documents" action={{ href: "/erp/documents", label: "All documents" }}>
          {d.recent.length ? <LineList label="Recent documents">{d.recent.map((x) => <DocLine key={x.id} d={x} today={d.today} />)}</LineList>
            : <Empty icon={FileText} compact title="No documents yet" text="Create an invoice, proforma, quotation or credit note from a project: the client, billing contact, GSTIN and package lines fill in." action={d.canWrite ? { href: "/erp/new", label: "New document" } : undefined} />}
        </Panel>
      </div>
      {d.overdue.length ? <Panel title="Overdue invoices" sub="Past their due date, with the balance still open">
        <LineList label="Overdue invoices">{d.overdue.map((x) => <DocLine key={x.id} d={x} today={d.today} />)}</LineList>
      </Panel> : null}
      <p className={home.books}><ReceiptText size={14} aria-hidden="true" /> {d.mirror.note}{d.settings.inventoryEnabled ? "" : " · Stock is off: a service company keeps none (Billing settings)."}</p>
    </div>
  </Page>;
}
