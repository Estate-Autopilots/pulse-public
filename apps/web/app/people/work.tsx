import Link from "next/link";
import { CircleHelp, FileText, FolderKanban, Inbox, ListTodo, Receipt } from "lucide-react";
import { dayYear, plural } from "../lib/format";
import { Badge, Panel, styles } from "../ui";
import { LinkDecision } from "./work-actions";
import css from "./work.module.css";

// PEOPLE-LIVE: the person's work from evidence links (GET people/:id/work). Suggested items say so, with their basis and
// confidence; accepted ones carry their receipt and can be undone by HR or leadership. Work shows tasks, never pay.
export type LinkState = { linkId?: string; status: "owned" | "credited" | "accepted" | "suggested"; auto?: boolean; confidence?: number; basis?: string; groupKey?: string; receiptId?: string | null };
export type WorkTask = { id: string; title: string; status: string | null; projectId: string | null; projectName: string | null; clientName: string | null; day: string | null; period: string | null; role: string | null; hours: number | null; link: LinkState };
export type WorkProject = { projectId: string; title: string; projectStatus: string; clientName: string | null; pod: string | null; accepted: boolean; active: boolean; confidence: number; roles: string[]; from: string | null; to: string | null; tasks: number; deliveries: number; evidence: { basis: string; status: string; linkId: string | null; groupKey: string | null; auto?: boolean }[] };
export type WorkItem = LinkState & { fileId: string; title?: string; fileName?: string; kind?: string; deliveredAt?: string | null; modifiedOn?: string | null; mime?: string | null; role?: string | null; projectId: string | null; projectName: string | null; uploaderAccount?: string | null; source?: string; groupLabel?: string };
export type PersonWork = { can: { view: boolean; review: boolean }; person: { id: string; name: string; pod?: string | null; outcome?: boolean };
  summary?: { workingOn: { kind: string; tasks: number }[]; workingOnSuggested: boolean; clients: string[]; activeProjects: number; creditedDeliveries: number; trend: { month: string; tasks: number; suggested: number; deliveries: number }[] };
  tasks?: WorkTask[]; projects?: WorkProject[]; deliveries?: WorkItem[]; documents?: WorkItem[]; pods?: (LinkState & { pod: string; groupLabel: string })[];
  missing?: Partial<Record<"tasks" | "projects" | "deliveries" | "documents" | "pod", string>>; counts?: { tasks: number; projects: number; deliveries: number; documents: number; suggested: number } };

const STATUS: Record<string, string> = { done: "Done", accepted: "Accepted", in_review: "In review", in_progress: "Doing", open: "To do", blocked: "Blocked", unknown: "State not recorded" };
const pct = (n?: number) => n === undefined || n === null ? "" : `${Math.round(Number(n) * 100)}%`;
const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
const span = (from: string | null, to: string | null) => !from && !to ? null : from && to && from.slice(0, 7) !== to.slice(0, 7) ? `${dayYear(from)} – ${dayYear(to)}` : dayYear((to ?? from)!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line when something is truly unknown: what is missing and how to fix it. Never an empty panel. */
export function Missing({ text }: { text?: string }) {
  return text ? <p className={css.missing}><CircleHelp size={14} aria-hidden="true" /><span>{text}</span></p> : null;
}

/** Where an item comes from: suggested (with confidence and basis), accepted automatically (with its receipt) or confirmed. */
export function Mark({ link, review, label }: { link: LinkState; review: boolean; label: string }) {
  if (link.status === "owned" || link.status === "credited") return null;
  const why = `${link.basis ?? ""}${link.receiptId ? ` · Receipt ${String(link.receiptId).slice(0, 8)}` : ""}`;
  return <span className={css.mark}>
    {link.status === "suggested" ? <Badge tone="warning">Suggested · {pct(link.confidence)}</Badge>
      : <span title={why}><Badge tone={link.auto ? "accent" : "success"}>{link.auto ? "Auto-accepted" : "Confirmed"}{link.receiptId ? <Receipt size={11} aria-label="has a receipt" /> : null}</Badge></span>}
    {review && link.linkId ? <LinkDecision id={link.linkId} status={link.status} label={label} /> : null}
  </span>;
}

/** Overview: what the person works on, the last six months and the main clients. */
export function WorkSummary({ data, base }: { data: PersonWork; base: string }) {
  const s = data.summary; if (!s) return null;
  const first = data.person.name.split(/\s+/)[0]; const max = Math.max(1, ...s.trend.map(t => t.tasks + t.suggested + t.deliveries));
  const empty = !s.workingOn.length && !s.clients.length && !s.trend.some(t => t.tasks || t.deliveries || t.suggested);
  return <Panel title="Work" sub={data.counts ? [plural(data.counts.projects, "project"), plural(data.counts.tasks, "task"), plural(data.counts.deliveries, "delivery", "deliveries")].join(" · ") : undefined}
    action={{ href: `${base}?tab=work`, label: "Open" }}>
    {empty ? <Missing text={data.missing?.tasks ?? `Nothing ties ${first} to work yet.`} /> : <dl className={styles.facts}>
      <dt>Works on</dt><dd>{s.workingOn.length ? s.workingOn.map(w => `${w.kind} (${w.tasks})`).join(", ") : <span className={styles.muted}>No task types recorded</span>}{s.workingOnSuggested ? <span className={styles.muted}> · suggested</span> : null}</dd>
      <dt>Main clients</dt><dd>{s.clients.length ? s.clients.join(", ") : <span className={styles.muted}>No client recorded on their projects</span>}</dd>
      <dt>Projects</dt><dd>{s.activeProjects ? `${plural(s.activeProjects, "active project")} in the last 90 days` : <span className={styles.muted}>None confirmed active in the last 90 days</span>}</dd>
      <dt>Output</dt><dd><span className={css.trend} role="img" aria-label={`Done tasks and deliveries per month: ${s.trend.map(t => `${month(t.month)} ${t.tasks + t.deliveries}`).join(", ")}`}>
        {s.trend.map(t => <span key={t.month} title={`${month(t.month)}: ${t.tasks} done ${t.tasks === 1 ? "task" : "tasks"}, ${t.deliveries} deliveries${t.suggested ? `, ${t.suggested} suggested tasks` : ""}`}>
          <i style={{ height: `${Math.round(((t.tasks + t.deliveries) / max) * 100)}%` }} /><i data-suggested="" style={{ height: `${Math.round((t.suggested / max) * 100)}%` }} /><small>{month(t.month)}</small></span>)}</span></dd>
    </dl>}
    {data.missing?.pod ? <Missing text={data.missing.pod} /> : null}
  </Panel>;
}

/** Work tab: the person's tasks (RT1 rows they own) and suggested ones, with hours where Pulse has them. */
export function TaskList({ data }: { data: PersonWork; title?: string }) {
  const tasks = data.tasks ?? []; const review = data.can.review;
  const suggested = tasks.filter(t => t.link.status === "suggested").length;
  return <Panel fill title="Tasks" sub={tasks.length ? `${tasks.length - suggested} confirmed${suggested ? ` · ${suggested} suggested` : ""}` : undefined} action={{ href: `/tasks?person=${data.person.id}`, label: "Task board" }}>
    {tasks.length ? <ul className={styles.list}>{tasks.map(t => <li key={`${t.id}:${t.link.linkId ?? ""}`} className={styles.row}>
      <ListTodo size={15} aria-hidden="true" className={styles.muted} />
      <span className={styles.rowMain}><Link href={`/tasks/${t.id}`} className={styles.rowTitle}>{t.title}</Link>
        <span className={styles.rowMeta}><span>{STATUS[t.status ?? "unknown"] ?? t.status}</span>
          {t.projectId ? <Link href={`/projects/${t.projectId}`}>{t.projectName}</Link> : <span>No project</span>}
          {t.day ? <span>{dayYear(t.day)}</span> : t.period ? <span>{t.period}</span> : null}{t.role ? <span>{cap(t.role)}</span> : null}{t.hours ? <span>{t.hours} h</span> : null}</span></span>
      <Mark link={t.link} review={review} label={t.title} /></li>)}</ul>
      : <Missing text={data.missing?.tasks} />}
  </Panel>;
}

/** Projects tab: active and past projects with the person's role and period, then suggested ones. */
export function ProjectList({ data }: { data: PersonWork; title?: string }) {
  const all = data.projects ?? []; const review = data.can.review;
  // Active: confirmed, the project is running, and the person's latest work on it is from the last 90 days (decided by the API).
  const active = all.filter(p => p.active);
  const past = all.filter(p => p.accepted && !active.includes(p)); const suggested = all.filter(p => !p.accepted);
  const row = (p: WorkProject) => { const link = p.evidence.find(e => e.linkId); return <li key={p.projectId} className={styles.row}>
    <FolderKanban size={15} aria-hidden="true" className={styles.muted} />
    <span className={styles.rowMain}><Link href={`/projects/${p.projectId}`} className={styles.rowTitle}>{p.title}</Link>
      <span className={styles.rowMeta}><span>{p.clientName ?? "No client recorded"}</span>{p.roles.length ? <span>{p.roles.map(cap).join(", ")}</span> : null}
        {span(p.from, p.to) ? <span>{span(p.from, p.to)}</span> : null}{p.tasks ? <span>{plural(p.tasks, "task")}</span> : null}{p.deliveries ? <span>{plural(p.deliveries, "delivery", "deliveries")}</span> : null}</span></span>
    {!p.accepted && link?.linkId ? <Mark link={{ linkId: link.linkId, status: "suggested", confidence: p.confidence, basis: link.basis }} review={review} label={p.title} />
      : <span className={css.mark}><span title={p.evidence.map(e => e.basis).join(" · ")} className={styles.muted}>{p.evidence.length > 1 ? `${p.evidence.length} sources` : p.evidence[0]?.basis}</span>
        {link?.linkId && link.status === "accepted" ? <Mark link={{ linkId: link.linkId, status: "accepted", auto: link.auto, basis: link.basis }} review={review} label={p.title} /> : null}</span>}</li>; };
  return <Panel fill title="Projects" sub={all.length ? `${active.length} active · ${past.length} past${suggested.length ? ` · ${suggested.length} suggested` : ""}` : undefined}>
    {all.length ? <>
      {active.length ? <><div className={styles.subhead} data-pager-head="">Active</div><ul className={styles.list}>{active.map(row)}</ul></> : null}
      {past.length ? <><div className={styles.subhead} data-pager-head="">Past</div><ul className={styles.list}>{past.map(row)}</ul></> : null}
      {suggested.length ? <><div className={styles.subhead} data-pager-head="">Suggested</div><ul className={styles.list}>{suggested.map(row)}</ul></> : null}
    </> : <Missing text={data.missing?.projects} />}
  </Panel>;
}

/** Deliveries tab: uploads tied to the person by evidence: accepted, then suggested with their basis. */
export function EvidenceDeliveries({ data }: { data: PersonWork; title?: string }) {
  const items = data.deliveries ?? []; const review = data.can.review;
  return <Panel fill title="From evidence" sub={items.length ? `${items.filter(d => d.status === "accepted").length} accepted · ${items.filter(d => d.status === "suggested").length} suggested` : undefined}>
    {items.length ? <ul className={styles.list}>{items.map(d => <li key={d.fileId} className={styles.row}><Inbox size={15} aria-hidden="true" className={styles.muted} />
      <span className={styles.rowMain}><a className={styles.rowTitle} href={`https://drive.google.com/file/d/${encodeURIComponent(d.fileId)}/view`} target="_blank" rel="noreferrer">{d.fileName}</a>
        <span className={styles.rowMeta}>{d.kind ? <span>{cap(d.kind)}</span> : null}{d.projectId ? <Link href={`/projects/${d.projectId}`}>{d.projectName}</Link> : null}
          {d.deliveredAt ? <span>{dayYear(d.deliveredAt)}</span> : null}<span title={d.basis}>{d.basis}</span></span></span>
      <Mark link={d} review={review} label={d.fileName ?? "delivery"} /></li>)}</ul>
      : <Missing text={data.missing?.deliveries} />}
  </Panel>;
}

/** Documents tab: Drive files the person owns, and ones last edited from their account. Names only; files stay in Drive. */
export function WorkDocuments({ data }: { data: PersonWork; title?: string }) {
  const docs = data.documents ?? []; const review = data.can.review;
  const own = docs.filter(d => d.role === "Owner"), edited = docs.filter(d => d.role !== "Owner");
  const row = (d: WorkItem) => <li key={`${d.fileId}:${d.role}`} className={styles.row}><FileText size={15} aria-hidden="true" className={styles.muted} />
    <span className={styles.rowMain}><a className={styles.rowTitle} href={`https://drive.google.com/open?id=${encodeURIComponent(d.fileId)}`} target="_blank" rel="noreferrer">{d.title}</a>
      <span className={styles.rowMeta}>{d.projectId ? <Link href={`/projects/${d.projectId}`}>{d.projectName}</Link> : null}{d.modifiedOn ? <span>Changed {dayYear(d.modifiedOn)}</span> : null}<span title={d.basis}>{d.basis}</span></span></span>
    <Mark link={d} review={review} label={d.title ?? "document"} /></li>;
  return <Panel fill title="Work documents" sub={docs.length ? `${own.length} their own · ${edited.length} they edited` : "Names only; the files stay in Drive"}>
    {docs.length ? <>
      {own.length ? <><div className={styles.subhead} data-pager-head="">Their own</div><ul className={styles.list}>{own.map(row)}</ul></> : null}
      {edited.length ? <><div className={styles.subhead} data-pager-head="">Contributed to</div><ul className={styles.list}>{edited.map(row)}</ul></> : null}
    </> : <Missing text={data.missing?.documents} />}
  </Panel>;
}
