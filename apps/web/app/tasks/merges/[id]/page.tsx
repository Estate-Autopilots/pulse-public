import Link from "next/link";
import { api } from "../../../lib/api";
import { dayTime, plural } from "../../../lib/format";
import { Message, Page, PageHeader, styles } from "../../../ui";
import { Lineage, MergeFlow, UndoMerge, type Story } from "./story";
import css from "../../merge/merge.module.css";

const MOVED: [string, string, string][] = [["links", "link", "links moved"], ["proof", "proof item", "proof items"], ["steps", "ticked step", "ticked steps"],
  ["subtasks", "subtask", "subtasks"], ["goals", "goal link", "goal links"], ["comments", "comment kept", "comments kept"]];

/** TASK-MERGE: the merge story. How N tasks became one, why, what moved, and the lineage around it. */
export default async function MergeStoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fresh?: string }> }) {
  const { id } = await params; const q = await searchParams;
  const r = await api<Story>(`merges/${encodeURIComponent(id)}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!; const m = d.merge;
  const n = d.sources.length;
  return <Page>
    <PageHeader title={m.shape === "brief" ? "How this brief was made" : "How these tasks became one"} back={{ href: "/tasks/merge", label: "Tidy up" }} recent={{ title: `Merge · ${m.title}` }}
      context={[`${plural(n, "task")} into one`, m.createdBy ? `by ${m.createdBy}` : null, dayTime(m.createdAt), m.method === "suggested" ? "from a suggestion" : null]} />
    <div className={css.shell}>
      {m.undoneAt ? <p className={css.undone}>Undone{m.undoneBy ? ` by ${m.undoneBy}` : ""} on {dayTime(m.undoneAt)}: the originals were opened again.</p> : null}
      <MergeFlow d={d} fresh={q.fresh === "1"} />
      <div className={css.why}><h3>Why</h3><p>{m.reason || m.suggestedReason || "No reason was written."}</p></div>
      <ul className={css.facts} aria-label="What moved">{MOVED.map(([k, one, many]) => <li key={k} className={css.fact}><b>{d.moved[k] ?? 0}</b><span>{(d.moved[k] ?? 0) === 1 ? one : many}</span></li>)}</ul>
      <section className={css.section} aria-label="Lineage">
        <h2 className={css.sectionHead}>Lineage<small>earlier merges on the left, the merged task on the right</small></h2>
        <Lineage graph={d.graph} />
      </section>
      <div className={css.actions}>
        {d.target ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/tasks/${d.target.id}`}>Open the merged task</Link> : null}
        {m.canUndo ? <UndoMerge id={m.id} count={n} /> : null}
      </div>
    </div>
  </Page>;
}
