"use client";
// AI-TASKS (owner, 25 Oct 2026): an AI employee's task queue on its profile: its open tasks in the order it works them
// (priority, then due date), what it is doing with each (working now, waiting for someone, with its reviewer), and its
// plan's progress. Read from /api/v0/agents/:id/queue (agent_task_queue: only tasks the viewer may see).
import Link from "next/link";
import { useEffect, useState } from "react";
import { ListChecks, LoaderCircle } from "lucide-react";
import { styles } from "../../../ui";
import css from "./profile.module.css";

type Item = { id: string; title: string; status: string; statusLabel: string; priority: string; dueOn: string | null; phase: string; waitingOn: string | null; running: boolean;
  givenBy: string | null; reviewer: string | null; steps: number; stepsDone: number };
const PHASE: Record<string, string> = { queued: "Next up", working: "Working on it", waiting: "Waiting", in_review: "With its reviewer", returned: "Returned: picking it up", stopped: "Stopped" };

export function AiQueue({ id, canGive }: { id: string; canGive: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => fetch(`/api/v0/agents/${encodeURIComponent(id)}/queue`, { cache: "no-store" }).then(async (r) => {
      const d = await r.json().catch(() => ({})); if (!live) return;
      if (!r.ok) { setError(d.error ?? "Could not load its queue"); return; }
      setItems(d.queue ?? []); setError("");
    }).catch(() => { if (live) setError("Could not load its queue"); });
    void read(); const t = setInterval(read, 20000);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  return <section className={css.pane} role="tabpanel" id="ai-pane-queue" aria-labelledby="ai-tab-queue">
    <header className={css.paneHead}><div><h3>Task queue</h3><p>Its open tasks in the order it works them: most important first, then the soonest due. It looks at each every working day; a person reviews all of its work.</p></div>
      <Link className={styles.btn} href="/people/ai/tasks">Tasks and cost of every AI employee</Link></header>
    <div className={css.paneBody}>
      {error ? <p className={css.roNote}>{error}</p> : items === null ? <p className={styles.muted}><LoaderCircle size={15} aria-hidden="true" /> Loading…</p>
        : items.length ? <ul className={css.list}>{items.map((t) => <li key={t.id} className={css.item}>
          <em className={css.pill} data-status={t.status === "blocked" ? "bad" : t.status === "in_review" ? "done" : t.running ? "run" : "wait"}>{t.running ? "Working now" : PHASE[t.phase] ?? t.statusLabel}</em>
          <span className={css.itemMain}><Link href={`/tasks/${t.id}`}><b>{t.title}</b></Link>
            <small>{[t.statusLabel, t.phase === "waiting" && t.waitingOn ? `waiting for ${t.waitingOn}` : null, t.steps ? `${t.stepsDone} of ${t.steps} steps` : null,
              t.priority !== "normal" ? `${t.priority} priority` : null, t.dueOn ? `due ${t.dueOn}` : null, t.givenBy ? `from ${t.givenBy}` : null, t.reviewer ? `reviewer ${t.reviewer}` : null].filter(Boolean).join(" · ")}</small></span>
        </li>)}</ul>
        : <p className={styles.muted}><ListChecks size={15} aria-hidden="true" /> Nothing open. {canGive ? "Give it a task from Work (+ Create, Who does it), from a chat (@its name … Send as task) or from a group's review queue." : null}</p>}
    </div>
  </section>;
}
