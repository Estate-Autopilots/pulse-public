import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { Message } from "../../ui";
import { RecentVisit } from "@pulse/ui-shell";
import { EmptyState, GamePage, PageHeader, StatTile, StatTiles } from "../../kit/game";
import { age as since } from "../../focus/model";
import { UrlSelect } from "../views/scope-bar";
import { PickAndMerge, ScanButton, SuggestionCard, type MTask, type Suggestion } from "./merge-client";
import css from "./merge.module.css";

type Data = { person: { id: string; name: string; me: boolean } | null; rows: Suggestion[]; open: MTask[]; team: { id: string; name: string; open: number; suggestions: number }[];
  canTeam: boolean; lastScan: string | null };
const clock = () => Date.now();

/** TASK-MERGE: "Tidy up". Tasks that read as the same work, and groups that could become one brief, for the viewer (or a
 *  person they look after); accept (merge) or reject each; or merge any tasks by hand. */
export default async function MergePage({ searchParams }: { searchParams: Promise<{ person?: string }> }) {
  const q = await searchParams;
  const r = await api<Data>(`merges/suggestions${q.person ? `?person=${encodeURIComponent(q.person)}` : ""}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  if (!d.person) return <Message text="Sign in with your own account to tidy up tasks." />;
  const dups = d.rows.filter((s) => s.kind === "duplicate"), clusters = d.rows.filter((s) => s.kind === "cluster");
  const whose = d.person.me ? "your" : `${d.person.name.split(" ")[0]}’s`;
  // UX-GAMIFY (owner, 9 Nov 2026: "Task merge"): the game-feel kit. What there is to tidy as tiles, the suggestions as
  // before, and a calm "all tidy" picture when there is nothing to merge.
  const looked = d.lastScan ? since(d.lastScan, clock()).text : null;
  return <GamePage label="Tidy up">
    <RecentVisit title="Tidy up" />
    <PageHeader eyebrow={d.person.me ? "Your tasks" : d.person.name} title="Tidy up"
      subtitle={`Spot ${whose} tasks that are the same work. Merges can be undone for 7 days.`}
      side={<>{d.canTeam ? <UrlSelect base="/tasks/merge" param="person" label="Whose tasks" value={d.person.me ? "" : d.person.id}
        options={[{ value: "", label: "My tasks" }, ...d.team.filter((p) => p.open > 1).map((p) => ({ value: p.id, label: `${p.name} · ${p.open}${p.suggestions ? ` · ${p.suggestions} to look at` : ""}` }))]} /> : null}
        <ScanButton person={d.person.me ? null : d.person.id} />{d.canTeam ? <ScanButton team /> : null}
        {looked ? <small style={{ fontSize: 12, color: "var(--theme-text-muted)" }}>Looked {looked}</small> : null}</>} />
    <StatTiles label="What there is to tidy" min={150} pair>
      <StatTile label="Open tasks" value={d.open.length} />
      <StatTile label="The same work" value={dups.length} tone={dups.length ? "warn" : "good"} />
      <StatTile label="Could be one brief" value={clusters.length} tone={clusters.length ? "warn" : undefined} />
    </StatTiles>
    <div className={css.shell}>
      {d.rows.length ? null : <EmptyState art={d.lastScan ? "done" : "nothing"} title={d.lastScan ? "All tidy" : "Not looked yet"}
        text={d.lastScan ? `No duplicates or groups in ${whose} ${plural(d.open.length, "open task")}.` : `Press Look again to check ${whose} open tasks.`} />}
      {dups.length ? <section className={css.section} aria-label="The same work">
        <h2 className={css.sectionHead}>The same work<small>{plural(dups.length, "pair or group", "pairs or groups")}</small></h2>
        <ul className={css.list}>{dups.map((s, i) => <SuggestionCard key={s.id} s={s} first={i === 0} />)}</ul></section> : null}
      {clusters.length ? <section className={css.section} aria-label="Could be one brief">
        <h2 className={css.sectionHead}>Could be one brief<small>{plural(clusters.length, "group")}</small></h2>
        <ul className={css.list}>{clusters.map((s, i) => <SuggestionCard key={s.id} s={s} first={!dups.length && i === 0} />)}</ul></section> : null}
      <PickAndMerge tasks={d.open} />
    </div>
  </GamePage>;
}
