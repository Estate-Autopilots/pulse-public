import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { RecordForm } from "../records";
import { FolderSearch, Kanban, LayoutGrid, Rows3, Search } from "lucide-react";
import { api, workWords, type Period, type ProjectRow, type Stage } from "../lib/api";
import { phoneUserAgent } from "../lib/native-shell";
import { ago, apiPeriod, count, periodLabel, periodQuery, range, type PeriodParams } from "../lib/format";
import { PeriodSwitcher } from "../period-switcher";
import { InfoDrawer } from "../records";
import { Empty, Message, Page, PageHeader, Pager, Panel, Why, styles } from "../ui";
import { Board } from "./board";
import { ClientLink, FileTiles, ProjectCard, StageBadge } from "./parts";
import css from "./projects.module.css";
import { ClientTabs } from "../clients/tabs";
import { CORE_STAGES, STAGES, month, stageOf } from "./types";
import { W } from "../kit/word";
import { lower } from "../lib/words.mjs";
import { teamWords } from "../lib/api";

type View = "board" | "cards" | "list";
const VIEWS: { key: View; label: string; Icon: typeof Kanban }[] = [{ key: "board", label: "Board", Icon: Kanban }, { key: "cards", label: "Cards", Icon: LayoutGrid }, { key: "list", label: "List", Icon: Rows3 }];
type Params = PeriodParams & { view?: string; stage?: string; show?: string; q?: string; scope?: string; all?: string; pod?: string };
// QA-1024: the page renders this many rows (a board column: COLUMN_CAP cards) unless "Show all" is asked for. All 604
// projects made a 4.9 MB page on a phone (3.6-4 s before it could be used); the rest is one tap or a search away.
const CAP = 120, COLUMN_CAP = 40;

export default async function Projects({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  // KAZUK (28 Oct 2026): one place for projects. Clients → Client projects opens Work → Projects; the delivery board and
  // its lists stay here (view=board|cards|list, show=, stage=).
  // A product company keeps its own Releases page here; an agency works its client projects in Work.
  if ((await workWords()).model === "agency" && (params.view === "overview" || (!params.view && !params.stage && !params.show && !params.period && !params.from && !params.all && params.scope !== "all"))) {
    const n = new URLSearchParams({ view: "projects" }); if (params.q) n.set("q", params.q); if (params.pod) n.set("pod", params.pod);
    if (params.scope && params.scope !== "all") n.set("scope", params.scope);
    redirect(`/tasks?${n}`);
  }
  const teamWord = await teamWords();
  const [r, words] = await Promise.all([api<{ period: Period; scope: string; projects: ProjectRow[]; canEdit:boolean }>(`projects${apiPeriod(params, { scope: "all" })}`), workWords()]);
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const { period } = r.data;
  // Leadership sees all the company's work. Everyone else works from their own projects and can switch to every project to find one;
  // with no projects of their own yet, they start on every project.
  const company = r.data.scope === "All work";
  const own = r.data.projects.filter((p) => p.mine);
  const finder = !company && (params.scope === "all" || (params.scope !== "mine" && !own.length));
  const projects = company || finder ? r.data.projects : own;
  const scope = company ? r.data.scope : finder ? "All projects" : r.data.scope;

  // State lives in the URL. `show=active|quiet` are the links Home has always used.
  const stage = STAGES.find((s) => s.key === (params.show === "quiet" ? "quiet" : params.stage))?.key;
  const delivered = params.show === "active";
  // A phone opens the list (a board of columns would scroll sideways); Board stays one tap away.
  const fallback: View = phoneUserAgent((await headers()).get("user-agent")) ? "list" : "board";
  const asked: View = params.view === "cards" || params.view === "list" || params.view === "board" ? params.view : fallback;
  const view: View = asked === "board" && stage ? "cards" : asked;
  const q = (params.q ?? "").trim(); const needle = q.toLowerCase();
  const href = (over: { view?: View; stage?: Stage | null; delivered?: boolean; q?: string | null } = {}) => {
    const next = { view: over.view ?? view, stage: over.stage === null ? undefined : over.stage ?? stage, delivered: over.delivered ?? delivered, q: over.q === null ? "" : over.q ?? q };
    return `/projects${periodQuery(period, { view: next.view === fallback ? undefined : next.view, stage: next.stage, show: next.delivered ? "active" : undefined, q: next.q || undefined, scope: params.scope })}`;
  };

  const periodName = period.kind === "this" || period.kind === "last" ? periodLabel(period) : "In period";
  const periodText = periodLabel(period).toLowerCase();
  const matched = projects.filter((p) => !needle || `${p.title} ${p.clientName ?? ""} ${p.location ?? ""}`.toLowerCase().includes(needle));
  const base = matched.filter((p) => !delivered || p.count > 0);
  const byStage = new Map<Stage, ProjectRow[]>(STAGES.map((s) => [s.key, []]));
  for (const p of base) (byStage.get(p.stage) ?? byStage.get("dormant")!).push(p);
  const stages = STAGES.filter((s) => CORE_STAGES.includes(s.key) || byStage.get(s.key)!.length || s.key === stage);
  const rows = stage ? byStage.get(stage)! : base;
  const projectHref = (p: ProjectRow) => `/projects/${p.projectId}${periodQuery(period)}`;
  const filtered = !!(q || delivered || stage);
  const empty = <Empty icon={FolderSearch} first title="No projects match" text={q ? `Nothing matches “${q}” in this view. Search looks at the project title, client and location.` : `No ${stage ? `${stageOf(stage).label.toLowerCase()} ` : ""}projects${delivered ? ` with a delivery ${periodText}` : ""}.`} action={{ href: `/projects${periodQuery(period, { view: view === fallback ? undefined : view })}`, label: "Clear filters" }} />;
  const top = Math.max(1, ...rows.map((x) => x.count));
  const everything = params.all === "1";
  const cap = <T,>(list: T[], n = CAP) => (everything ? list : list.slice(0, n));
  const allHref = (() => { const h = href(); return `${h}${h.includes("?") ? "&" : "?"}all=1`; })();
  const more = (shown: number, total: number) => total > shown ? <p className={styles.muted} data-cap="">Showing the first {count(shown)} of {count(total)} projects, most deliveries first. <Link href={allHref}>Show all {count(total)}</Link> or search above.</p> : null;

  const how = <InfoDrawer label="How these are counted" title="How projects are counted" sub={`${scope} · ordered by deliveries ${periodText}, then most recent delivery`}>
        <dl>
          <div><dt>Projects</dt><dd>{company || finder ? `Every project record Pulse holds (${count(projects.length)}), whatever its stage.` : `Projects with deliveries credited to you${r.data.scope === "Your pod" ? ` or your ${lower(teamWord.team)}` : ""} (${count(projects.length)}). Stages and counts use those deliveries only.`}{finder ? " Delivery counts in this list are yours only." : ""}</dd></div>
          <div><dt>Delivery</dt><dd>One indexed media file inside a project’s configured draft or final delivery folder, counted once per Drive file and dated by its latest indexed modification (not an upload audit).</dd></div>
          {STAGES.filter((s) => stages.includes(s)).map((s) => <div key={s.key}><dt><i className={css.dot} data-stage={s.key} aria-hidden="true" />{s.label}</dt><dd>{s.rule}</dd></div>)}
          <div><dt>Delivered {periodText}</dt><dd>Projects with at least one delivery dated {range(period.from, period.to)}. This is the same number as “Projects with deliveries” on the dashboard.</dd></div>
          <div><dt>{periodName} / All time</dt><dd>Deliveries dated inside the selected period, and every delivery ever indexed for the project.</dd></div>
          <div><dt>Videos / Images</dt><dd>All-time deliveries whose file type is video or image. Other file types count only towards All time.</dd></div>
          <div><dt>File tiles</dt><dd>The four most recent deliveries, marked draft or final by the folder they landed in. The index holds no thumbnails, so tiles show the file type and open the file in Drive.</dd></div>
          <div><dt>Filter counts</dt><dd>Stage counts follow the search and the “Delivered” filter; the “Delivered” count follows the search and the chosen stage. A paused, done or cancelled status recorded on a project wins over the delivery rules.</dd></div>
        </dl>
  </InfoDrawer>;
  return (
    <Page fit>
      <PageHeader title={words.clientProjects} context={[`${count(projects.length)} packages sold`, company ? null : scope, range(period.from, period.to)]} meta={how} actions={<>{r.data.canEdit?<RecordForm path="projects" title="Add a client project" label="Add client project" icon="add" variant="primary" fields={[{key:'title',label:'Title',required:true},{key:'location',label:'Location'}]} created="/projects/"/>:null}<PeriodSwitcher period={period}/></>} />
      <ClientTabs current="/projects" words={words} />
      <div className={`${styles.toolbar} ${css.bar}`}>
        <div className={css.barStart}>
          <Link href="/projects?view=overview" className={css.chip}>Needs you</Link>
          {!company ? <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Whose projects">
            <Link href={`/projects${periodQuery(period, { scope: "mine", q: q || undefined })}`} className={styles.segment} aria-current={!finder ? "true" : undefined} title={`Projects with deliveries credited to you or your ${lower(teamWord.team)}`}>Mine<span className={styles.muted}>{count(own.length)}</span></Link>
            <Link href={`/projects${periodQuery(period, { scope: "all", q: q || undefined })}`} className={styles.segment} aria-current={finder ? "true" : undefined} title="Every project, to find one and open it">All projects<span className={styles.muted}>{count(r.data.projects.length)}</span></Link>
          </div> : null}
          {finder ? null : <><div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Filter by stage">
            <Link href={href({ stage: null, view: asked })} className={styles.segment} aria-current={!stage ? "true" : undefined}>All<span className={styles.muted}>{count(base.length)}</span></Link>
            {stages.map((s) => <Link key={s.key} href={href({ stage: s.key })} className={styles.segment} aria-current={stage === s.key ? "true" : undefined} title={s.rule}><i className={css.dot} data-stage={s.key} aria-hidden="true" />{s.label}<span className={styles.muted}>{count(byStage.get(s.key)!.length)}</span></Link>)}
          </div>
          <Link href={href({ delivered: !delivered })} className={css.chip} aria-current={delivered ? "true" : undefined} title={`Projects with at least one delivery ${periodText} (${range(period.from, period.to)})`}>Delivered<span className={css.chipWhen}> {periodText}</span><b>{count((stage ? matched.filter((p) => p.stage === stage) : matched).filter((p) => p.count > 0).length)}</b></Link></>}
        </div>
        <div className={css.barEnd}>
          <form className={styles.search} action="/projects" role="search">
            {params.scope ? <input type="hidden" name="scope" value={params.scope} /> : null}
            {view !== fallback ? <input type="hidden" name="view" value={view} /> : null}
            {stage ? <input type="hidden" name="stage" value={stage} /> : null}
            {delivered ? <input type="hidden" name="show" value="active" /> : null}
            {period.kind === "last" ? <input type="hidden" name="period" value="last" /> : period.kind !== "this" ? <><input type="hidden" name="from" value={period.from} /><input type="hidden" name="to" value={period.to} /></> : null}
            <Search size={14} aria-hidden="true" />
            <input className={styles.input} type="search" name="q" defaultValue={q} placeholder="Search projects…" title="Matches project title, client or location" aria-label="Search projects by title, client or location" />
          </form>
          {finder ? null : <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="View">
            {VIEWS.map(({ key, label, Icon }) => <Link key={key} href={href({ view: key, stage: key === "board" ? null : undefined })} className={styles.segment} aria-current={view === key ? "true" : undefined} title={`${label} view`}><Icon size={14} aria-hidden="true" /><span className={css.viewLabel}>{label}</span><span className={styles.srOnly}> view</span></Link>)}
          </div>}
        </div>
      </div>

      {finder ? (matched.length ? <Pager primary unit="projects" mobile={20}>
          <div className={`${styles.panel} ${css.sheet}`} data-enter=""><table className={`${styles.table} ${css.table}`}>
            <thead><tr><th>Project</th><th className={styles.hideSmall}>Client</th><th className={css.roomy}><W k="team" /></th><th className={styles.hideSmall}>Started</th><th className={styles.right}>Your deliveries</th></tr></thead>
            <tbody>{cap(matched).map((p) => (
              <tr key={p.projectId}>
                <td className={css.lead}><Link href={projectHref(p)} className={styles.cellLink} title={p.folderName}>{p.title}</Link><span className={styles.cellSub} title={[p.location, p.segment].filter(Boolean).join(" · ")}>{[p.location, p.segment].filter(Boolean).join(" · ") || (p.kind === "internal" ? "Internal project" : "")}</span></td>
                <td className={`${css.clip} ${styles.hideSmall}`}>{p.clientName ? <ClientLink id={p.clientId} name={p.clientName} /> : <span className={styles.muted}>Not linked</span>}</td>
                <td className={`${styles.nowrap} ${css.roomy}`}>{p.pod ?? <span className={styles.muted}>Unassigned</span>}</td>
                <td className={`${styles.nowrap} ${styles.hideSmall}`}>{p.startMonth ? month(p.startMonth) : <span className={styles.muted}>Not known</span>}</td>
                <td className={`${styles.right} ${styles.num}`}>{count(p.total)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Pager> : <Panel title="All projects">{empty}</Panel>)
      : null}
      {finder ? more(cap(matched).length, matched.length)
      : view === "board" ? (
        base.length ? (
          <Board columns={stages.length}>
            {stages.map((s) => {
              const items = byStage.get(s.key)!;
              return (
                <section key={s.key} className={css.column} aria-label={`${s.label}, ${count(items.length)} projects`}>
                  <h3 className={css.columnHead}><i className={css.dot} data-stage={s.key} aria-hidden="true" />{s.label}<small>{count(items.length)}{s.key === "dormant" && items.some((p) => !p.lastDeliveredAt) ? ` · ${count(items.filter((p) => !p.lastDeliveredAt).length)} never delivered` : ""}</small><Why detail={`${s.label}: ${s.rule}`} more="Stages are worked out from indexed deliveries each time the page loads." /></h3>
                  {items.length ? <Pager compact stretch mobile={4} label={`${s.label} projects`}>
                    <div className={css.columnList} data-items="">{cap(items, COLUMN_CAP).map((p) => <ProjectCard key={p.projectId} p={p} href={projectHref(p)} periodName={periodName} compact />)}</div>
                  </Pager> : <p className={css.columnEmpty}>No {s.label.toLowerCase()} projects{filtered ? " match" : ""}</p>}
                  {!everything && items.length > COLUMN_CAP ? <Link href={href({ stage: s.key })} className={styles.muted} data-cap="">All {count(items.length)} {s.label.toLowerCase()}</Link> : null}
                </section>
              );
            })}
          </Board>
        ) : <Panel title="Board">{empty}</Panel>
      ) : view === "cards" ? (
        rows.length ? <Pager primary stretch unit="projects" mobile={12}>
          <div className={css.cardGrid} data-items="" data-enter="">{cap(rows).map((p) => <ProjectCard key={p.projectId} p={p} href={projectHref(p)} periodName={periodName} />)}</div>
        </Pager> : <Panel title={stage ? `${stageOf(stage).label} projects` : "Projects"}>{empty}</Panel>
      ) : rows.length ? (
        <Pager primary unit="projects" mobile={20}>
          <div className={`${styles.panel} ${css.sheet}`} data-enter=""><table className={`${styles.table} ${css.table}`}>
            <thead><tr><th>Project</th><th>Stage</th><th className={styles.hideSmall}>Client</th><th className={css.roomy}><W k="team" /></th><th className={styles.right}>{periodLabel(period)}</th><th className={`${styles.right} ${styles.hideSmall}`}>All time</th><th className={css.roomy}>Latest files</th><th className={styles.hideSmall}>Last delivery</th></tr></thead>
            <tbody>{cap(rows).map((p) => (
              <tr key={p.projectId}>
                <td className={css.lead}><Link href={projectHref(p)} className={styles.cellLink} title={p.folderName}>{p.title}</Link><span className={styles.cellSub} title={[p.location, p.segment].filter(Boolean).join(" · ")}>{[p.location, p.segment].filter(Boolean).join(" · ") || (p.kind === "internal" ? "Internal project" : "")}</span></td>
                <td><StageBadge stage={p.stage} /></td>
                <td className={`${css.clip} ${styles.hideSmall}`}>{p.clientName ? <ClientLink id={p.clientId} name={p.clientName} /> : <span className={styles.muted}>Not linked</span>}</td>
                <td className={`${styles.nowrap} ${css.roomy}`}>{p.pod ?? <span className={styles.muted}>Unassigned</span>}</td>
                <td className={`${styles.right} ${styles.num}`}><span className={styles.cellBar}><i style={{ width: `${(p.count / top) * 100}%` }} /></span>{p.count}</td>
                <td className={`${styles.right} ${styles.num} ${styles.hideSmall}`} title={`${count(p.videos)} videos, ${count(p.images)} images`}>{count(p.total)}</td>
                <td className={css.roomy}>{p.latest.length ? <div className={css.rowTiles}><FileTiles files={p.latest} small /></div> : <span className={styles.muted}>—</span>}</td>
                <td className={`${styles.nowrap} ${styles.hideSmall}`}>{p.lastDeliveredAt ? ago(p.lastDeliveredAt) : <span className={styles.muted}>None indexed</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Pager>
      ) : <Panel title={stage ? `${stageOf(stage).label} projects` : delivered ? `Projects with deliveries ${periodText}` : "All projects"}>{empty}</Panel>}
      {!finder && view !== "board" ? more(cap(rows).length, rows.length) : null}
    </Page>
  );
}
