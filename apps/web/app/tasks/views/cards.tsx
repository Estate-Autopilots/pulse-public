"use client";
// TASKS-4A views: List (grouped rows that fold) and Gallery (cards). Both draw the same rows the other views do.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarDays, ChevronDown, Hand, Hourglass, ListTree, MessageSquare, Paperclip } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Avatar } from "../../ui";
import { Tooltip } from "../../kit";
import { TaskRow } from "../client";
import { STATUS, dueText } from "../parts";
import { CategoryIcon } from "../kinds";
import type { Task } from "../types";
import type { PoolTask } from "../work-two";
import { isFinished, type Bucket } from "./model";
import css from "./views.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** Groups of rows, each folding away under its heading. */
export function ListView({ buckets, today, me, domainOwner, showAssignee = true }: { buckets: Bucket[]; today: string; me: string | null; domainOwner?: string; showAssignee?: boolean }) {
  const [shut, setShut] = useState<Set<string>>(() => new Set(buckets.filter((b) => b.key === "done" || b.key === "accepted").map((b) => b.key)));
  const shown = buckets.filter((b) => b.rows.length);
  if (!shown.length) return null;
  return <div className={css.list}>
    {shown.map((b) => {
      const open = !shut.has(b.key) || shown.length === 1;
      return <section key={b.key} className={css.group} aria-label={b.label} data-tone={b.tone}>
        {shown.length > 1 || b.key !== "all" ? <h3 className={css.groupHead}>
          <button type="button" aria-expanded={open} onClick={() => setShut((s) => { const n = new Set(s); if (n.has(b.key)) n.delete(b.key); else n.add(b.key); return n; })}>
            <ChevronDown size={14} aria-hidden="true" className={css.fold} /><span>{b.label}</span><span className={css.count}>{b.rows.length}</span></button>
        </h3> : null}
        {open ? <ul className={css.rows}>{b.rows.map((t) => <TaskRow key={t.id} task={t} today={today} me={me} showAssignee={showAssignee} domainOwner={domainOwner} />)}</ul> : null}
      </section>;
    })}
  </div>;
}

/** One card: kind and project, title, when, who; a bar for subtasks. */
export function TaskCardTile({ t, today, pool }: { t: Task | PoolTask; today: string; pool?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [claimed, setClaimed] = useState(false);
  const st = STATUS[t.status] ?? STATUS.unknown, due = dueText(t, today);
  const p = t as PoolTask;
  async function claim() {
    setBusy(true);
    try { await post(`work/pool/${t.id}/claim`, {}); setClaimed(true);
      notify({ id: "claim", tone: "success", title: "It’s yours", href: `/tasks/${t.id}`, message: "It is on your list now." });
      setTimeout(() => router.refresh(), 500); }
    catch (e) { notify({ id: "claim", tone: "error", title: "Not claimed", message: msg(e) }); router.refresh(); } finally { setBusy(false); }
  }
  return <li className={css.tile} data-priority={t.priority} data-done={isFinished(t) ? "" : undefined} data-leaving={claimed ? "" : undefined}>
    <div className={css.tileTop}>
      <span className={css.kind} aria-hidden="true"><CategoryIcon category={t.category} size={14} /></span>
      <span className={css.tileKind}>{t.categoryLabel ?? t.projectName ?? "Task"}</span>
    </div>
    <Link href={`/tasks/${t.id}`} className={css.tileTitle}>{t.title}</Link>
    <div className={css.tileMeta}>
      {t.status !== "open" && t.status !== "unknown" ? <span className={css.pill} data-tone={st.tone}>{st.label}</span> : null}
      {due ? <span className={css.when} data-late={due.late ? "" : undefined}><CalendarDays size={12} aria-hidden="true" />{due.text}</span> : null}
      {t.openBlockers ? <span className={css.when} data-late=""><Hourglass size={12} aria-hidden="true" />Waits on {t.openBlockers}</span> : null}
      {t.comments ? <span className={css.icon}><MessageSquare size={12} aria-hidden="true" />{t.comments}</span> : null}
      {t.proof ? <span className={css.icon}><Paperclip size={12} aria-hidden="true" />{t.proof}</span> : null}
    </div>
    {t.subtasks ? <div className={css.progress} role="img" aria-label={`${t.subtasksDone} of ${t.subtasks} subtasks done`}><ListTree size={12} aria-hidden="true" /><i><b style={{ width: `${Math.round(100 * t.subtasksDone / t.subtasks)}%` }} /></i><span>{t.subtasksDone}/{t.subtasks}</span></div> : null}
    <div className={css.tileFoot}>
      {(t.tags ?? []).slice(0, 3).map((x) => <span key={x} className={css.tag}>#{x}</span>)}
      <span className={css.grow} />
      {pool && p.canClaim !== false && !t.assigneeId ? <button type="button" className={css.claim} onClick={claim} disabled={busy || claimed}><Hand size={13} aria-hidden="true" />{busy ? "Claiming…" : "Claim"}</button>
        : t.assigneeName ? <Tooltip content={t.assigneeName}><span><Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={26} /></span></Tooltip>
        : <span className={css.nobody}>{t.poolScope ? "In the pool" : "Nobody yet"}</span>}
    </div>
  </li>;
}

export function GalleryView({ buckets, today, pool }: { buckets: Bucket[]; today: string; pool?: boolean }) {
  const shown = buckets.filter((b) => b.rows.length);
  return <div className={css.gallery}>
    {shown.map((b) => <section key={b.key} aria-label={b.label} className={css.galleryGroup}>
      {shown.length > 1 || b.key !== "all" ? <h3 className={css.groupTitle}>{b.label}<span className={css.count}>{b.rows.length}</span></h3> : null}
      <ul className={css.tiles}>{b.rows.map((t) => <TaskCardTile key={t.id} t={t} today={today} pool={pool} />)}</ul>
    </section>)}
  </div>;
}
