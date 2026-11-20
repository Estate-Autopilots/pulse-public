import Link from "next/link";
import { Combine } from "lucide-react";
import { api } from "../../lib/api";
import { dayTime, plural } from "../../lib/format";
import css from "./merge.module.css";

type Lines = { mergedInto: { mergeId: string; targetId: string; title: string | null; at: string; by: string | null } | null; madeFrom: { mergeId: string; shape: string; at: string; count: number }[] };

/** TASK-MERGE: on a task page, the merge it is part of: "Merged into …" on an original, "Made from N tasks" on the result. */
export async function MergeLines({ taskId }: { taskId: string }) {
  const r = await api<Lines>(`merges/task/${encodeURIComponent(taskId)}`);
  const d = r.data; if (!d || (!d.mergedInto && !d.madeFrom.length)) return null;
  return <>
    {d.mergedInto ? <p className={css.banner} role="note"><Combine size={15} aria-hidden="true" />
      <span>Merged into <Link href={`/tasks/${d.mergedInto.targetId}`}>“{d.mergedInto.title ?? "the merged task"}”</Link>{d.mergedInto.by ? ` by ${d.mergedInto.by}` : ""} · {dayTime(d.mergedInto.at)}.</span>
      <Link href={`/tasks/merges/${d.mergedInto.mergeId}`}>See the merge story</Link></p> : null}
    {d.madeFrom.map((m) => <p key={m.mergeId} className={css.banner} role="note"><Combine size={15} aria-hidden="true" />
      <span>{m.shape === "brief" ? "A brief made from" : "Made from"} {plural(m.count, "task")} · {dayTime(m.at)}.</span>
      <Link href={`/tasks/merges/${m.mergeId}`}>See how</Link></p>)}
  </>;
}
