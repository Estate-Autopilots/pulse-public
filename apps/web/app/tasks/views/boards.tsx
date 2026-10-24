"use client";
// TASKS-4A views: Board. Grouped by status or by when, it is the TASKS-P0/TASKS-3 board (drag between columns, the
// arrow keys, Move); grouped by priority, person, project, kind or importance × urgency, the same cards sit in a
// column per group (finish with the tick, open to change the rest).
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { BoardView, TaskCard } from "../board";
import { celebrate } from "../client";
import type { Board, Column, Task } from "../types";
import type { Bucket, Group } from "./model";
import css from "./views.module.css";
import bcss from "../board.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const COLUMN_OF: Record<string, Column> = { open: "todo", unknown: "todo", in_progress: "doing", blocked: "blocked", done: "done", in_review: "done", accepted: "accepted" };
const STATUS_OF: Record<Column, string> = { todo: "open", doing: "in_progress", blocked: "blocked", done: "done", accepted: "accepted" };

export function BoardLayout({ rows, buckets, group, today, me, now }: { rows: Task[]; buckets: Bucket[]; group: Group; today: string; me: string | null; now: number }) {
  // The board keeps its own copy of the columns while cards move; a new one only when the rows change.
  const board = useMemo(() => {
    const columns: Record<Column, Task[]> = { todo: [], doing: [], blocked: [], done: [], accepted: [] };
    for (const t of rows) columns[COLUMN_OF[t.status] ?? "todo"]?.push(t);
    return { scope: "view", pod: null, pods: [], myPod: null, me, canAll: false, columns, counts: [], blockers: [], people: [], person: null, same: {}, today } as unknown as Board;
  }, [rows, me, today]);
  if (group === "status" || group === "when") {
    return <div className={css.boardWrap} data-grow=""><BoardView key={group} board={board} group={group === "when" ? "focus" : "status"} now={now} /></div>;
  }
  return <GroupBoard buckets={buckets} me={me} now={now} />;
}

function GroupBoard({ buckets, me, now }: { buckets: Bucket[]; me: string | null; now: number }) {
  const router = useRouter();
  const [moved, setMoved] = useState<Record<string, string>>({}), [busy, setBusy] = useState<string | null>(null);
  async function move(t: Task, status: string) {
    setBusy(t.id); setMoved((m) => ({ ...m, [t.id]: status }));
    try { const r = await post<{ weekDone?: number; streak?: number }>(`tasks/${t.id}/move`, { status }); if (status === "done") celebrate(r, t.title); router.refresh(); }
    catch (e) { setMoved((m) => { const n = { ...m }; delete n[t.id]; return n; }); notify({ id: "board-move", tone: "error", title: "Not moved", message: msg(e) }); } finally { setBusy(null); }
  }
  const shown = buckets.filter((b) => b.rows.length);
  return <div className={css.groupBoard} data-grow="" role="group" aria-label="Board">
    {shown.map((b) => <section key={b.key} className={`${bcss.column} ${css.groupCol}`} aria-label={b.label} data-tone={b.tone}>
      <h3 className={bcss.head}><b>{b.label}</b><span>{b.rows.length}</span></h3>
      <div className={bcss.scroll}><ul className={bcss.cards}>{b.rows.map((t) => { const s = moved[t.id] ?? t.status; const task = s === t.status ? t : { ...t, status: s };
        return <TaskCard key={t.id} task={task} now={now} me={me} focus={false} busy={busy === t.id} onDone={(x) => void move(x, "done")} onMove={(x, to) => void move(x, STATUS_OF[to])} />; })}</ul></div>
    </section>)}
    {!shown.length ? <p className={css.muted}>Nothing here.</p> : null}
  </div>;
}
