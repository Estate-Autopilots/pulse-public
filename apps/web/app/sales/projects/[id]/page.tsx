import { CheckCircle2, ListTodo, MessagesSquare, ShieldCheck } from "lucide-react";
import { api, vocabulary } from "../../../lib/api";
import { Badge, Message, Page } from "../../../ui";
import { EmptyState as Empty, PageHeader, StatTile, StatTiles, StripeCard as Card } from "../../../components/kit";
import { projectFacts, shortDay, type SoldProjects } from "../../../lib/sold-projects.mjs";
import css from "../../home.module.css";

export const metadata = { title: "Project · Sold by me" };

/** KAZUK-V2 G13 (R42, R55): one sold project, read only: who runs it, how far it is, what was done lately and what is
 *  next. The salesperson (and their Sales Agent's "what's happening with my client's project?") reads it here; nothing
 *  on this page changes a task. */
export default async function SoldProject({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const person = q.person && /^[0-9a-f-]{36}$/.test(q.person) ? q.person : "";
  const [r, words] = await Promise.all([api<SoldProjects>(`sales-projects?${new URLSearchParams(Object.entries({ person, project: id }).filter(([, v]) => v))}`), vocabulary()]);
  const back = { href: `/sales/projects${person ? `?person=${person}` : ""}`, label: "Projects I sold" };
  const p = r.data?.projects[0];
  if (!r.data || !p) return <Page><PageHeader title="Project" back={back} />
    {r.status === 403 || (r.data && !p) ? <Empty icon={ShieldCheck} title="This project was not sold by you" text="You can follow the projects your deals started." action={{ href: "/sales/projects", label: "See mine" }} />
      : <Message text={r.error ?? "This project is unavailable"} />}</Page>;
  const f = projectFacts(p, r.data.today);
  return <Page>
    <PageHeader title={p.client ?? p.name} eyebrow={["Sold by me", "Read only"]} back={back} lede={`${p.client && p.name !== p.client ? `${p.name}. ` : ""}Your delivery team runs it; you can follow it here.`} />
    <div className={css.page}>
      <StatTiles count={4} label="The project now">
        <StatTile label="Work done" value={`${f.percent}%`} note={`${p.tasks.done} of ${p.tasks.total} tasks`} />
        <StatTile label="Late" value={String(p.tasks.overdue)} tone={p.tasks.overdue ? "warning" : undefined} note={p.tasks.overdue ? "Tasks past their day" : "Nothing late"} />
        <StatTile label="Who runs it" value={p.pgs ?? "No one yet"} note={p.pgs ? (p.category ? `${words.lead} · ${p.category.replace(/_/g, " ")}` : words.lead) : "The project head picks soon"} />
        <StatTile label="Renewal" value={p.renewalOn ? shortDay(p.renewalOn) : "—"} note={p.renewalOn ? `${f.renewal.includes("(in") ? f.renewal.slice(f.renewal.indexOf("(") + 1, -1) : "When the signed term ends"}` : "No renewal date yet"} />
      </StatTiles>
      <Card stripe="in" icon={MessagesSquare} title="Status"><div className={css.statusRow}><Badge tone={f.tone}>{f.status}</Badge>
        <span>{p.clientGroup ? "You are in the client group, so you see its updates." : "You are not in a client group for this client yet."}</span></div></Card>
      <div className={css.grid}>
        <Card stripe="in" icon={ListTodo} title="Next up">
          {p.upcoming?.length ? <ul className={css.list}>{p.upcoming.map((t, i) => <li key={i} data-late={t.late ? "" : undefined}><span>{t.title}</span><small>{t.dueOn ? `${t.late ? "Late since" : "Due"} ${shortDay(t.dueOn)}` : "No day yet"}</small></li>)}</ul>
            : <Empty compact icon={ListTodo} title="Nothing open" text="All the work on this project is done." />}
        </Card>
        <Card stripe="in" icon={CheckCircle2} title="Done lately">
          {p.recent?.length ? <ul className={css.list}>{p.recent.map((t, i) => <li key={i}><span>{t.title}</span><small>{shortDay(t.at)}</small></li>)}</ul>
            : <Empty compact icon={CheckCircle2} title="Nothing finished yet" text="Finished work shows here when the team marks it done." />}
        </Card>
      </div>
    </div>
  </Page>;
}
