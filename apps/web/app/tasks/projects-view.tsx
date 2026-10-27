import Link from "next/link";
import { GanttChartSquare, ListTree, Search } from "lucide-react";
import { SegmentedNav } from "../kit";
import { ProjectsTimeline } from "./views/projects-timeline";
import { api } from "../lib/api";
import { count, plural } from "../lib/format";
import { Pager, styles } from "../ui";
import { LinkTracker } from "./client";
import { NewProjectButton, ReviewRow } from "./work-client";
import { DetectLinks, LinkSuggestionRow, type LinkSuggestion } from "./work-two";
import two from "./work-two.module.css";
import { PROJECT_ICONS } from "./chips";
import { ProjectCategories, type Category } from "./categories";
import f from "./focus.module.css";
import type { Options } from "./types";
import css from "./tasks.module.css";
import w3 from "./work3.module.css";
import { ProjectsTree, type TreeRow } from "./projects-tree";

type Row = TreeRow & { projectKind: string; registryNo: number | null; packageStatus: string; clientId: string | null; summary?: string | null };
type List = { rows: Row[]; total: number; page: number; size: number; counts: { internal: number; fulfilment: number; all: number }; review: number; linkReview?: number; canCreate: boolean; canDecide: boolean;
  labels?: { clientProjects: string | null; fulfilmentChip: string; packageChip: string }; categories?: Category[] };
type LinkReview = { rows: LinkSuggestion[]; linked: number; dismissed: number; canDecide: boolean };
type Review = { rows: { id: string; reason: string; detail: { tasks?: number; suggestedClientId?: string; suggestedClient?: string; client?: string; kind?: string }; projectId: string; name: string; registryNo: number; kind: string; hasDrive: boolean; clientName: string | null; tasks: number }[];
  decided: number; clients: { id: string; name: string }[]; canDecide: boolean };
type Tracker = { tracker: { key: string; label: string; n: number }[]; canLink: boolean };

/** Work → Projects: internal projects and the fulfilment of client packages, with progress from their tasks. Client
 *  packages themselves live under Clients. Leadership also files what the migration could not place. */
export async function WorkProjects({ q, today }: { q: Record<string, string>; today: string }) {
  const params = new URLSearchParams(); for (const k of ["kind", "q", "mine", "page", "show", "cat"]) if (q[k]) params.set(k, q[k]);
  const [r, options] = await Promise.all([api<List>(`work/projects?${params}`), api<Options>("tasks/options")]);
  if (r.error) return <p className={css.empty}>{r.error}</p>;
  const d = r.data!;
  const [review, tracker] = d.review || q.review ? await Promise.all([api<Review>("work/review"), api<Tracker>("tasks/projects")]) : [null, await api<Tracker>("tasks/projects")];
  const links = d.linkReview || q.review ? (await api<LinkReview>("work/links/review")).data : null;
  const href = (over: Record<string, string | undefined>) => { const n = new URLSearchParams({ view: "projects" }); for (const [k, v] of Object.entries({ kind: q.kind, q: q.q, mine: q.mine, show: q.show, cat: q.cat, pl: q.pl, ...over })) if (v) n.set(k, v); return `/tasks?${n}`; };
  const pages = Math.ceil(d.total / d.size);
  const reviewRows = review?.data?.rows ?? [];
  const side = (reviewRows.length || links?.rows.length || (tracker.data?.canLink && tracker.data.tracker.length)) ? <aside className={css.side} aria-label="To file">
    {links?.rows.length ? <section className={css.panel} aria-label="What client projects include" data-grow="" data-attention={q.review ? "" : undefined}>
      <div className={css.panelHead}><h3>What {d.labels?.clientProjects?.toLowerCase() ?? "client projects"} include</h3>{links.canDecide ? <DetectLinks /> : <small>{plural(links.rows.length, "suggestion")}</small>}</div>
      <p className={css.note}>Found in your Drive folders and trackers. Link what belongs together; Pulse keeps the answer.</p>
      <Pager min={2} mobile={8} unit="suggestions"><ul className={two.linkList} data-items="">{links.rows.map((x) => <LinkSuggestionRow key={x.id} s={x} canDecide={links.canDecide} showPackage />)}</ul></Pager>
    </section> : null}
    {reviewRows.length ? <section className={css.panel} aria-label="Projects to file" data-grow="" data-attention={q.review ? "" : undefined}>
      <div className={css.panelHead}><h3>Needs a decision</h3><small>{plural(reviewRows.length, "project")}</small></div>
      <p className={css.note}>Filed as client packages but no client is linked. Choose once; Pulse keeps your answer.</p>
      <Pager min={2} mobile={8} unit="projects"><ul className={css.list} data-items="">{reviewRows.map((x) => <ReviewRow key={x.id} row={x} clients={review!.data!.clients} canDecide={review!.data!.canDecide} />)}</ul></Pager>
    </section> : null}
    {tracker.data?.canLink && tracker.data.tracker.length ? <section className={css.panel} aria-label="Tracker names without a project" data-grow="">
      <div className={css.panelHead}><h3>Tracker names to link</h3><small>{plural(tracker.data.tracker.reduce((n, t) => n + t.n, 0), "task")}</small></div>
      <Pager min={2} mobile={6} unit="names"><ul className={css.list} data-items="">{tracker.data.tracker.map((t) => <li key={t.key} className={css.row}><span /><div className={css.rowMain}><Link className={css.title} href={`/tasks?view=all&tracker=${encodeURIComponent(t.key)}`}>{t.label}</Link><span className={css.meta}>{plural(t.n, "task")}</span></div>
        <span className={css.end}><LinkTracker trackerKey={t.key} label={t.label} n={t.n} projects={options.data?.projects ?? []} /></span></li>)}</ul></Pager>
    </section> : null}
  </aside> : null;
  return <div className={css.layout} data-review={q.review ? "" : undefined}>
    <section className={w3.listPanel} aria-label="Work projects" data-grow="">
      <div className={css.bar} style={{ padding: "10px 12px" }}>
        <div className={css.barStart}>
          <nav className={styles.segmented} aria-label="Which projects">
            <Link className={styles.segment} href={href({ show: undefined, page: undefined })} aria-current={q.show !== "all" ? "true" : undefined} title="Projects with open work, set up in Pulse, or yours">Active</Link>
            <Link className={styles.segment} href={href({ show: "all", page: undefined })} aria-current={q.show === "all" ? "true" : undefined}>All</Link>
          </nav>
          <nav className={styles.segmented} aria-label="Kind">
            <Link className={styles.segment} href={href({ kind: undefined, page: undefined })} aria-current={!q.kind ? "true" : undefined}>Every kind<span className={styles.muted}>{count(d.counts.all)}</span></Link>
            <Link className={styles.segment} href={href({ kind: "fulfilment", page: undefined })} aria-current={q.kind === "fulfilment" ? "true" : undefined}>{d.labels?.fulfilmentChip ?? "Fulfilment"}<span className={styles.muted}>{count(d.counts.fulfilment)}</span></Link>
            <Link className={styles.segment} href={href({ kind: "internal", page: undefined })} aria-current={q.kind === "internal" ? "true" : undefined}>Internal<span className={styles.muted}>{count(d.counts.internal)}</span></Link>
          </nav>
          <Link className={styles.segment} href={href({ mine: q.mine === "1" ? undefined : "1", page: undefined })} aria-current={q.mine === "1" ? "true" : undefined}>Mine</Link>
          {d.categories?.length ? <nav className={styles.segmented} aria-label="Category" data-hscroll="">
            <Link className={styles.segment} href={href({ cat: undefined, page: undefined })} aria-current={!q.cat ? "true" : undefined}>Any category</Link>
            {d.categories.filter((c) => c.projects).map((c) => { const Icon = PROJECT_ICONS[c.icon] ?? PROJECT_ICONS.folder; return <Link key={c.key} className={`${styles.segment} ${f.proj}`} data-color={c.color} href={href({ cat: c.key, page: undefined })} aria-current={q.cat === c.key ? "true" : undefined}>
              <Icon size={12} aria-hidden="true" style={{ color: "var(--pc)" }} />{c.label}<span className={styles.muted}>{count(c.projects ?? 0)}</span></Link>; })}
          </nav> : null}
          {d.canDecide && d.categories ? <ProjectCategories rows={d.categories} /> : null}
          {/* TASKS-4A: the same projects as a tree (with their parts) or on a timeline. */}
          <SegmentedNav label="Projects view" size="sm" items={[{ key: "tree", href: href({ pl: undefined }), label: "Tree", icon: <ListTree size={15} aria-hidden="true" />, current: q.pl !== "timeline" },
            { key: "timeline", href: href({ pl: "timeline" }), label: "Timeline", icon: <GanttChartSquare size={15} aria-hidden="true" />, current: q.pl === "timeline" }]} />
        </div>
        <form className={styles.search} action="/tasks" role="search"><input type="hidden" name="view" value="projects" />{q.kind ? <input type="hidden" name="kind" value={q.kind} /> : null}{q.show ? <input type="hidden" name="show" value={q.show} /> : null}
          <Search size={14} aria-hidden="true" /><input className={styles.input} type="search" name="q" defaultValue={q.q ?? ""} placeholder="Search projects, clients, owners…" aria-label="Search projects" /></form>
      </div>
      {d.rows.length && q.pl === "timeline" ? <div className={w3.scroller}><ProjectsTimeline rows={d.rows} today={today} /></div>
        : d.rows.length ? <div className={w3.scroller}><ProjectsTree rows={d.rows} categories={d.categories ?? []} today={today} labels={{ fulfilmentChip: d.labels?.fulfilmentChip }} /></div>
        : <p className={css.empty}><b>{q.q ? "No projects match" : "No projects here yet"}</b>{q.q ? <Link href={href({ q: undefined })}>Clear the search</Link> : "Press + Create, then Project, to start one."}</p>}
      {pages > 1 ? <p className={css.note}>The first {count(d.rows.length)} of {count(d.total)}; search to find the rest. {d.page + 1 < pages ? <Link href={href({ page: String(d.page + 1) })}>Next</Link> : null}{d.page > 0 ? <> · <Link href={href({ page: String(d.page - 1) })}>Previous</Link></> : null}</p> : null}
      {d.canCreate ? <p className={css.note}><NewProjectButton /> Client packages themselves are under <Link href="/projects">Clients → Client projects</Link>.</p> : <p className={css.note}>Client packages themselves are under <Link href="/projects">Clients → Client projects</Link>.</p>}
    </section>
    {side}
  </div>;
}
