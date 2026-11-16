import Link from "next/link";
import { Megaphone, NotebookPen } from "lucide-react";
import { api } from "../lib/api";
import css from "./meetings.module.css";

/** MEETING-CAPTURE (1946): on a task made from a meeting (or a narrated problem), the link back to the transcript's line.
 *  Shown only to someone who may open that meeting (GET /api/v0/meetings/for-task/:id answers null otherwise). */
export async function FromMeeting({ taskId }: { taskId: string }) {
  const r = await api<{ meeting: { id: string; title: string; purpose?: string; line?: number; kind?: string; bugNumber?: number } | null }>(`meetings/for-task/${encodeURIComponent(taskId)}`);
  const m = r.data?.meeting;
  if (!m) return null;
  const href = `/meetings/${m.id}${m.line ? `?line=${m.line}#line-${m.line}` : ""}`;
  return <p className={css.fromMeeting} data-from-meeting="">
    {m.purpose === "problem" ? <Megaphone size={15} aria-hidden="true" /> : <NotebookPen size={15} aria-hidden="true" />}
    <span>{m.purpose === "problem" ? "Told in" : "From the meeting"} <Link href={href}>{m.title}</Link>{m.line ? <>, line {m.line}</> : null}{m.bugNumber ? ` · bug report #${m.bugNumber}` : ""}</span>
  </p>;
}
