"use client";
// TASKS-4B: the working parts of a task's life after the work. The reviewer's bar ("Review Kedab's work": one quality
// rating, above and beyond, Accept or Send back; Acknowledge for leadership's and founders' work), open subtasks with
// one-tap Finish / Move out / Cancel, the warning on work finished with open subtasks, the review queue (bulk accept)
// and the top bar's Reviews chip, so the queue is obvious wherever the reviewer is.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, BadgeCheck, Check, ClipboardCheck, CornerUpLeft, Eye, Sparkles, Undo2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { Rating } from "./kit";
import { AcceptChoice } from "./accept";
import { HelpHint } from "../kit";
import type { Detail, Flag, Life, ReviewPolicy, ReviewRow, Task } from "./types";
import css from "./life.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const defaultQuality = (p: ReviewPolicy | undefined) => p?.reviewScale === "five" ? "4" : "good";

// ------------------------------------------------------------------------------------------------ the reviewer
/** "Review Kedab's work": the reviewer's one step. A rating (Great / Good / Needs work, or 1–5 by policy), above and
 *  beyond, an optional note; or one tap to acknowledge leadership's work. Send back asks what still needs doing. */
export function ReviewBar({ d, compact }: { d: Detail; compact?: boolean }) {
  const router = useRouter(); const t = d.task; const life = d.life as Life;
  const [quality, setQuality] = useState(defaultQuality(life.policy)), [above, setAbove] = useState(false), [note, setNote] = useState(""), [noting, setNoting] = useState(false);
  const [busy, setBusy] = useState(false), [back, setBack] = useState(false);
  const who = first(t.assigneeName);
  const open = d.children.filter((c) => ["open", "in_progress", "blocked", "unknown"].includes(c.status));
  async function accept(ack: boolean) {
    setBusy(true);
    try {
      const r = await post<{ kind?: string }>(`tasks/${t.id}/accept`, ack ? { acknowledge: true, note } : { quality, above, note });
      notify({ id: "accept", tone: "success", title: r.kind === "acknowledged" ? `Accepted · thanks to ${who}` : `Accepted · ${who} is told`, message: t.title, timeout: 3500 });
      router.refresh();
    } catch (e) { notify({ id: "accept", tone: "error", title: "Not accepted", message: msg(e) }); } finally { setBusy(false); }
  }
  // UX-5A: the same rating and "above and beyond" as every other place work is accepted (accept.tsx); no points (INTEGRITY).
  return <div className={css.review} data-compact={compact ? "" : undefined} role="group" aria-label={`Review ${who}’s work`}>
    {life.flags.length || open.length ? <OpenWarning d={d} open={open} /> : null}
    <div className={css.reviewRow}>
      <span className={css.reviewTitle}><ClipboardCheck size={16} aria-hidden="true" />{life.mode === "acknowledge" ? `${who}’s work` : `Review ${who}’s work`}
        <HelpHint label="How reviewing works">{life.mode === "rate" ? "Say how good the work was. The rating goes to the person’s record; tasks carry no points." : "Leadership’s and founders’ work is acknowledged, not graded: their scorecard is outcomes."}</HelpHint></span>
      {life.mode === "rate" ? <AcceptChoice scale={life.policy.reviewScale} quality={quality} setQuality={setQuality} above={above} setAbove={setAbove} size={compact ? "sm" : "md"} /> : null}
      <span className={css.reviewButtons}>
        {!noting ? <button type="button" className={css.linkBtn} onClick={() => setNoting(true)}>Add a note</button> : null}
        <button type="button" className={styles.btn} disabled={busy} onClick={() => setBack(true)}><Undo2 size={14} aria-hidden="true" />Send back</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void accept(life.mode === "acknowledge")}>
          {life.mode === "acknowledge" ? <><BadgeCheck size={15} aria-hidden="true" />Accept</> : <><Check size={15} aria-hidden="true" />Accept</>}</button>
      </span>
    </div>
    {noting ? <label className={css.reviewNoteField}><span>Note for {who} (optional)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} autoFocus placeholder="What this changed, or a thank-you" /></label> : null}
    {back ? <SendBack taskId={t.id} who={who} onClose={() => setBack(false)} /> : null}
  </div>;
}
function SendBack({ taskId, who, onClose }: { taskId: string; who: string; onClose: () => void }) {
  const router = useRouter(); const [text, setText] = useState(""), [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try { await post(`tasks/${taskId}/return`, { note: text.trim() }); notify({ id: "return", tone: "success", title: `Sent back to ${who}`, message: "They see your note at the top of the task.", timeout: 3000 }); onClose(); router.refresh(); }
    catch (e) { notify({ id: "return", tone: "error", title: "Not sent back", message: msg(e) }); } finally { setBusy(false); }
  }
  return <Modal title={`Send back to ${who}`} sub="Say what still needs doing. It goes back to Doing with your note on top." onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || text.trim().length < 3} onClick={() => void send()}>Send back</button></div>}>
    <div className={css.dialogPad}><label className={styles.field}>What still needs doing?<textarea className={styles.input} style={{ height: 88, paddingTop: 6 }} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} autoFocus /></label></div>
  </Modal>;
}

/** The reviewer's warning: finished while subtasks were still open (or one was reopened after). */
function OpenWarning({ d, open }: { d: Detail; open: Task[] }) {
  const router = useRouter(); const life = d.life as Life; const [busy, setBusy] = useState(false);
  const flag: Flag | undefined = life.flags[0];
  const list = open.length ? open.map((c) => ({ id: c.id, title: c.title })) : flag?.detail.open ?? [];
  async function seen() {
    setBusy(true);
    try { await post(`tasks/${d.task.id}/flags/resolve`, {}); notify({ id: "flag", tone: "success", title: "Marked as seen", timeout: 2000 }); router.refresh(); }
    catch (e) { notify({ id: "flag", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  return <div className={css.warn} role="note">
    <AlertTriangle size={16} aria-hidden="true" />
    <div><b>{flag?.cause === "reopened" ? "A subtask was reopened after this was finished" : `Finished with ${list.length === 1 ? "a subtask" : `${list.length} subtasks`} still open`}</b>
      <ul>{list.slice(0, 5).map((c) => <li key={c.id}><Link href={`/tasks/${c.id}`}>{c.title}</Link></li>)}{list.length > 5 ? <li>…and {list.length - 5} more</li> : null}</ul>
      <small>Accept it anyway, or send it back so they are finished, moved out or cancelled first.</small></div>
    {flag ? <button type="button" className={css.linkBtn} disabled={busy} onClick={() => void seen()}><Eye size={13} aria-hidden="true" />Mark as seen</button> : null}
  </div>;
}

// ------------------------------------------------------------------------------------------------ open subtasks
/** Open subtasks standing between a task and Done, each with one tap: Finish, Move out (it stays in the project as a
 *  task of its own) or Cancel with a note. */
export function OpenSubtasks({ items, onAllClosed, canAct = true }: { items: Pick<Task, "id" | "title" | "status" | "assigneeName" | "assigneeId" | "assigneePhotoAt">[]; onAllClosed?: () => void; canAct?: boolean }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(() => new Set()), [busy, setBusy] = useState<string | null>(null), [cancelling, setCancelling] = useState<string | null>(null), [note, setNote] = useState("");
  const left = items.filter((c) => !gone.has(c.id));
  async function act(id: string, path: string, body: Record<string, unknown>, ok: string) {
    setBusy(id);
    try {
      await post(path, body); const next = new Set(gone).add(id); setGone(next); setCancelling(null); setNote("");
      notify({ id: "sub", tone: "success", title: ok, timeout: 1800 });
      if (items.every((c) => next.has(c.id))) onAllClosed?.();
      router.refresh();
    } catch (e) { notify({ id: "sub", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(null); }
  }
  if (!left.length) return <p className={css.allClear}><Check size={14} aria-hidden="true" />Every subtask is closed.</p>;
  return <ul className={css.openSubs} aria-label="Open subtasks">{left.map((c) => <li key={c.id}>
    {c.assigneeName ? <Avatar name={c.assigneeName} id={c.assigneeId ?? undefined} photoAt={c.assigneePhotoAt} size={22} /> : <span />}
    <Link href={`/tasks/${c.id}`}>{c.title}</Link>
    {canAct ? cancelling === c.id ? <form className={css.cancelForm} onSubmit={(e) => { e.preventDefault(); void act(c.id, `tasks/${c.id}/move`, { status: "cancelled", note: note.trim() }, "Cancelled"); }}>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it is not needed" aria-label={`Why “${c.title}” is not needed`} autoFocus maxLength={500} required minLength={3} />
      <button type="submit" className={styles.btn} disabled={busy === c.id || note.trim().length < 3}>Cancel it</button>
      <button type="button" className={css.iconBtn} aria-label="Keep it" onClick={() => setCancelling(null)}><X size={14} /></button>
    </form> : <span className={css.subActions}>
      <button type="button" className={styles.btn} disabled={busy === c.id} onClick={() => void act(c.id, `tasks/${c.id}/move`, { status: "done" }, "Finished")}><Check size={13} aria-hidden="true" />Finish</button>
      <button type="button" className={styles.btn} disabled={busy === c.id} onClick={() => void act(c.id, `tasks/${c.id}`, { parentId: null }, "Moved out: it is a task of its own")} title="Keep it as a task of its own in the same project"><CornerUpLeft size={13} aria-hidden="true" />Move out</button>
      <button type="button" className={styles.btn} disabled={busy === c.id} onClick={() => { setCancelling(c.id); setNote(""); }}><X size={13} aria-hidden="true" />Cancel…</button>
    </span> : <small>{c.status === "in_progress" ? "Doing" : c.status === "blocked" ? "Blocked" : "To do"}</small>}
  </li>)}</ul>;
}

// ------------------------------------------------------------------------------------------------ the queue
type Queue = { rows: ReviewRow[]; policy: ReviewPolicy; quality: { value: string; label: string }[]; me: string };
/** Work → Reviews: everything waiting for the viewer's review, oldest first, with who, how it went and how long it has
 *  waited; accept one with a rating, or select several and accept them at once (leadership's work is acknowledged). */
export function ReviewQueue({ initial }: { initial: Queue }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial.rows); const [base, setBase] = useState(initial.rows);
  if (base !== initial.rows) { setBase(initial.rows); setRows(initial.rows); }
  const [picked, setPicked] = useState<Set<string>>(() => new Set()), [quality, setQuality] = useState<Record<string, string>>({}), [bulkQ, setBulkQ] = useState(defaultQuality(initial.policy));
  const [busy, setBusy] = useState(false), [aboveOf, setAboveOf] = useState<Record<string, boolean>>({});
  const all = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const pickedRows = rows.filter((r) => picked.has(r.id));
  async function one(r: ReviewRow) {
    setBusy(true);
    try {
      await post<{ kind?: string }>(`tasks/${r.id}/accept`, r.leaderWork && initial.policy.reviewLeaders !== "review" ? { acknowledge: true } : { quality: quality[r.id] ?? defaultQuality(initial.policy), above: !!aboveOf[r.id] });
      setRows((x) => x.filter((y) => y.id !== r.id)); setPicked((p) => { const n = new Set(p); n.delete(r.id); return n; });
      notify({ id: "review", tone: "success", title: `Accepted · ${first(r.assigneeName)}`, message: r.title, timeout: 2500 });
    } catch (e) { notify({ id: "review", tone: "error", title: "Not accepted", message: msg(e) }); } finally { setBusy(false); }
  }
  async function bulk() {
    setBusy(true);
    try {
      const r = await post<{ accepted: number; acknowledged: number; failed: { id: string; title: string | null; error: string }[] }>("tasks/reviews/bulk", { ids: [...picked], quality: bulkQ });
      const failed = new Set(r.failed.map((f) => f.id));
      setRows((x) => x.filter((y) => !picked.has(y.id) || failed.has(y.id))); setPicked(new Set(failed));
      notify({ id: "review", tone: r.failed.length ? "info" : "success", title: [r.accepted ? `${r.accepted} accepted` : null, r.acknowledged ? `${r.acknowledged} acknowledged` : null].filter(Boolean).join(" · ") || "Nothing accepted",
        message: r.failed.length ? `${r.failed.length} not: ${r.failed[0].error}` : undefined, timeout: 4000 });
      router.refresh();
    } catch (e) { notify({ id: "review", tone: "error", title: "Not accepted", message: msg(e) }); } finally { setBusy(false); }
  }
  if (!rows.length) return <div className={css.queueEmpty}><BadgeCheck size={28} aria-hidden="true" /><b>All caught up</b><span>Nothing waits for your review. Finished work lands here, oldest first.</span></div>;
  const old = rows.filter((r) => (r.waitedHours ?? 0) >= initial.policy.reviewNudgeHours).length;
  return <section className={css.queue} aria-label="Waiting for your review">
    <div className={css.queueHead}>
      <label className={css.pickAll}><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /><span>{rows.length} waiting{old ? <> · <b className={css.overdue}>{old} for over {initial.policy.reviewNudgeHours} h</b></> : null}</span></label>
      {picked.size ? <span className={css.bulk}>
        {pickedRows.some((r) => !r.leaderWork || initial.policy.reviewLeaders === "review") ? <Rating label="Rating for the selected" options={initial.quality} value={bulkQ} onChange={setBulkQ} size="sm" hideLabel /> : null}
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void bulk()}><Check size={14} aria-hidden="true" />Accept {picked.size}</button>
      </span> : <HelpHint label="Accepting several">Select several to accept them at once with one rating. Leadership’s work is acknowledged, not rated.</HelpHint>}
    </div>
    <ul className={css.queueList}>{rows.map((r) => {
      const ack = r.leaderWork && initial.policy.reviewLeaders !== "review";
      return <li key={r.id} data-picked={picked.has(r.id) ? "" : undefined} data-old={(r.waitedHours ?? 0) >= initial.policy.reviewNudgeHours ? "" : undefined}>
        <input type="checkbox" checked={picked.has(r.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} aria-label={`Select “${r.title}”`} />
        <Avatar name={r.assigneeName ?? "Someone"} id={r.assigneeId ?? undefined} photoAt={r.doerPhotoAt} size={34} />
        <div className={css.queueMain}>
          <Link href={`/tasks/${r.id}`}>{r.title}</Link>
          <span className={css.queueMeta}><b>{first(r.assigneeName)}</b> finished it{r.timing ? <span className={css.timing} data-key={r.timing.key}>{r.timing.words}</span> : null}
            {r.waited ? <span className={css.waited} data-long={(r.waitedHours ?? 0) >= initial.policy.reviewNudgeHours ? "" : undefined}>waiting {r.waited}</span> : null}
            {r.projectName ? <span>{r.projectName}</span> : null}
            {r.flags || r.openChildren ? <span className={css.flagChip}><AlertTriangle size={12} aria-hidden="true" />{r.openChildren || "some"} subtask{r.openChildren === 1 ? "" : "s"} open</span> : null}
            {ack ? <span className={css.ackChip}>acknowledge</span> : null}</span>
        </div>
        <span className={css.queueAct}>
          {ack ? null : <AcceptChoice scale={initial.policy.reviewScale} label={`How was “${r.title}”?`} quality={quality[r.id] ?? defaultQuality(initial.policy)} setQuality={(v) => setQuality((q) => ({ ...q, [r.id]: v }))}
            above={!!aboveOf[r.id]} setAbove={(b) => setAboveOf((x) => ({ ...x, [r.id]: b }))} size="sm" />}
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void one(r)}>{ack ? <><BadgeCheck size={14} aria-hidden="true" />Accept</> : <><Check size={14} aria-hidden="true" />Accept</>}</button>
        </span>
      </li>;
    })}</ul>
  </section>;
}

/** A small "above and beyond" sparkle for accepted work in lists. */
export function AboveMark() { return <span className={css.above}><Sparkles size={12} aria-hidden="true" />above and beyond</span>; }
