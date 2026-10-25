import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AlertTriangle, CircleDot, Clock, FileText, Phone, Receipt, type LucideIcon } from "lucide-react";
import { api, type Me } from "../lib/api";
import { count, day, time } from "../lib/format";
import { navFor, roleLabelFor } from "../lib/nav";
import { RetryButton } from "../retry-button";
import { Badge, Empty, Page, PageHeader, Panel, Skeleton } from "../ui";
import { AllModules } from "./sales-modules";
import css from "./sales-home.module.css";

/** EST-1241: the sales home, for a person whose role the organisation's admin gave it (Settings → Modules → Screens and
 *  menu). A greeting, then urgent tasks, today's calls and recent quotations, each loaded on its own (one failing
 *  section says so with "Try again" and the rest still show), then All modules: the same permission-filtered list as
 *  the rail. Every row opens its record; empty sections say so, never with sample rows. */

type Task = { id: string; title: string; status: string; priority: "urgent" | "high" | "normal"; dueOn: string | null; overdue: boolean };
type Call = { id: string; title: string; kind: "quotation" | "enquiry"; status: string; dueOn: string; at: string | null; overdue: boolean };
type Quote = { id: string; number: string | null; status: string; total: number; buyer: string | null; updatedAt: string; ownerApprovalNeeded: boolean };
type Summary = { eligible: boolean; person: { id: string; name: string }; today: string; greeting: "morning" | "afternoon" | "evening";
  urgent?: { total: number; items: Task[] }; calls?: { total: number; items: Call[] }; quotes?: { canOpenErp: boolean; items: Quote[] } };
type Read = { data?: Summary; error?: string };

const read = (section: "urgent" | "calls" | "quotes") => api<Summary>(`sales-home?section=${section}`) as Promise<Read>;
const STATUS: Record<string, string> = { draft: "Draft", issued: "Issued", sent: "Sent", part_paid: "Part paid", paid: "Paid", accepted: "Accepted", declined: "Declined", converted: "Converted" };

export function SalesHome({ me, top, hasUpdates = false }: { me: Me; top?: ReactNode; hasUpdates?: boolean }) {
  // The three reads start together; each section waits only for its own.
  const urgent = read("urgent"), calls = read("calls"), quotes = read("quotes");
  const { rename } = navFor(me, hasUpdates);
  return (
    <Page>
      <Suspense fallback={<PageHeader title={`Hello, ${first(me.name)}`} />}><Greeting name={me.name} read={urgent} /></Suspense>
      {top}
      <div className={css.grid}>
        <Section title="Urgent tasks" read={urgent}>{(s) => <UrgentList s={s} />}</Section>
        <Section title="Today's calls" read={calls}>{(s) => <CallList s={s} />}</Section>
        <Section title="Recent quotations" read={quotes}>{(s) => <QuoteList s={s} />}</Section>
        <Panel title="All modules" sub="Everything else you can open" className={css.wide}>
          <AllModules roleLabel={roleLabelFor(me)} modulesOff={me.modules?.off} rename={rename} />
        </Panel>
      </div>
    </Page>
  );
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

async function Greeting({ name, read }: { name: string; read: Promise<Read> }) {
  const r = await read;
  return <PageHeader title={r.data ? `Good ${r.data.greeting}, ${first(name)}` : `Hello, ${first(name)}`} context={r.data ? [day(r.data.today)] : undefined} />;
}

function Section({ title, read, children }: { title: string; read: Promise<Read>; children: (s: Summary) => ReactNode }) {
  return <Suspense fallback={<Panel title={title}><ul className={css.rows} aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className={css.skeleton}><Skeleton width="60%" /><Skeleton width={64} /></li>)}</ul></Panel>}>
    <Loaded title={title} read={read}>{children}</Loaded>
  </Suspense>;
}

async function Loaded({ title, read, children }: { title: string; read: Promise<Read>; children: (s: Summary) => ReactNode }) {
  const r = await read;
  if (!r.data) return <Panel title={title}><div className={css.failed}><p>{title} could not be loaded.{r.error ? ` ${r.error}` : ""}</p><RetryButton /></div></Panel>;
  return <>{children(r.data)}</>;
}

function Row({ href, Icon, state, title, detail, badge }: { href: string | null; Icon: LucideIcon; state: string; title: string; detail: string; badge?: ReactNode }) {
  const inner = <><Icon size={16} aria-hidden="true" /><span className={css.main}><b>{title}</b><small>{detail}</small></span>{badge ?? <span />}</>;
  return <li>{href ? <Link href={href} className={css.row} data-state={state}>{inner}</Link> : <div className={css.row} data-state={state}>{inner}</div>}</li>;
}

const more = (total: number, shown: number, href: string, what: string) => total > shown
  ? <p className={css.more}><Link href={href}>{`${count(total - shown)} more ${what}`}</Link></p> : null;

function UrgentList({ s }: { s: Summary }) {
  const u = s.urgent ?? { total: 0, items: [] };
  return <Panel title="Urgent tasks" sub={u.total ? `${count(u.total)} need you` : undefined}>
    {u.items.length ? <><ul className={css.rows}>{u.items.map((t) => <Row key={t.id} href={`/tasks/${t.id}`} title={t.title}
      Icon={t.overdue ? AlertTriangle : t.dueOn === s.today ? Clock : CircleDot} state={t.overdue ? "overdue" : t.dueOn === s.today ? "today" : "upcoming"}
      detail={t.overdue && t.dueOn ? `Overdue since ${day(t.dueOn)}` : t.dueOn === s.today ? "Due today" : t.dueOn ? `Due ${day(t.dueOn)}` : "No due date"}
      badge={t.priority !== "normal" ? <Badge tone={t.priority === "urgent" ? "danger" : "warning"}>{t.priority === "urgent" ? "Urgent" : "High"}</Badge> : undefined} />)}</ul>
      {more(u.total, u.items.length, "/tasks", "tasks")}</>
      : <Empty compact icon={CircleDot} title="No urgent tasks" text="Nothing of yours is overdue, due today or marked urgent." />}
  </Panel>;
}

function CallList({ s }: { s: Summary }) {
  const c = s.calls ?? { total: 0, items: [] };
  return <Panel title="Today's calls" sub={c.total ? `${count(c.total)} to make` : undefined}>
    {c.items.length ? <><ul className={css.rows}>{c.items.map((k) => <Row key={k.id} href={`/tasks/${k.id}`} title={k.title} Icon={Phone}
      state={k.overdue ? "overdue" : "today"}
      detail={`${k.kind === "quotation" ? "Quotation follow-up" : "Enquiry follow-up"} · ${k.overdue ? `missed ${day(k.dueOn)}` : k.at ? time(k.at) : "today"}`} />)}</ul>
      {more(c.total, c.items.length, "/tasks", "calls")}</>
      : <Empty compact icon={Phone} title="No calls today" text="Follow-ups on your quotations and enquiries appear here on the day they are due." />}
  </Panel>;
}

function QuoteList({ s }: { s: Summary }) {
  const q = s.quotes ?? { canOpenErp: false, items: [] };
  return <Panel title="Recent quotations" sub={q.items.length ? "Your five most recent" : undefined}>
    {q.items.length ? <ul className={css.rows}>{q.items.map((d) => <Row key={d.id} href={q.canOpenErp ? `/erp/documents/${d.id}` : null}
      Icon={d.status === "draft" ? FileText : Receipt} state={d.ownerApprovalNeeded ? "today" : "upcoming"}
      title={`${d.number ?? "Draft quotation"}${d.buyer ? ` · ${d.buyer}` : ""}`}
      detail={`₹${count(Math.round(d.total))} · updated ${day(d.updatedAt)}`}
      badge={d.ownerApprovalNeeded ? <Badge tone="warning">Owner approval needed</Badge> : <Badge>{STATUS[d.status] ?? d.status}</Badge>} />)}</ul>
      : <Empty compact icon={Receipt} title="No quotations yet" text="Quotations you make or send appear here." />}
  </Panel>;
}
