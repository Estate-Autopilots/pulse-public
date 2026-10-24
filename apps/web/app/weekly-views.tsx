import Link from "next/link";
import { FolderKanban, Inbox } from "lucide-react";
import { api, type WeekData } from "./lib/api";
import { apiPeriod, count, periodLabel, periodQuery, projectParts, range, type PeriodParams } from "./lib/format";
import { PeriodSwitcher } from "./period-switcher";
import { DeliveryFeed, Empty, Fit, Kpi, Message, Meter, Page, PageHeader, Panel, Tiles, Why, styles, viewNames } from "./ui";

export function ProjectsPanel({ data, className, emptyHref="?period=last" }: { data: WeekData; className?: string; emptyHref?:string }) {
  const max = Math.max(1, ...data.projects.map((p) => p.count));
  return (
    <Panel fill title="Projects delivering" sub={`${data.projects.length} in ${periodLabel(data.period).toLowerCase()}`} className={className}
      tools={<Why detail="Project inferred from the client engagement folder path. Counts use distinct media files matching configured output folders." />}>
      {data.projects.length ? <ul className={styles.list}>{data.projects.map((p) => (
        <li key={p.projectId}><Link href={`/projects/${p.projectId}${periodQuery(data.period)}`} className={styles.row} title={p.projectName}>
          <span className={styles.rowMain}><span className={styles.rowTitle}>{projectParts(p.projectName).title}</span>
            <span className={styles.rowMeta}><span>{projectParts(p.projectName).meta || "Project"}</span></span></span>
          <span className={styles.rowEnd}><Meter value={p.count} max={max} /><span className={styles.rowValue}>{p.count}</span></span>
        </Link></li>
      ))}</ul> : <Empty icon={FolderKanban} title="No projects delivered in this period" text="Choose an earlier period to explore indexed history." action={{ href: emptyHref, label: "See last week" }} />}
    </Panel>
  );
}

export function DeliveriesPanel({ data, className, emptyHref="?period=last", showCreditHowFor }: { data: WeekData; className?: string; emptyHref?:string; showCreditHowFor?: string | null }) {
  const shown = data.recentDeliveries.length;
  return (
    <Panel fill title="Recent deliveries" sub={shown < data.deliveries.value ? `Latest ${shown} of ${count(data.deliveries.value)}` : `${count(shown)}`} className={className}>
      {shown ? <DeliveryFeed items={data.recentDeliveries} today={data.period.today} showCreditHowFor={showCreditHowFor} /> : <Empty icon={Inbox} title="No deliveries in this period" text="Choose an earlier period to explore indexed history." action={{ href: emptyHref, label: "See last week" }} />}
    </Panel>
  );
}

export function WeekTiles({ data }: { data: WeekData }) {
  return (
    <Tiles count={3}>
      <Kpi label="Deliveries" value={count(data.deliveries.value)} note={`Usual ${data.usual.toFixed(1)} a week over the eight weeks before`} spark={<Why detail={data.deliveries.why.detail} more="“Usual” includes weeks with no output. This is account activity, not a productivity score." />} />
      <Kpi label="Drafts / finals" value={`${count(data.drafts)} / ${count(data.finals)}`} note="From delivery folder names, not an approval signal" />
      <Kpi label="Projects delivering" value={count(data.projects.length)} note={`${count(data.indexedProjects)} projects indexed`} />
    </Tiles>
  );
}



export async function WeeklyView({ section, params, pod }: { section: "my-week" | "leadership" | "pod"; params: PeriodParams; pod?: string }) {
  const endpoint = section === "leadership" ? "leadership-week" : section === "pod" ? "pod-board" : "my-week";
  const result = await api<WeekData>(`${endpoint}${apiPeriod(params, { pod })}`); if (result.error) return <Message text={result.error} />;
  const data = result.data; if (!data) return null;
  const title = section === "leadership" ? "Leadership" : section === "pod" ? pod ?? "Pods" : "Tasks · My week";
  const pq = periodQuery(data.period);
  return (
    <Page fit>
      <PageHeader title={title} back={pod ? { href: `/pod${pq}`, label: "Pods" } : undefined}
        context={[`${periodLabel(data.period)}, ${range(data.period.from, data.period.to)}`, data.scope]}
        actions={<><Link className={styles.btn} href="/tasks">All tasks</Link><Link className={styles.btn} href="/activity">Observed activity</Link><PeriodSwitcher period={data.period} /></>} />

      <WeekTiles data={data} />
      <Fit className={styles.weekFit}>
        <DeliveriesPanel data={data} emptyHref={section==="my-week"?"/tasks?view=week&period=last":undefined} />
        <ProjectsPanel data={data} emptyHref={section==="my-week"?"/tasks?view=week&period=last":undefined} />
      </Fit>
    </Page>
  );
}
viewNames({ ProjectsPanel, DeliveriesPanel, WeekTiles });
