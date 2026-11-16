import Link from "next/link";
import { AlertTriangle, CircleDot, Clock, Lightbulb } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Empty, Page, PageHeader, Panel } from "../ui";
import { HomePerson, LoadFailure, StartSprint } from "./controls";
import css from "./creative.module.css";
import { dayName, packageLabel, type Config, type Home, type HomeRow, type SprintRow } from "./types";

export const metadata = { title: "Creative Strategy" };

const TONE = { alert: "danger", overdue: "danger", today: "warning", upcoming: "neutral" } as const;
const when = (r: HomeRow) => r.state === "alert" ? "Alert" : r.state === "overdue" ? `Overdue · ${dayName(r.due!)}` : r.state === "today" ? "Due today" : dayName(r.due!);
const ICON = { alert: AlertTriangle, overdue: Clock, today: CircleDot, upcoming: CircleDot } as const;

/** EST-1474: CS Home. The signed-in strategist's work (leadership and admins choose anyone's): the Day-1 alerts, then what
 *  is overdue, due today and next. Each row opens the exact step it names. Below it, the sprints this person works on. */
export default async function CreativeHome({ searchParams }: { searchParams: Promise<{ person?: string }> }) {
  const { person } = await searchParams;
  const [home, list, config] = await Promise.all([api<Home>(`creative/home${person ? `?person=${encodeURIComponent(person)}` : ""}`),
    api<{ sprints: SprintRow[]; canStart: boolean }>("creative/sprints"), api<Config>("creative/config")]);
  const h = home.data, sprints = list.data?.sprints ?? [];
  const mine = !person;
  return (
    <Page>
      <PageHeader title="Creative Strategy" context={[h?.person.name ?? "", "CS Home"]}
        actions={<>{h?.canChoosePerson ? <HomePerson current={h.person.id} /> : null}{config.data?.canStart ? <StartSprint packages={config.data.packages} /> : null}</>} />
      {!config.data ? <LoadFailure error={config.error} /> : null}
      <div className={css.grid}>
        <Panel title={mine ? "My work" : `${h?.person.name ?? ""}'s work`} sub="Each row opens the exact step it names">
          {!h ? <LoadFailure error={home.error} />
            : h.rows.length ? <ul className={css.rows}>{h.rows.map((r) => { const Icon = ICON[r.state]; return <li key={`${r.sprintId}:${r.kind}:${r.key}`}>
              <Link href={r.href} className={css.row} data-state={r.state}><Icon size={16} aria-hidden="true" /><span className={css.main}><b>{r.title}</b><small>{r.detail}</small></span><Badge tone={TONE[r.state]}>{when(r)}</Badge></Link>
            </li>; })}</ul>
            : <Empty icon={Lightbulb} title="Nothing due" text={h.sprints ? "Every deliverable is done or not due yet." : "No sprint names this person yet. A growth strategist starts one from a client project."} />}
        </Panel>
        <Panel title="Sprints" sub={sprints.length ? `${sprints.length} active` : undefined}>
          {!list.data ? <LoadFailure error={list.error} /> : sprints.length ? <ul className={css.rows}>{sprints.map((s) => <li key={s.id}>
            <Link href={`/creative/sprints/${s.id}`} className={css.row} data-state={s.overdue ? "overdue" : s.missingInputs ? "alert" : "upcoming"}>
              <Lightbulb size={16} aria-hidden="true" />
              <span className={css.main}><b>{s.project}</b><small>{packageLabel(config.data ?? null, s.package)} · {s.day >= 1 ? `Day ${s.day}` : `Starts ${dayName(s.dayOne)}`}{s.shift ? ` · clock moved ${s.shift} day${s.shift === 1 ? "" : "s"}` : ""}{s.cs ? ` · CS ${s.cs}` : ""}</small></span>
              {s.overdue ? <Badge tone="danger">{s.overdue} overdue</Badge> : s.missingInputs ? <Badge tone="warning">{s.missingInputs} inputs missing</Badge> : s.next ? <Badge>{`Next: ${dayName(s.next.due)}`}</Badge> : <Badge tone="success">All done</Badge>}
            </Link></li>)}</ul>
            : <Empty icon={Lightbulb} title="No active sprint" text={list.data?.canStart ? "Start one from a client project: choose the package and Day 1, and the clock follows." : "Sprints you work on appear here."} />}
        </Panel>
      </div>
    </Page>
  );
}
