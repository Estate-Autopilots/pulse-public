import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, BookOpen, Boxes, CalendarClock, FileSignature, FileText, Hourglass, PackageOpen, Plus, ReceiptText, Send, Sparkles, Stamp } from "lucide-react";
import { formatDate } from "@pulse/invoice-doc/gst";
import { api } from "../lib/api";
import { Message, Page, PageHeader, styles } from "../ui";
import { Calm, CalmGrid, Card, EmptyState, Notice, PRIMARY, SectionHeader, StartWith, StatTile, StatTiles, StripeList, StripeRow, type Pick } from "../components/calm";
import { ErpNav } from "./nav";
import { DocStripe, rupees } from "./parts";
import { docNumber } from "./documents/chain";
import { TYPE_LABEL } from "./nav";
import type { Doc, Overview } from "./types";
import home from "./home.module.css";

export const metadata = { title: "Billing" };

// BILLING (18 Oct 2026): the Billing home. Big buttons for what people come to do, then one tray of what waits for
// someone (drafts to approve, invoices due, overdue ones), the key numbers, and the recent documents one line each.
// BILLING-WL (owner, 4 Nov 2026: "make the whole billing UI clean and intuitive", like Work → My day): four quiet stat
// tiles, a numbered "Start with" of the few things that move money today (a quotation sent for your approval, an
// approved one to send, an overdue invoice to chase), one obvious "New quotation", the recent documents as cards with
// a stripe in their state's colour, and a quiet right rail (invoices due from packages, low stock, the books).
// UX-BILLING (5 Nov 2026): built from the shared My day pieces (components/calm), as every Billing screen now is.
type Step = { key: string; title: string; sub: string; href: string; tone: "danger" | "warning" | "accent" | "success" | "neutral"; icon: ReactNode };
const who = (d: Doc) => d.buyer?.name || "no client yet";

export default async function Erp() {
  const r = await api<Overview>("erp");
  if (!r.data) return <Message text={r.error ?? "Billing is unavailable"} />;
  const d = r.data, k = d.kpis;
  const company = d.settings.company;
  const ready = !!(company.legalName && company.gstin);
  // KAZUK-FLOW (G2): with no approval (approvalMode none) nothing here asks anyone to approve; G1: a salesperson's seat
  // starts quotations only (an invoice is made from their accepted quotation) and never sees settings.
  const free = d.approvalMode === "none", own = !!d.ownOnly;
  // The few steps that move money today, most urgent first; each opens the one document (or list) it is about.
  const steps: Step[] = [
    ...(d.forMe ?? []).map((x) => ({ key: `a${x.id}`, title: `Approve the ${TYPE_LABEL[x.docType].toLowerCase()} for ${who(x)}`, tone: "warning" as const, href: `/erp/documents/${x.id}`,
      sub: `${x.approvalAskedByName ?? "A colleague"} asked${x.approvalAskedAt ? ` ${formatDate(x.approvalAskedAt.slice(0, 10))}` : ""} · ${rupees(x.total)}`, icon: <Stamp size={15} aria-hidden="true" /> })),
    ...d.overdue.slice(0, 3).map((x) => ({ key: `o${x.id}`, title: `Chase ${docNumber(x)} · ${who(x)}`, tone: "danger" as const, href: `/erp/documents/${x.id}`,
      sub: `${rupees(x.total - x.paid - x.credited)} overdue since ${formatDate(x.dueDate)}`, icon: <AlertTriangle size={15} aria-hidden="true" /> })),
    ...(d.toSend ?? []).slice(0, 3).map((x) => ({ key: `s${x.id}`, title: `Send ${docNumber(x)} to ${who(x)}`, tone: "accent" as const, href: `/erp/documents/${x.id}`,
      sub: `${free ? "Numbered" : "Approved"} ${formatDate(x.issuedAt?.slice(0, 10) ?? x.issueDate)} · ${rupees(x.total)}`, icon: <Send size={15} aria-hidden="true" /> })),
    ...(d.due.length ? [{ key: "due", title: `Invoice ${d.due.length} package milestone${d.due.length === 1 ? "" : "s"}`, tone: "warning" as const, href: "#due",
      sub: `${rupees(d.due.reduce((n, m) => n + m.amount, 0))} due within two weeks`, icon: <CalendarClock size={15} aria-hidden="true" /> }] : []),
    ...(k.drafts && !(d.forMe ?? []).length ? [{ key: "drafts", title: `Finish ${k.drafts} draft${k.drafts === 1 ? "" : "s"}`, tone: "neutral" as const, href: "/erp/documents?view=drafts",
      sub: free ? "Fill them in and send them" : "Fill them in and approve, or send them for approval", icon: <FileText size={15} aria-hidden="true" /> }] : []),
    ...(d.catalog.drafts && !free ? [{ key: "catalog", title: `Approve ${d.catalog.drafts} catalogue item${d.catalog.drafts === 1 ? "" : "s"}`, tone: "neutral" as const, href: "/erp/catalog?view=draft",
      sub: "Drafted from the cost sheet and past invoices", icon: <PackageOpen size={15} aria-hidden="true" /> }] : []),
  ].slice(0, 5);
  const waiting = d.waiting ?? [];
  const picks: Pick[] = steps.map((x) => ({ key: x.key, title: x.title, sub: x.sub, href: x.href, tone: x.tone, icon: x.icon }));
  return <Page>
    <PageHeader title="Billing" context={[`FY ${d.fy}`, d.accountant ? "Accountant · read only" : company.legalName ?? ""]}
      actions={d.canWrite ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/new?type=quotation" {...PRIMARY}><Plus size={14} aria-hidden="true" />New quotation</Link> : undefined} />
    <ErpNav current="overview" inventory={d.settings.inventoryEnabled} own={own} />
    <Calm>
      {!ready && d.canWrite && !own ? <Notice tone="warning" action={<Link className={`${styles.btn} ${styles.btnSmall}`} href="/erp/settings">Open settings</Link>}>Fill in the company profile (legal name, GSTIN, address) before issuing a tax invoice.</Notice> : null}
      <StatTiles label="Money at a glance">
        <StatTile label="Outstanding" value={rupees(k.outstanding)} href="/erp/documents?view=open" />
        <StatTile label="Overdue" value={rupees(k.overdue)} href="/erp/documents?view=overdue" tone={k.overdue ? "bad" : undefined} />
        <StatTile label="Collected this month" value={rupees(k.collected)} tone={k.collected ? "good" : undefined} />
        <StatTile label="Open quotations" value={k.openQuotes} href="/erp/documents?view=quotation" />
      </StatTiles>
      <CalmGrid railLabel="Waiting, due and stock" rail={<>
        {waiting.length ? <Card label="Waiting for approval">
          <SectionHeader icon={<Hourglass size={15} aria-hidden="true" />} title="Waiting for approval" count={waiting.length} />
          <StripeList label="Waiting for approval">{waiting.map((x) => <StripeRow key={x.id} tone="warning" href={`/erp/documents/${x.id}`} title={who(x)} sub={`${rupees(x.total)} · with ${x.approvalToName ?? "the approver"}`} />)}</StripeList>
        </Card> : null}
        <Card label="Invoices due" id="due" className={home.anchor}>
          <SectionHeader icon={<CalendarClock size={15} aria-hidden="true" />} title="Invoices due" hint="next two weeks" />
          {/* UX-BILLING (review): a quiet rail, as My day's: one stripe row per milestone (amber when late) that opens it;
              its draft if there is one, else the project, where it is invoiced or given to a person. */}
          {d.due.length ? <StripeList label="Invoices due">{d.due.map((m) => <StripeRow key={m.id} tone={m.dueOn < d.today ? "warning" : "neutral"}
            href={m.documentId ? `/erp/documents/${m.documentId}` : `/erp/new?type=invoice&project=${m.projectId}`}
            title={`${m.label} · ${m.project ?? m.engagement}`} amount={rupees(m.amount)}
            sub={`${m.dueOn < d.today ? "Late · was due" : "Due"} ${formatDate(m.dueOn)}${m.client ? ` · ${m.client}` : ""}${m.documentId ? " · draft ready" : m.taskId ? " · given to a person" : ""}`} />)}</StripeList>
            : <p className={home.quiet}>Milestones of client packages show here two weeks before they are due.</p>}
        </Card>
        {d.settings.inventoryEnabled ? <Card label="Low stock">
          <SectionHeader icon={<Boxes size={15} aria-hidden="true" />} title="Low stock" count={d.lowStock.length || undefined} action={<Link href="/erp/inventory">Stock</Link>} />
          {d.lowStock.length ? <StripeList label="Low stock">{d.lowStock.slice(0, 6).map((x) => <StripeRow key={x.id} tone="warning" href={`/erp/catalog/${x.id}`} title={x.name} sub={`${x.onHand} ${x.unit} left · reorder at ${x.reorderLevel}`} />)}</StripeList>
            : <p className={home.quiet}>Everything is above its low-stock level.</p>}
        </Card> : null}
        <p className={home.books}><ReceiptText size={14} aria-hidden="true" /> {d.mirror.note}</p>
      </>}>
        <StartWith picks={picks} icon={<Sparkles size={15} aria-hidden="true" />} empty={free ? "Nothing waits for you. Quotations to send and overdue invoices show here."
          : "Nothing waits for you. Quotations sent for your approval, approved ones to send and overdue invoices show here."} />
        {d.canWrite ? <nav className={home.quick} aria-label="Make">
          {own ? <Link className={home.big} href="/erp/documents?view=quotation"><FileSignature size={20} aria-hidden="true" /><span><b>My quotations</b><small>An invoice is made from the accepted one</small></span></Link>
            : <Link className={home.big} href="/erp/new?type=invoice"><ReceiptText size={20} aria-hidden="true" /><span><b>New invoice</b><small>GST tax invoice</small></span></Link>}
          <Link className={home.big} href="/erp/catalog"><BookOpen size={20} aria-hidden="true" /><span><b>Catalogue</b><small>{d.catalog.packages ? `${d.catalog.packages} package${d.catalog.packages === 1 ? "" : "s"} · ` : ""}{d.catalog.items} items</small></span></Link>
          {d.settings.inventoryEnabled ? <Link className={home.big} href="/erp/inventory"><Boxes size={20} aria-hidden="true" /><span><b>Stock</b><small>{d.lowStock.length ? `${d.lowStock.length} low` : "In, counts, serials"}</small></span></Link>
            : <Link className={home.big} href="/erp/documents"><FileText size={20} aria-hidden="true" /><span><b>Documents</b><small>Quotations, invoices, credit notes</small></span></Link>}
        </nav> : null}
        <Card label="Recent documents" flat>
          <SectionHeader icon={<FileText size={15} aria-hidden="true" />} title="Recent" action={<Link href="/erp/documents">All documents</Link>} />
          {d.recent.length ? <StripeList label="Recent documents">{d.recent.map((x) => <DocStripe key={x.id} d={x} today={d.today} free={free} />)}</StripeList>
            : <EmptyState icon={<FileSignature size={18} aria-hidden="true" />} title="No documents yet" text="Start with a quotation: type the customer's name or phone and Pulse finds them in Clients, Contacts or your leads."
              action={d.canWrite ? <Link className={styles.btn} href="/erp/new?type=quotation"><Plus size={14} aria-hidden="true" />New quotation</Link> : undefined} />}
        </Card>
      </CalmGrid>
    </Calm>
  </Page>;
}
