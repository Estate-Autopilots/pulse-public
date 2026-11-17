import Link from "next/link";
import { MessagesSquare, ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { Badge, Message, Page } from "../../ui";
import { EmptyState as Empty, PageHeader } from "../../components/kit";
import { EmptyState as GameEmpty, ProgressRing } from "../../kit/game";
import { projectFacts, type SoldProjects } from "../../lib/sold-projects.mjs";
import css from "../home.module.css";

export const metadata = { title: "Projects I sold" };

/** KAZUK-V2 G13 (Kazuk, 6 Nov 2026, R42): "Sold by me": the projects a salesperson's paid deals started or joined, read
 *  only. The PGS, how far the work is, what is next and the renewal date; nothing here changes delivery. The Sales Head,
 *  leadership and Finance may open anyone's (?person=). Data: GET /api/v0/sales-projects (pulse.sales_sold_projects). */
export default async function SoldProjects({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const person = q.person && /^[0-9a-f-]{36}$/.test(q.person) ? q.person : "";
  const r = await api<SoldProjects>(`sales-projects${person ? `?person=${person}` : ""}`);
  const back = { href: `/sales${person ? `?person=${person}` : ""}`, label: "My sales" };
  if (!r.data) return <Page><PageHeader title="Projects I sold" back={back} />
    {r.status === 403 ? <Empty icon={ShieldCheck} title="Another person's projects are for the Sales Head" text="You can see the projects you sold." action={{ href: "/sales/projects", label: "See mine" }} />
      : <Message text={r.error ?? "Projects are unavailable"} />}</Page>;
  const d = r.data, self = d.person.self;
  return <Page>
    <PageHeader title={self ? "Projects I sold" : "Projects they sold"} eyebrow={["Sales", "Sold by me", "Read only"]} back={back}
      lede="How the work is going for the clients you sold to. You can see it, not change it." />
    {d.projects.length ? <ul className={css.projects} aria-label="Projects sold">{d.projects.map((p) => {
      const f = projectFacts(p, d.today);
      return <li key={p.id} className={css.project}>
        <div className={css.projectTop}>
          <ProgressRing value={f.share} size={60} stroke={6} tone={f.percent === 100 ? "good" : undefined} label={`${p.tasks.done} of ${p.tasks.total} tasks done`}><span className={css.ringWords}><b>{p.tasks.done}/{p.tasks.total}</b><small>done</small></span></ProgressRing>
          <div><Link href={`/sales/projects/${p.id}${person ? `?person=${person}` : ""}`}>{p.client ?? p.name}</Link>{p.client && p.name !== p.client ? <small>{p.name}</small> : null}</div>
        </div>
        <p className={css.facts}>
          <Badge tone={f.tone}>{f.status}</Badge>
          <span data-warn={p.pgs ? undefined : ""}>{p.pgs ? `Run by ${p.pgs}` : "No one runs it yet"}</span>
          <span>{p.tasks.done} of {p.tasks.total} task{p.tasks.total === 1 ? "" : "s"} done{p.tasks.overdue ? ` · ${p.tasks.overdue} late` : ""}</span>
          <span>{p.renewalOn ? `Renews ${f.renewal}` : "No renewal date yet"}</span>
        </p>
        <div className={css.rows}>
          <p>{p.next ? <><b>Next:</b> {p.next.title}{p.next.dueOn ? <><br />Due {f.nextDue}</> : null}</> : "Nothing open right now"}</p>
          <p><MessagesSquare size={13} aria-hidden="true" /> {p.clientGroup ? "You are in the client group" : "No client group with you yet"}</p>
        </div>
        <Link className={css.openLink} href={`/sales/projects/${p.id}${person ? `?person=${person}` : ""}`}>Open project ›</Link>
      </li>;
    })}</ul> : <GameEmpty art="nothing" title="No projects yet" text="When a deal of yours is paid, its project shows here so you can follow the work." action={{ href: "/sales", label: "Back to My sales" }} />}
  </Page>;
}
