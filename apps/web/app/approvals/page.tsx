import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { Message, Page, PageHeader } from "../ui";
import { ICONS } from "../projects/pm-shared";
import home from "../projects/pm-home.module.css";
import css from "./approvals.module.css";

/** PM-BUILD-3 (the Mac's screen 05, SPEC v1.1 §5.6): everything that waits for an OK, in two tabs. Team review is the
 *  review queue (the work given to you to accept, with Approve in two taps); Client approval is what your projects sent
 *  for a client's OK and are still waiting on: how long, and "Client late" (amber, never the team's) once the answer
 *  day has passed. Data: GET /api/v0/approvals and /api/v0/tasks/reviews. */
export const metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";
type Client = { id: string; title: string; version: number; round: number; rounds: number; sharedOn: string; due: string; waiting: number; clientLate: number; clientId: string; client: string | null;
  projectId: string | null; project: string | null; color: string; icon: string | null; sharedBy: string | null; owner: string | null; seen: boolean };
type Review = { id: string; title: string; projectId: string | null; projectName: string | null; assigneeId: string | null; assigneeName: string | null; doneAt: string | null; waitedHours: number | null; flags: number };
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export default async function Approvals({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const q = await searchParams; const tab = q.tab === "client" ? "client" : "team";
  const [a, rv] = await Promise.all([api<{ today: string; team: number; client: Client[] }>("approvals"), api<{ rows: Review[] }>("tasks/reviews")]);
  if (a.error || !a.data) return <Message text={a.error ?? "Approvals are unavailable."} />;
  const team = rv.data?.rows.length ?? a.data.team, client = a.data.client;
  return <Page>
    <PageHeader title="Approvals" context={[team ? `${team} waiting for your review` : "Nothing waiting for your review", client.length ? `${client.length} with clients` : null]} />
    <nav className={css.tabs} aria-label="Approvals">
      <Link href="/approvals" aria-current={tab === "team" ? "page" : undefined}>Team review<b>{team}</b></Link>
      <Link href="/approvals?tab=client" aria-current={tab === "client" ? "page" : undefined}>Client approval<b>{client.length}</b></Link>
    </nav>
    {tab === "team" ? rv.data && rv.data.rows.length ? <ul className={css.list} aria-label="Team review">{rv.data.rows.map((x) => { const late = (x.waitedHours ?? 0) >= 48;
      return <li key={x.id} className={css.item} data-plain="">
        <div className={css.main}><b className={css.title}>{x.title.replace(/^[A-Z]{1,2}\d{1,2}[a-z]?\s+/, "")}</b>
          <small>{x.projectName ? <span className={css.tagPlain}>{x.projectName}</span> : null}{x.assigneeName ? <span>{x.projectName ? " · " : ""}from {x.assigneeName}</span> : null}{x.doneAt ? <span> · sent {day(x.doneAt.slice(0, 10))}</span> : null}</small></div>
        <div className={css.end}>{late ? <span className={css.chip} data-tone={(x.waitedHours ?? 0) >= 96 ? "old" : "late"}>Waiting {Math.floor((x.waitedHours ?? 0) / 24)} days</span> : <span className={css.chip} data-tone="turn">Your turn</span>}
          <Link className={css.review} href={`/tasks/${x.id}`}>Review</Link></div>
      </li>; })}</ul>
      : <div className={css.empty}><ShieldCheck size={22} aria-hidden="true" /><b>Nothing waits for your review</b><span>Work people send you to check shows here, oldest first.</span></div>
    : client.length ? <ul className={css.list} aria-label="Client approval">{client.map((x) => { const Icon = ICONS[x.icon ?? ""] ?? ICONS.folder;
      return <li key={x.id} className={`${css.item} ${home.pc}`} data-color={x.color}>
        <span className={home.tile} aria-hidden="true"><Icon size={20} /></span>
        <div className={css.main}><b className={css.title}>{x.title}</b>
          <small>{x.project ? <span className={css.tag}>{x.project}</span> : x.client}<span> · version {x.version}{x.sharedBy ? ` · sent ${day(x.sharedOn)} by ${x.sharedBy}` : ""}</span></small></div>
        <div className={css.end}><span className={css.chip} data-tone={x.clientLate ? "late" : undefined}>{x.clientLate ? `Client late · ${days(x.clientLate)}` : `Waiting on client${x.waiting ? ` · ${days(x.waiting)}` : ""}`}</span>
          {x.seen ? null : <small className={css.due}>Not opened yet</small>}
          <Link className={css.open} href={`/clients/${x.clientId}`}>Open</Link></div>
      </li>; })}</ul>
      : <div className={css.empty}><ShieldCheck size={22} aria-hidden="true" /><b>No client is holding anything up</b><span>Creatives you share with a client for their OK wait here until they answer.</span></div>}
  </Page>;
}
