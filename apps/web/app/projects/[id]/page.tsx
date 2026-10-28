import Link from "next/link";
import { LeadView, CallsView } from "../../research/views";
import type { LeadData } from "../../research/types";
import { Upload } from "../../company/actions";
import { Clock, GitBranch, Inbox, PackageCheck } from "lucide-react";
import { api } from "../../lib/api";
import { deliverableTypeLabel } from "../../lib/deliverable-type-label";
import { ago, apiPeriod, count, dayYear, periodLabel, periodQuery, plural, range, type PeriodParams } from "../../lib/format";
import { PeriodSwitcher } from "../../period-switcher";
import { RecordForm, SuggestCorrection, type FieldDef } from "../../records";
import { Delta, DeliveryFeed, Empty, Fact, History, Kpi, Message, Page, PageHeader, Panel, QueryTabs, Tiles, WeekChart, styles } from "../../ui";
import { WaChatsSection, WaInsightKpis } from "../../chats/whatsapp/wa";
import { ReportTab, reportFor } from "../../insights/reports/subject-tab";
import { CreativeLibrary } from "../../chats/whatsapp/creatives";
import { LinkedGroups } from "../../chats/groups/linked";
import { ClientLink, StageBadge } from "../parts";
import { KindChip } from "../../work-kind";
import { EditPackage } from "../../tasks/work-client";
import { LinkSuggestionRow, PlaceUnder, type LinkSuggestion } from "../../tasks/work-two";
import two from "../../tasks/work-two.module.css";
import css from "../projects.module.css";
import { month, stageOf, type ProjectDetail } from "../types";
import { W } from "../../kit/word";
import { vocabulary } from "../../lib/api";

const STATUS = ["onboarding", "active", "paused", "done", "cancelled"].map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
const PODS = [`Pod 1`, `Pod 2`, "Shared"].map((value) => ({ value, label: value }));

type Linked = { id: string; projectId: string; name: string; kind: string; status: string | null; ownerName: string | null; source: string; month: string | null; total: number; finished: number; open: number; overdue: number };
type Package = { scope: string | null; startsOn: string | null; endsOn: string | null; startMonth: string | null; status: string; value: { amount: number; currency: string } | null; canEdit: boolean;
  setUp: boolean; ownerName: string | null; progress: { total: number; finished: number; open: number; overdue: number; blocked: number; nextDue: string | null };
  links?: { linked: Linked[]; suggestions: LinkSuggestion[]; parent: { id: string; name: string } | null; totals: { projects: number; total: number; finished: number; open: number; overdue: number } };
  combined?: { total: number; finished: number; open: number; overdue: number } };

const TABS = ["overview", "includes", "deliveries", "chats", "report", "related", "history", "leads", "creatives", "calls"] as const;
type Tab = typeof TABS[number];

export default async function Project({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<PeriodParams & { tab?: string;queue?:string;page?:string }> }) {
  const words = await vocabulary();
  const { id } = await params; const query = await searchParams;
  const tab: Tab = TABS.includes(query.tab as Tab) ? query.tab as Tab : "overview";
  const r = await api<ProjectDetail>(`projects/${encodeURIComponent(id)}${apiPeriod(query)}`);
  if (r.error) return <Message text={r.error} />; const p = r.data; if (!p) return null;
  const research=['leads','creatives'].includes(tab)?await api<LeadData>(`projects/${id}/research`):null;
  const upload = await api<{enabled:boolean;reason:string}>(`projects/${id}/upload`);
  const pkg = (await api<Package>(`work/package/${p.projectId}`)).data ?? null;
  // WA-IMPORT: the project's WhatsApp groups (the ones the viewer reads), a tab only when there are any.
  const chats = (await api<{ total: number }>(`chats/whatsapp?project=${p.projectId}&limit=1`)).data?.total ?? 0;
  // WA-DEEP: the project's chapter of the analysis book (leadership and admins; null for everyone else), a tab when there is one.
  const report = await reportFor("project", p.projectId);
  // GROUPS-2: the project's groups with the hub's facts (type, health, waiting on us, open tasks), on the Group chats tab.
  const groupCount = (await api<{ total: number }>(`chats/hub/linked?project=${p.projectId}&count=1`)).data?.total ?? 0;
  const period = p.period; const stage = stageOf(p.stage);
  const inPeriod = p.deliveries.length > 0;
  const feed = inPeriod ? p.deliveries : p.latest;
  const fields: FieldDef[] = [
    { key: "title", label: "Title", required: true, wide: true },
    { key: "clientId", label: "Client", type: "select", options: p.clients.map((c) => ({ value: c.id, label: c.name })) },
    { key: "status", label: "Status", type: "select", options: STATUS, required: true },
    { key: "location", label: "Location" }, { key: "segment", label: "Segment" },
    { key: "pod", label: `${words.team}`, type: "select", options: PODS },
    { key: "pgsId", label: "Confirmed PGS", type: "select", options: (p.staff??[]).map(person=>({value:person.id,label:person.name})) },
  ];
  return (
    <Page fit>
      <PageHeader title={p.title} back={{ href: `/projects${periodQuery(period)}`, label: "Client projects" }} recent={{ kind: "project" }}
        context={[
          p.editedBy ? `Edited by ${p.editedBy}` : null,
          <KindChip key="kind" kind={p.kind === "internal" ? "internal" : "client"} />,
          <Link key="work" href={`/tasks/projects/${p.projectId}`} className={css.inlineLink}><PackageCheck size={13} aria-hidden="true" /> {p.kind === "internal" ? "Tasks" : "Fulfilment"}</Link>,
          p.clientName ? <ClientLink key="client" id={p.clientId} name={p.clientName} /> : p.kind === "internal" ? "Internal project" : "No client linked",
          p.location, p.pod ?? `${words.team} unassigned`, `${periodLabel(period)}, ${range(period.from, period.to)}`,
        ]}
        meta={<StageBadge stage={p.stage} />}
        actions={<>
          {p.canEdit ? <Link className={styles.btn} href={`/stewardship/project/${p.projectId}`}>Correct data & links</Link> : <SuggestCorrection entity="project" id={p.projectId} name={p.title} />}
          <Upload project={p.projectId} enabled={upload.data?.enabled??false} reason={upload.data?.reason??'Drive write access pending'}/>
          <PeriodSwitcher period={period} />
          {p.canEdit ? <RecordForm path={`projects/${p.projectId}`} title="Edit project" label="Edit" fields={fields}
            values={{ title: p.title, clientId: p.clientId, status: p.status, location: p.location, segment: p.segment, pod: p.pod,pgsId:p.pgsId }}
            note="Fields you change here are kept when Pulse next syncs from Drive. Stage follows deliveries unless the status is paused, done or cancelled." /> : null}
        </>} />
      <QueryTabs base={`/projects/${p.projectId}`} current={tab} keep={periodQuery(period).slice(1)} items={[
        { key: "overview", label: "Overview" }, ...(p.kind !== "internal" ? [{ key: "includes", label: "Includes", count: (pkg?.links?.linked.length ?? 0) + (pkg?.links?.suggestions.length ?? 0) || undefined }] : []),
        { key: "deliveries", label: inPeriod ? "Deliveries in period" : "Latest deliveries", count: feed.length },
        ...(chats || groupCount || tab === "chats" ? [{ key: "chats", label: "Group chats", count: Math.max(chats, groupCount) }] : []), ...(report ? [{ key: "report", label: "Report" }] : []),
        { key: "leads", label: "Leads" }, { key: "creatives", label: "Creatives" }, { key: "calls", label: "Calls" },
        { key: "related", label: "Related", count: p.related.length }, { key: "history", label: "History", count: p.history.length },
      ]} />

      {research?.data?<LeadView d={research.data} mode={tab} project={id}/>:research?.error?<Message text={research.error}/>:null}
      {/* WA-MEDIA: the creatives sent in the project's WhatsApp groups and what the client said, and figures from their files. */}
      {tab === "creatives" && chats ? <CreativeLibrary project={p.projectId} /> : null}
      {tab === "chats" ? <Panel fill title="Group chats" sub="The project's groups: Pulse chats now, with their WhatsApp history inside"><LinkedGroups project={p.projectId} /><WaInsightKpis subject="project" id={p.projectId} /><WaChatsSection filter={{ project: p.projectId }} title="Chats" empty="No imported chat of this project is visible to you." /></Panel> : null}
      {tab === "report" && report ? <ReportTab reportKey={report.key} /> : null}
      {tab==='calls'?<CallsView project={id} query={{queue:query.queue??'untouched',page:query.page??'0'}}/>:null}
      {/* Overview: the key numbers, the 12-week trend and the record side by side; each list has its own tab. */}
      {tab === "overview" ? <div className={css.profileOverview} data-grow="" data-enter="">
        <Tiles count={4}>
          <Kpi label={`Deliveries, ${periodLabel(period).toLowerCase()}`} value={count(p.count)} delta={<Delta value={p.count} previous={p.prev} />} note={period.inProgress ? "vs same point before" : "vs period before"} href={`/projects/${p.projectId}${periodQuery(period, { tab: "deliveries" })}`} />
          <Kpi label="All-time deliveries" value={count(p.total)} note={`${plural(p.drafts, "draft")}, ${plural(p.finals, "final")}`} />
          <Kpi label="Last delivery" value={p.lastDeliveredAt ? ago(p.lastDeliveredAt) : "—"} note={p.firstDeliveredAt ? `First on ${dayYear(p.firstDeliveredAt)}` : "No deliveries indexed"} />
          <Kpi label="Indexed files" value={count(p.files)} note={p.lastFileAt ? `Last file change ${ago(p.lastFileAt)}` : "No files indexed"} />
        </Tiles>
        <div className={css.profileRow}>
          <Panel fill title="Deliveries per week" sub="Last 12 weeks">
            <WeekChart weeks={p.trend} period={period} hrefFor={(week) => `/projects/${p.projectId}?week=${week}`} />
          </Panel>
          <Panel fill title={p.kind === "internal" ? "Project" : "Client package"} tools={pkg?.canEdit && p.kind !== "internal" ? <EditPackage id={p.projectId} scope={pkg.scope} startsOn={pkg.startsOn} endsOn={pkg.endsOn} status={pkg.status} value={pkg.value} /> : undefined}>
            <dl className={styles.facts}>
              {pkg && p.kind !== "internal" ? <>
                <dt>Scope</dt><dd><Fact value={pkg.scope} missing="Not written down yet" /></dd>
                <dt>Dates</dt><dd><Fact value={pkg.startsOn || pkg.endsOn ? `${pkg.startsOn ? dayYear(pkg.startsOn) : "…"} → ${pkg.endsOn ? dayYear(pkg.endsOn) : "open"}` : null} missing={pkg.startMonth ? `Started ${month(pkg.startMonth)}` : "Not set"} /></dd>
                {pkg.canEdit ? <><dt>Value</dt><dd><Fact value={pkg.value?.amount ? `₹${Number(pkg.value.amount).toLocaleString("en-IN")}` : null} missing="Not recorded" /> <span className={styles.muted}>· leadership only</span></dd></> : null}
                <dt>Fulfilment</dt><dd>{pkg.progress.total ? <Link href={`/tasks/projects/${p.projectId}`} className={css.inlineLink}>{Math.round(100 * pkg.progress.finished / pkg.progress.total)}% done · {plural(pkg.progress.open, "open task")}{pkg.progress.overdue ? ` · ${pkg.progress.overdue} late` : ""}{pkg.progress.nextDue ? ` · next ${dayYear(pkg.progress.nextDue)}` : ""}</Link>
                  : pkg.setUp ? <Link href={`/tasks/projects/${p.projectId}`} className={css.inlineLink}>Set up, no tasks yet</Link> : <span className={styles.muted}>Not set up yet · <Link href={`/tasks/projects/${p.projectId}`} className={css.inlineLink}>open it</Link></span>}{pkg.ownerName ? <span className={styles.muted}> · owner {pkg.ownerName}</span> : null}</dd>
                {pkg.links && (pkg.links.linked.length || pkg.links.parent) ? <><dt>Includes</dt><dd>{pkg.links.parent ? <>Part of <Link href={`/projects/${pkg.links.parent.id}`} className={css.inlineLink}>{pkg.links.parent.name}</Link></>
                  : <Link href={`/projects/${p.projectId}?tab=includes`} className={css.inlineLink}>{plural(pkg.links.linked.length, "more project")}{pkg.combined?.total ? ` · ${Math.round(100 * pkg.combined.finished / pkg.combined.total)}% done in all` : ""}</Link>}</dd></> : null}
              </> : null}
              <dt>Client</dt><dd><Fact value={p.clientName ? <ClientLink id={p.clientId} name={p.clientName} /> : null} missing={p.kind === "internal" ? "Internal project" : "Not linked"} /></dd>
              <dt>Deliverable type</dt><dd><Fact value={deliverableTypeLabel(p.deliverableType)} /></dd>
              <dt>Stage</dt><dd>{stage.label} <span className={styles.muted}>· status {p.status}</span></dd>
              <dt><W k="team" /></dt><dd><Fact value={p.pod} missing="Unassigned" /></dd><dt>PGS</dt><dd><Fact value={p.pgsName} missing="Confirm a PGS in Edit or Review data" /></dd>
              <dt>Location</dt><dd><Fact value={p.location} /></dd>
              <dt>Segment</dt><dd><Fact value={p.segment} /></dd>
              <dt>Started</dt><dd><Fact value={month(p.startMonth)} /></dd>
              <dt>Contacts</dt><dd>{p.people.length ? p.people.map((c, i) => <span key={c.id}>{i ? ", " : ""}<Link href={`/contacts/${c.id}`} className={css.inlineLink}>{c.name}</Link>{c.role ? <span className={styles.muted}> ({c.role})</span> : null}</span>) : <Fact />}</dd>
            </dl>
          </Panel>
        </div>
      </div> : null}

      {tab === "includes" && pkg?.links ? <div className={css.profileRow} data-grow="" style={pkg.links.suggestions.length ? undefined : { gridTemplateColumns: "minmax(0, 1fr)" }}>
        <Panel fill title="What it includes" sub={pkg.links.parent ? `Part of ${pkg.links.parent.name}` : pkg.combined?.total ? `${plural(pkg.links.linked.length + 1, "project")} · ${pkg.combined.finished} of ${pkg.combined.total} tasks done` : undefined}
          tools={pkg.canEdit && !pkg.links.parent ? <PlaceUnder clientProjectId={p.projectId} /> : undefined}>
          <ul className={two.linkList} data-items="">
            <li className={two.linkRow}><div className={two.linkMain}><span className={two.linkPair}><KindChip kind="fulfilment" short /><Link href={`/tasks/projects/${p.projectId}`} className={two.linkName}>{p.title}</Link><small>its own fulfilment</small></span>
              <span className={styles.muted}>{pkg.progress.total ? `${pkg.progress.finished} of ${pkg.progress.total} tasks done${pkg.progress.overdue ? ` · ${pkg.progress.overdue} late` : ""}` : "No tasks yet"}</span></div></li>
            {pkg.links.linked.map((l) => <li key={l.id} className={two.linkRow}><div className={two.linkMain}><span className={two.linkPair}><KindChip kind={l.kind === "internal" ? "internal" : "client"} short />
              <Link href={l.kind === "internal" ? `/tasks/projects/${l.projectId}` : `/projects/${l.projectId}`} className={two.linkName}>{l.name}</Link>{l.month ? <small>{month(l.month)}</small> : null}{l.source === "manual" ? null : <small>found in {l.source === "drive" ? "Drive" : l.source}</small>}</span>
              <span className={styles.muted}>{l.total ? `${l.finished} of ${l.total} tasks done${l.overdue ? ` · ${l.overdue} late` : ""}` : "No tasks yet"}{l.ownerName ? ` · ${l.ownerName}` : ""}</span></div></li>)}
          </ul>
          {!pkg.links.linked.length ? <p className={styles.panelFoot}>{pkg.links.parent ? "This folder belongs to the package above." : "Projects that deliver this package (the company’s own, or other client folders filed for it) appear here once linked."}</p> : null}
        </Panel>
        {pkg.links.suggestions.length ? <Panel fill title="Suggested from your folders and trackers" sub={`${pkg.links.suggestions.length} to review`}>
          <ul className={two.linkList} data-items="">{pkg.links.suggestions.map((sg) => <LinkSuggestionRow key={sg.id} s={sg} canDecide={pkg.canEdit} />)}</ul>
        </Panel> : null}
      </div> : null}
      {tab === "deliveries" ? <Panel fill primary unit="deliveries" title={inPeriod ? "Deliveries in this period" : "Latest deliveries"} sub={inPeriod ? `${count(p.deliveries.length)} · ${range(period.from, period.to)}` : p.latest.length ? `None in this period · latest ${count(p.latest.length)} of ${count(p.total)}` : undefined}>
        {feed.length ? <DeliveryFeed items={feed} today={period.today} showProject={false} />
          : <Empty icon={Inbox} title="No deliveries indexed for this project" text="Files appear here once they land in one of the project's delivery folders." action={{ href: `/projects${periodQuery(period)}`, label: "Back to projects" }} />}
      </Panel> : null}

      {tab === "related" ? <Panel fill primary unit="engagements" title="Related engagements" sub={p.related.length ? `${count(p.related.length)} · other shoots of the same development` : undefined}>
        {p.related.length ? <ul className={styles.list}>{p.related.map((x) => (
          <li key={x.projectId}><Link href={`/projects/${x.projectId}${periodQuery(period)}`} className={css.relRow} title={x.folderName}>
            <span className={styles.rowMain}><span className={styles.rowTitle}>{x.title}</span>
              <span className={styles.rowMeta}><span>{[month(x.startMonth), x.clientName, plural(x.total, "delivery", "deliveries")].filter(Boolean).join(" · ")}</span></span></span>
            <StageBadge stage={x.stage} />
          </Link></li>
        ))}</ul> : <Empty icon={GitBranch} first title="No related engagements" text="No other engagement is recorded for this project. Repeat sales of the same real project are listed here." />}
      </Panel> : null}

      {tab === "history" ? <div className={css.halves} data-grow="" data-enter="">
        <Panel fill title="Record changes" sub={p.history.length ? count(p.history.length) : undefined}>
          {p.history.length ? <History items={p.history} /> : <Empty icon={Clock} first title="No edits yet" text="Changes made in Pulse are listed here with who made them." />}
        </Panel>
        <Panel fill title="How Pulse knows this">
          <dl className={styles.facts}>
            <dt>Folder</dt><dd>{p.folderName}</dd>
            <dt>Storage root</dt><dd><Fact value={p.storageRoot?.replace(/^index-path:/, "")} missing="No folder path recorded" /></dd>
            <dt>Stage rule</dt><dd>{stage.rule}</dd>
            <dt>Deliveries</dt><dd>Indexed media files inside this project’s configured draft and final delivery folders, one per Drive file, dated by latest indexed modification.</dd>
            {p.locked.length ? <><dt>Edited in Pulse</dt><dd>{p.locked.join(", ")}</dd></> : null}
          </dl>
        </Panel>
      </div> : null}
    </Page>
  );
}
