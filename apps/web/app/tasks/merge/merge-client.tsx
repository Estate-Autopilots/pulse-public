"use client";
// TASK-MERGE: the working parts of "Tidy up": look again, accept (merge) or reject a suggestion, and merge tasks picked by
// hand. Pulse never merges on its own: every merge is a person's click, and it can be undone for 7 days.
import { celebrate } from "../../kit/game";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Combine, FileText, ListChecks, RefreshCw, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../../records";
import { styles } from "../../ui";
import css from "./merge.module.css";

export type MTask = { id: string; title: string; status?: string; projectName: string | null; dueOn: string | null };
export type Suggestion = { id: string; kind: "duplicate" | "cluster"; score: number; method: string; title: string; reason: string | null; shape: "task" | "brief"; tasks: MTask[] };

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
/** The score in words: people decide on "very likely", not on 0.73. */
export const sureness = (s: number) => s >= 0.85 ? "Very likely" : s >= 0.7 ? "Likely" : "Worth a look";

export function ScanButton({ person, team }: { person?: string | null; team?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await post<{ found: number; open: number; people?: number }>("merges/suggestions/scan", team ? { team: true } : person ? { person } : {});
      notify({ id: "merge-scan", tone: "success", title: team ? `Looked at ${r.people ?? 0} people’s tasks` : r.open ? `${r.open} to look at` : "Nothing to merge right now", timeout: 3500 });
      router.refresh();
    } catch (e) { notify({ id: "merge-scan", tone: "error", title: "Could not look", message: msg(e) }); } finally { setBusy(false); }
  }
  return <button type="button" className={styles.btn} disabled={busy} onClick={() => void run()} aria-busy={busy}>
    {team ? <Users size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{busy ? "Looking…" : team ? "Look at my team" : "Look again"}</button>;
}

/** The merge dialog: one task or a brief, its title, why, and exactly what will happen. */
export function MergeDialog({ tasks, title, shape: start, reason: why, suggestionId, onClose }: { tasks: MTask[]; title: string; shape: "task" | "brief"; reason?: string | null; suggestionId?: string; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(title), [shape, setShape] = useState(start), [reason, setReason] = useState(why ?? ""), [busy, setBusy] = useState(false);
  async function merge() {
    setBusy(true);
    try {
      const r = await post<{ mergeId: string; targetId: string }>("merges", { taskIds: tasks.map((t) => t.id), title: name.trim(), shape, reason: reason.trim(), suggestionId });
      celebrate(null);  // UX-GAMIFY: a tidy list is a small win
      router.push(`/tasks/merges/${r.mergeId}?fresh=1`);
    } catch (e) { notify({ id: "merge", tone: "error", title: "Not merged", message: msg(e) }); setBusy(false); }
  }
  return <Modal title={`Merge ${tasks.length} tasks into one`} sub="The originals close as “Merged”, never deleted, and keep their history. You can undo it for 7 days." onClose={onClose}
    icon={<Combine size={16} />}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Keep them apart</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !name.trim()} onClick={() => void merge()}>{busy ? "Merging…" : "Merge"}</button></div>}>
    <div className={css.form}>
      <div className={css.shapes} role="radiogroup" aria-label="Merge into">
        <button type="button" role="radio" aria-checked={shape === "task"} className={`${css.shape} ${shape === "task" ? css.shapeOn : ""}`} onClick={() => setShape("task")}>
          <b><ListChecks size={14} aria-hidden="true" /> One task</b><small>For duplicates: the same work, said twice.</small></button>
        <button type="button" role="radio" aria-checked={shape === "brief"} className={`${css.shape} ${shape === "brief" ? css.shapeOn : ""}`} onClick={() => setShape("brief")}>
          <b><FileText size={14} aria-hidden="true" /> A brief</b><small>One task with a step for each of them.</small></button>
      </div>
      <label className={css.field}>Title<input value={name} maxLength={300} onChange={(e) => setName(e.target.value)} /></label>
      <label className={css.field}>Why (optional, shown on the merge story)<textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="Three cuts of the same reel" /></label>
      <ul className={css.tasks} aria-label="Tasks to merge">{tasks.map((t) => <li key={t.id} className={css.task}><i className={css.dot} aria-hidden="true" /><span>{t.title}</span>{t.dueOn ? <small>due {t.dueOn}</small> : null}</li>)}</ul>
      <p className={css.what}>What waits on them, their proof, ticked steps, subtasks and goal links move to the merged task. Their comments and history stay on each original, which points to the merged one.</p>
    </div>
  </Modal>;
}

export function SuggestionCard({ s, first = false }: { s: Suggestion; /** The page's one filled button is on the first card. */ first?: boolean }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [gone, setGone] = useState(false);
  async function reject() {
    setBusy(true);
    try { await post(`merges/suggestions/${s.id}/reject`); setGone(true); notify({ id: "merge-no", tone: "success", title: "Kept apart. It won’t be suggested again.", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "merge-no", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  if (gone) return null;
  return <li className={css.card}>
    <div className={css.cardHead}>
      <h3 className={css.cardTitle}><Combine size={15} aria-hidden="true" />{s.title}</h3>
      <span><span className={css.kind}>{s.kind === "duplicate" ? "Same work" : "Could be one brief"}</span> <span className={css.sure}>{sureness(s.score)}</span></span>
    </div>
    {s.reason ? <p className={css.reason}>{s.reason}</p> : null}
    <ul className={css.tasks}>{s.tasks.map((t) => <li key={t.id} className={css.task}><i className={css.dot} aria-hidden="true" /><Link href={`/tasks/${t.id}`}>{t.title}</Link>
      <small>{[t.projectName, t.dueOn ? `due ${t.dueOn}` : null].filter(Boolean).join(" · ")}</small></li>)}</ul>
    <div className={css.actions}>
      <button type="button" className={first ? `${styles.btn} ${styles.btnPrimary}` : styles.btn} disabled={busy} onClick={() => setOpen(true)}><Combine size={14} aria-hidden="true" />{s.shape === "brief" ? "Make one brief…" : "Merge…"}</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => void reject()}><X size={14} aria-hidden="true" />Not the same</button>
    </div>
    {open ? <MergeDialog tasks={s.tasks} title={s.title} shape={s.shape} reason={s.reason} suggestionId={s.id} onClose={() => setOpen(false)} /> : null}
  </li>;
}

/** Merge by hand: tick two or more open tasks. */
export function PickAndMerge({ tasks }: { tasks: MTask[] }) {
  const [picked, setPicked] = useState<string[]>([]), [open, setOpen] = useState(false), [q, setQ] = useState("");
  const shown = useMemo(() => { const w = q.trim().toLowerCase(); return w ? tasks.filter((t) => t.title.toLowerCase().includes(w)) : tasks; }, [q, tasks]);
  const chosen = tasks.filter((t) => picked.includes(t.id));
  const toggle = (id: string) => setPicked((xs) => xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= 30 ? xs : [...xs, id]);
  if (tasks.length < 2) return null;
  return <section className={css.section} aria-label="Merge by hand">
    <h2 className={css.sectionHead}>Merge by hand<small>Pick two or more</small></h2>
    <div className={css.field}><input aria-label="Find a task" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task" /></div>
    <ul className={css.pick}>{shown.map((t) => <li key={t.id}><label className={css.pickRow}><input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
      <span>{t.title}</span><small>{[t.projectName, t.dueOn].filter(Boolean).join(" · ")}</small></label></li>)}</ul>
    {picked.length ? <div className={css.sticky}><span>{picked.length} picked</span><span className={css.actions}>
      <button type="button" className={styles.btn} onClick={() => setPicked([])}>Clear</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={picked.length < 2} onClick={() => setOpen(true)}><Combine size={14} aria-hidden="true" />Merge into one…</button></span></div> : null}
    {open ? <MergeDialog tasks={chosen} title={chosen[0]?.title ?? ""} shape={chosen.length > 2 ? "brief" : "task"} onClose={() => setOpen(false)} /> : null}
  </section>;
}
