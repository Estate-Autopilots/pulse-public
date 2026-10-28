"use client";
// TASKS-P0: the task page's working parts. One primary action per role (the doer starts or finishes, the reviewer
// accepts or sends back, everyone else follows or asks to join) with the rest in a "…" menu; the notes' numbered steps
// as a checklist with deep links into Pulse and buttons for links; Pip's plan; the same work elsewhere.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Bell, BellOff, Check, CircleDot, Copy, FolderKanban, Hand, Hourglass, Link2, ListChecks, MapPin, MessageSquare, MoreHorizontal, Pencil, Play, Repeat, RotateCcw, Sparkles, Trash2, Undo2, UserPlus, Wand2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { links, nextUp, parseNotes } from "../lib/task-sense.mjs";
import { goHref, placesIn } from "../destinations/registry.mjs";
import { keepTask } from "../destinations/go";
import { EditDialog, ProofForm, celebrate } from "./client";
import { AssignDialog, MoveDialog, PeopleDialog } from "./task-people";
import { DeleteDialog } from "./delete";
import { AskDialog } from "./work-client";
import { OpenSubtasks } from "./life";
import type { Detail, Options, Plan } from "./types";
import css from "./focus.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];

// ------------------------------------------------------------------------------------------------ actions
type Open = null | "done" | "give" | "edit" | "ask" | "block" | "move" | "people" | "delete" | "cancel" | "changes";
/** The one thing this viewer does next, and everything else in a menu. */
export function TaskActions({ d, options, next, finishNow, repeat, client }: { d: Detail; options: Options | null; /** E2E-4P: a client's seat: only the doer's own steps, no staff tools. */ client?: boolean; next?: { id: string; title: string } | null; /** TASKS-4B: open "Mark done" at once (?finish=1). */ finishNow?: boolean; /** UX-5B: "day" | "week" | "month" when the task repeats. */ repeat?: string | null }) {
  const router = useRouter(); const t = d.task;
  const [open, setOpen] = useState<Open>(null), [busy, setBusy] = useState(false), [watching, setWatching] = useState(d.watching);
  // ?finish=1 (a parent with open subtasks ticked elsewhere): open "Mark done" once the page is live, never during the
  // server render (the dialog lives in a portal, so rendering it there broke hydration).
  const finishable = !!finishNow && !["done", "in_review", "accepted", "cancelled"].includes(t.status);
  useEffect(() => { if (!finishable) return; const f = requestAnimationFrame(() => setOpen("done")); return () => cancelAnimationFrame(f); }, [finishable]);
  const me = d.me, doer = !!me && me === t.assigneeId;
  const finished = ["done", "in_review", "accepted", "cancelled"].includes(t.status);
  async function move(status: string, note?: string) {
    setBusy(true);
    try {
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${t.id}/move`, { status, note });
      if (status === "done" && client) notify({ id: "step", tone: "success", title: "Approved", message: `${t.reviewerName ?? "The team"} is told.`, timeout: 3000 });
      else if (status === "done") {
        // Next up: the doer's next task by urgency × value, offered gently with the celebration.
        let after = next ?? null;
        if (!after && doer) { const home = await fetch("/api/v0/tasks/home").then((x) => x.ok ? x.json() : null).catch(() => null); after = home ? nextUp(home.rows ?? [], t.id) : null; }
        celebrate(r, t.title, after);
      }
      router.refresh();
    }
    catch (e) { notify({ id: "step", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  async function act(path: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try { await post(path, body); notify({ id: "task-act", tone: "success", title: ok, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "task-act", tone: "error", title: "Not done", message: msg(e) }); } finally { setBusy(false); }
  }
  async function follow(on: boolean) { setBusy(true); try { await post("work/watch", { taskId: t.id, on }); setWatching(on); router.refresh(); } catch (e) { notify({ id: "watch", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); } }
  const primary = (label: string, icon: ReactNode, run: () => void, tone: "primary" | "plain" = "primary") =>
    <button type="button" className={`${styles.btn}${tone === "primary" ? ` ${styles.btnPrimary}` : ""} ${css.primary}`} disabled={busy} onClick={run}>{icon}{label}</button>;

  // The primary action by role.
  let main: ReactNode = null; let aside: ReactNode = null; let followIsMain = false;
  // SIM-CLIENTS R132: a task given to a client (approve a reel, a post, a brochure) is answered with Approve or Ask for
  // changes: no Start, no proof sheet. Approve marks it done for the team's review; changes go to the team as a comment.
  if (client && doer && !finished) {
    main = primary("Approve", <Check size={15} />, () => move("done", "Approved"));
    aside = primary("Ask for changes", <MessageSquare size={15} />, () => setOpen("changes"), "plain");
  }
  // TASKS-4B: the reviewer's Accept / Send back live in the review bar under the banner ("Review Kedab's work").
  else if (d.can.accept) { /* the review bar */ }
  else if (doer && !finished) {
    if (t.status === "in_progress") main = primary(t.requiresProof && !d.proof.length ? "Mark done (with proof)" : "Mark done", <Check size={15} />, () => setOpen("done"));
    else if (t.status === "blocked" && !d.blockedBy.length) main = primary("Unblock", <Play size={15} />, () => move(t.startedAt ? "in_progress" : "open"));
    // Owner workbench (21 Oct 2026): a blocked task says what it waits on once, in the banner (the note here repeated it
    // and squeezed the banner into a column).
    else if (t.status === "blocked") aside = null;
    else main = primary("Start", <Play size={15} />, () => move("in_progress"));
  } else if (doer && finished) { /* the banner says who it waits for, or how it was accepted */ }
  else if (d.can.take) main = primary(t.poolScope && !t.assigneeId ? "Claim" : "Take it", <Hand size={15} />, () => act(`tasks/${t.id}/take`, {}, t.poolScope ? "Claimed: it’s yours" : "It’s yours"));
  else if (me) {
    main = watching ? null : primary("Follow", <Bell size={15} />, () => follow(true), d.can.join ? "plain" : "primary"); followIsMain = !watching;
    if (d.can.join) aside = primary("Ask to join", <UserPlus size={15} />, () => act("work/asks", { kind: "join", taskId: t.id }, "Asked to join: the owner answers"));
  }

  // Everything else.
  const items: { key: string; label: string; icon: ReactNode; run: () => void; danger?: boolean }[] = [];
  if (doer && !finished && t.status !== "in_progress") items.push({ key: "done", label: "Mark done", icon: <Check size={14} />, run: () => setOpen("done") });
  if (d.can.edit && !finished && !doer) {
    if (t.status !== "in_progress") items.push({ key: "doing", label: "Move to Doing", icon: <CircleDot size={14} />, run: () => move("in_progress") });
    items.push({ key: "done", label: "Mark done", icon: <Check size={14} />, run: () => setOpen("done") });
  }
  if (d.can.edit && !finished && t.status !== "open" && t.status !== "cancelled") items.push({ key: "todo", label: "Back to To do", icon: <RotateCcw size={14} />, run: () => move("open") });
  // TASKS-4B: finished work reopens deliberately (the reviewer sends it back with a note instead).
  if (d.can.edit && !d.can.accept && (t.status === "done" || t.status === "in_review" || t.status === "cancelled")) items.push({ key: "reopen", label: t.status === "cancelled" ? "Reopen" : "Reopen: not done yet", icon: <RotateCcw size={14} />, run: () => move("in_progress") });
  if (d.can.edit && !finished && t.status !== "cancelled") items.push({ key: "cancel", label: "Cancel the task…", icon: <Undo2 size={14} />, run: () => setOpen("cancel") });
  if (d.can.edit && !finished && t.status !== "blocked") items.push({ key: "block", label: "Mark blocked…", icon: <Hourglass size={14} />, run: () => setOpen("block") });
  if (d.can.edit) items.push({ key: "edit", label: "Edit", icon: <Pencil size={14} />, run: () => setOpen("edit") });
  // TASKS-3: everyone can be chosen; someone outside the viewer's reach is asked rather than refused.
  if (d.can.edit && !finished) items.push({ key: "give", label: "Change who does it…", icon: <Hand size={14} />, run: () => setOpen("give") });
  if (d.can.edit) items.push({ key: "move", label: "Move to project…", icon: <FolderKanban size={14} />, run: () => setOpen("move") });
  // UX-5B: repeating work is a template: the next one is made when this one is finished.
  if (d.can.edit && !finished) {
    if (repeat) items.push({ key: "repeat-off", label: `Stop repeating (every ${repeat})`, icon: <Repeat size={14} />, run: () => act(`tasks/${t.id}/repeat`, { every: null }, "It no longer repeats") });
    else for (const every of ["week", "month"] as const) items.push({ key: `repeat-${every}`, label: `Repeat every ${every}`, icon: <Repeat size={14} />, run: () => act(`tasks/${t.id}/repeat`, { every }, `Repeats every ${every}: the next one comes when this is done`) });
  }
  if (d.can.edit && !finished) items.push({ key: "people", label: "Add people…", icon: <UserPlus size={14} />, run: () => setOpen("people") });
  if (d.can.ask) items.push({ key: "ask", label: "Ask someone to take it", icon: <UserPlus size={14} />, run: () => setOpen("ask") });
  if (d.can.release) items.push({ key: "release", label: "Put it back in the pool", icon: <Undo2 size={14} />, run: () => act(`work/pool/${t.id}/release`, {}, "Back in the pool") });
  if (me && watching) items.push({ key: "unfollow", label: "Stop following", icon: <BellOff size={14} />, run: () => follow(false) });
  else if (me && !followIsMain && !doer) items.push({ key: "follow", label: "Follow", icon: <Bell size={14} />, run: () => follow(true) });
  items.push({ key: "copy", label: "Copy link", icon: <Link2 size={14} />, run: () => { void navigator.clipboard?.writeText(window.location.href.split("?")[0]).then(() => notify({ id: "copy", tone: "success", title: "Link copied", timeout: 1800 })); } });
  // TASKS-3: whoever created it, an admin or the project's owner deletes it (after seeing what is connected).
  if (d.can.delete) items.push({ key: "delete", label: "Delete…", icon: <Trash2 size={14} />, run: () => setOpen("delete"), danger: true });

  // E2E-4P: a client keeps their own steps and the link; the staff tools (people, projects, repeats, pool) are not theirs.
  const shown = client ? items.filter((i) => [...(doer ? [] : ["doing", "done"]), "copy", "follow", "unfollow"].includes(i.key)) : items;
  return <div className={css.actions} role="group" aria-label="Status">
    {main}{aside}
    {shown.length ? <Menu label="More actions" items={shown} /> : null}
    {open === "done" ? <DoneDialog d={d} onClose={() => setOpen(null)} onDone={(note) => { setOpen(null); void move("done", note); }} /> : null}
    {open === "changes" ? <NoteDialog title="Ask for changes" label="What should change? The team sees this and comes back to you." action="Send" required onClose={() => setOpen(null)}
      onSave={(note) => { setOpen(null); void act("work/comments", { taskId: t.id, body: `Changes asked: ${note}`, mentions: [t.reviewerId].filter(Boolean) }, `${t.reviewerName ?? "The team"} has your changes`); }} /> : null}
    {open === "block" ? <NoteDialog title="Mark blocked" label="What is it waiting for? (optional)" action="Mark blocked" onClose={() => setOpen(null)} onSave={(note) => { setOpen(null); void move("blocked", note); }} /> : null}
    {open === "cancel" ? <NoteDialog title="Cancel this task?" label="Why is it not needed? (everyone on it sees this)" action="Cancel the task" required onClose={() => setOpen(null)} onSave={(note) => { setOpen(null); void move("cancelled", note); }} /> : null}
    {open === "give" ? <AssignDialog taskId={t.id} current={t.assigneeId} onClose={() => setOpen(null)} /> : null}
    {open === "delete" ? <DeleteDialog taskId={t.id} onClose={() => setOpen(null)} /> : null}
    {open === "move" ? <MoveDialog ids={[t.id]} current={t.projectId} onClose={() => setOpen(null)} /> : null}
    {open === "people" ? <PeopleDialog taskId={t.id} exclude={[t.assigneeId, t.reviewerId, ...d.members.filter((m) => m.role === "collaborator").map((m) => m.id)].filter((x): x is string => !!x)} onClose={() => setOpen(null)} /> : null}
    {open === "edit" ? <EditDialog detail={d} reviewers={options?.reviewers ?? []} onClose={() => setOpen(null)} /> : null}
    {open === "ask" ? <AskDialog kind="take" taskId={t.id} exclude={t.assigneeId ? [t.assigneeId] : []} onClose={() => setOpen(null)} /> : null}
  </div>;
}

/** A "…" button with a small menu. */
export function Menu({ label, items }: { label: string; items: { key: string; label: string; icon?: ReactNode; run: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false); const [up, setUp] = useState(false); const wrap = useRef<HTMLDivElement>(null);
  // QA-BULK: on a phone the status bar sits low on the screen, above the tab bar; the menu opens upward when there is
  // not room for it below (it used to open under the tab bar, out of reach).
  const toggle = () => {
    if (!open && wrap.current) {
      const r = wrap.current.getBoundingClientRect(); const nav = document.querySelector('nav[aria-label="Mobile navigation"]')?.getBoundingClientRect();
      const floor = nav && nav.height ? Math.min(window.innerHeight, nav.top) : window.innerHeight;
      setUp(floor - r.bottom < 380 && r.top > floor - r.bottom);
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); wrap.current?.querySelector<HTMLElement>("button")?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]; const i = all.indexOf(document.activeElement as HTMLElement);
        e.preventDefault(); all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
      }
    };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", key);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  if (!items.length) return null;
  return <div className={css.menuWrap} ref={wrap}>
    <button type="button" className={css.menuBtn} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={toggle}><MoreHorizontal size={18} /></button>
    {open ? <div className={css.menu} role="menu" aria-label={label} data-up={up ? "" : undefined}>{items.map((i) => <button key={i.key} type="button" role="menuitem" data-danger={i.danger ? "" : undefined} onClick={() => { setOpen(false); i.run(); }}>{i.icon}{i.label}</button>)}</div> : null}
  </div>;
}

/** Mark done, with proof: attach a link or file here first (required when the project asks for proof). */
function DoneDialog({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (note?: string) => void }) {
  const needs = !!d.task.requiresProof && !d.proof.length;
  // TASKS-4B: open subtasks come first; each is finished, moved out or cancelled with a note right here.
  const open = d.children.filter((c) => ["open", "in_progress", "blocked", "unknown"].includes(c.status));
  const [clear, setClear] = useState(open.length === 0);
  return <Modal title="Mark done" sub={!clear ? `${open.length === 1 ? "One subtask is" : `${open.length} subtasks are`} still open. Finish, move out or cancel ${open.length === 1 ? "it" : "each"} first.`
      : needs ? "This project needs proof before acceptance: attach a link or a file first." : "Add proof if you have it: a link or a file makes acceptance quick."} onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={needs || !clear} onClick={() => onDone()}><Check size={14} />Mark done</button></div>}>
    <div className={css.dialogPad}>
      {open.length ? <OpenSubtasks items={open} onAllClosed={() => setClear(true)} /> : null}
      {d.proof.length ? <p className={css.note}>{d.proof.length === 1 ? "1 proof attached" : `${d.proof.length} proofs attached`}: {d.proof.map((p) => p.label).join(", ")}</p> : null}
      {/* With subtasks open the subtitle speaks of them, so the proof fields say what they are for. */}
      {open.length && !d.proof.length ? <p className={css.note}>{needs ? "This project needs proof before acceptance: a link or a file." : "Proof, if you have it: a link or a file makes acceptance quick."}</p> : null}
      <ProofForm taskId={d.task.id} />
    </div>
  </Modal>;
}
function NoteDialog({ title, label, action, required, onClose, onSave }: { title: string; label: string; action: string; required?: boolean; onClose: () => void; onSave: (note: string) => void }) {
  const [text, setText] = useState("");
  return <Modal title={title} onClose={onClose} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
    <button form="note-dialog" className={`${styles.btn} ${styles.btnPrimary}`} disabled={required && text.trim().length < 3}>{action}</button></div>}>
    <form id="note-dialog" className={styles.form} onSubmit={(e) => { e.preventDefault(); onSave(text.trim()); }}>
      <label className={styles.field}>{label}<input value={text} onChange={(e) => setText(e.target.value)} autoFocus maxLength={1000} required={required} minLength={required ? 3 : 0} /></label>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------------------------------------ how to finish
/** Text with its links as small buttons. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"“”]+)/g);
  return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <a key={i} className={css.inlineLink} href={p.replace(/[).,;:!?]+$/, "")} target="_blank" rel="noreferrer">{links(p)[0]?.label ?? "link"}<ArrowUpRight size={11} aria-hidden="true" /></a> : <Fragment key={i}>{p}</Fragment>)}</>;
}

/** What the notes say to do: numbered steps to tick, places in Pulse and links as buttons, and Pip's plan. */
export function HowToFinish({ taskId, notes, checks, canTick, plan, canPlan, canEdit }: { taskId: string; notes: string | null; checks: { key: string; label: string }[]; canTick: boolean; plan: Plan | null; canPlan: boolean; /** DATUP-TASKS: may write the description here. */ canEdit?: boolean }) {
  const router = useRouter();
  const [writing, setWriting] = useState(false), [draft, setDraft] = useState(""), [saving, setSaving] = useState(false);
  const parsed = useMemo(() => parseNotes(notes), [notes]);
  const [done, setDone] = useState(() => new Set(checks.map((c) => c.key)));
  const [base, setBase] = useState(checks);
  if (base !== checks) { setBase(checks); setDone(new Set(checks.map((c) => c.key))); }
  // UX-5B: a place in the notes opens with its spotlight, and the task stays with the person in the companion.
  const go = useMemo(() => placesIn(notes ?? "").map((p) => ({ label: p.label, href: goHref(p.dest, taskId) })), [notes, taskId]), out = useMemo(() => links(notes), [notes]);
  const ticked = parsed.steps.filter((s) => done.has(s.key)).length;
  async function tick(key: string, label: string, on: boolean) {
    const before = new Set(done); const after = new Set(done); if (on) after.add(key); else after.delete(key); setDone(after);
    try { await post(`tasks/${taskId}/checks`, { key, label, done: on }); if (on && after.size >= parsed.steps.length && parsed.steps.length > 1) notify({ id: "steps", tone: "success", title: "Every step ticked", message: "Mark the task done when it is.", timeout: 3000 }); router.refresh(); }
    catch (e) { setDone(before); notify({ id: "steps", tone: "error", title: "Not saved", message: msg(e) }); }
  }
  const empty = !parsed.intro.length && !parsed.steps.length && !parsed.outro.length;
  async function saveNotes() {
    if (!draft.trim()) return; setSaving(true);
    try { await post(`tasks/${taskId}`, { notes: draft.trim() }); setWriting(false); router.refresh(); }
    catch (e) { notify({ id: "task-notes", tone: "error", title: "Details not saved", message: msg(e) }); } finally { setSaving(false); }
  }
  // DATUP-TASKS (Datup, 20 Oct: "clean, not cluttered"): a task with nothing written is one quiet line, not an empty card.
  if (empty && !go.length && !out.length && !writing) return <div className={css.line} aria-label="Details">
    <ListChecks size={15} aria-hidden="true" /><h3>Details</h3><span>Nothing written yet.</span>
    <span className={css.lineActions}>{canEdit ? <button type="button" className={css.jumpBtn} data-external="" onClick={() => { setDraft(""); setWriting(true); }}><Pencil size={13} aria-hidden="true" /><span>Add details</span></button> : null}
      {canPlan ? <PlanWithPip taskId={taskId} initial={plan} /> : null}</span>
  </div>;
  if (writing) return <section className={css.card} aria-label="Details">
    <div className={css.cardHead}><h2><ListChecks size={17} aria-hidden="true" />Details</h2></div>
    <div className={css.cardBody}>
      <textarea className={css.notesBox} value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} maxLength={4000} autoFocus aria-label="Details"
        placeholder="What it is about, the context, links. Lines starting 1. 2. 3. become steps to tick."
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveNotes(); } }} />
      <div className={css.jump}><button type="button" className={styles.btn} onClick={() => setWriting(false)} disabled={saving}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void saveNotes()} disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Save details"}</button></div>
    </div>
  </section>;
  return <section className={css.card} aria-labelledby="how-to-finish">
    <div className={css.cardHead}><h2 id="how-to-finish"><ListChecks size={17} aria-hidden="true" />How to finish</h2>
      {parsed.steps.length ? <small>{ticked} of {parsed.steps.length} steps</small> : null}</div>
    <div className={css.cardBody}>
      {parsed.steps.length ? <div className={css.progress} aria-hidden="true"><i style={{ width: `${Math.round((ticked / parsed.steps.length) * 100)}%` }} /></div> : null}
      {parsed.intro.map((line, i) => <p key={`i${i}`}><Linked text={line} /></p>)}
      {parsed.steps.length ? <ol className={css.checklist} aria-label="Steps">{parsed.steps.map((s) => {
        const on = done.has(s.key);
        return <li key={s.key} data-done={on ? "" : undefined}>
          <button type="button" role="checkbox" aria-checked={on} className={css.tick} disabled={!canTick} onClick={() => tick(s.key, s.text, !on)} aria-label={`Step ${s.n}: ${s.text}`}><Check size={14} strokeWidth={3} /></button>
          <span className={css.stepText}><b>{s.n}.</b><Linked text={s.text} /></span>
        </li>;
      })}</ol> : null}
      {parsed.outro.map((line, i) => <p key={`o${i}`}><Linked text={line} /></p>)}
      {empty ? <p className={css.note}>No steps written yet. {canPlan ? "Pip can suggest them." : ""}</p> : null}
      {go.length || out.length ? <div className={css.jump}>
        {go.map((p) => <Link key={p.label} className={css.jumpBtn} href={p.href} onClick={() => keepTask(taskId)}><MapPin size={14} aria-hidden="true" /><span>Open {p.label}</span></Link>)}
        {out.map((l) => <a key={l.href} className={css.jumpBtn} data-external="" href={l.href} target="_blank" rel="noreferrer"><ArrowUpRight size={14} aria-hidden="true" /><span>{l.label}</span></a>)}
      </div> : null}
      {canPlan ? <PlanWithPip taskId={taskId} initial={plan} /> : null}
    </div>
  </section>;
}

// ------------------------------------------------------------------------------------------------ Pip
/** Steps, the fastest path, who to ask and a message to copy. Pip never sends anything. */
export function PlanWithPip({ taskId, initial }: { taskId: string; initial: Plan | null }) {
  const [plan, setPlan] = useState<Plan | null>(initial), [busy, setBusy] = useState(false), [shown, setShown] = useState(!!initial?.fresh);
  async function ask(refresh = false) {
    setBusy(true);
    try { const r = await post<{ plan: Plan }>(`tasks/${taskId}/plan`, { refresh }); setPlan(r.plan); setShown(true); }
    catch (e) { notify({ id: "pip-plan", tone: "error", title: "Pip could not plan this", message: msg(e) }); } finally { setBusy(false); }
  }
  if (!plan || !shown) return <div className={css.jump}>
    <button type="button" className={css.jumpBtn} onClick={() => plan && plan.fresh ? setShown(true) : ask()} disabled={busy} aria-expanded={false}><Wand2 size={14} aria-hidden="true" /><span>{busy ? "Pip is planning…" : plan ? "Show Pip’s plan" : "Plan it with Pip"}</span></button>
  </div>;
  return <div className={css.pip} aria-label="Pip’s plan" role="region">
    <div className={css.pipHead}><b><Sparkles size={15} aria-hidden="true" />Pip’s plan</b><small>{plan.fresh ? "Kept for this task" : "From before the task changed"} · <button type="button" className={css.textBtn} onClick={() => ask(true)} disabled={busy}>{busy ? "planning…" : "plan again"}</button></small></div>
    <p className={css.note} style={{ margin: 0 }}>{plan.summary}</p>
    {!plan.fromNotes && plan.steps.length ? <div><h4>Suggested steps</h4><ol>{plan.steps.map((s, i) => <li key={i}>{s.text}</li>)}</ol></div> : null}
    {plan.fastest.length ? <div><h4>Fastest path</h4><ul>{plan.fastest.map((f, i) => <li key={i}>{f}</li>)}</ul></div> : null}
    {plan.ask.length ? <div><h4>Who to ask</h4><ul className={css.askList}>{plan.ask.map((a) => <li key={a.id}><Avatar name={a.name} id={a.id} size={22} /><span><b>{a.name}</b> <small>· {a.why}</small></span></li>)}</ul></div> : null}
    {plan.message ? <div><h4>Ready to copy{plan.message.to ? ` · ${plan.message.channel} to ${first(plan.message.to)}` : ""}</h4>
      <pre className={css.message}>{plan.message.text}</pre>
      <div className={css.messageFoot}><span>Pip never sends anything. Fill the blanks (____) and send it yourself.</span>
        <button type="button" className={styles.btn} onClick={() => { void navigator.clipboard?.writeText(plan.message!.text).then(() => notify({ id: "copy", tone: "success", title: "Message copied", message: "Paste it into WhatsApp.", timeout: 2500 }), () => notify({ id: "copy", tone: "error", title: "Not copied", message: "Select the text and copy it." })); }}><Copy size={13} aria-hidden="true" />Copy message</button></div></div> : null}
  </div>;
}

// ------------------------------------------------------------------------------------------------ the same work
/** "Looks like the same work as …": link them, merge one into the other, or say they differ. Never automatic. */
export function SameWork({ taskId, same, canDecide }: { taskId: string; same: NonNullable<Detail["same"]>; canDecide: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [merging, setMerging] = useState<string | null>(null);
  async function decide(path: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try { await post(path, body); notify({ id: "same", tone: "success", title: ok, timeout: 3000 }); setMerging(null); router.refresh(); }
    catch (e) { notify({ id: "same", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  return <>{same.map((s) => <div key={s.id} className={css.same} role="note">
    <span>{s.state === "merged" ? "Merged with " : s.state === "linked" ? "The same work as " : "Looks like the same work as "}<Link href={`/tasks/${s.id}`}>“{s.title}”</Link>{s.projectName ? ` in ${s.projectName}` : ""}{s.state === "linked" ? " (linked)." : s.state === "merged" ? "." : ". Pulse never merges on its own."}</span>
    {canDecide && !s.state ? <span className={css.actions}>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => decide(`tasks/${taskId}/same`, { otherId: s.id, state: "linked" }, "Linked as the same work")}><Link2 size={13} />Link them</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => setMerging(s.id)}>Merge into this…</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => decide(`tasks/${taskId}/same`, { otherId: s.id, state: "dismissed" }, "Kept apart")}>Not the same</button></span> : null}
    {canDecide && s.state === "linked" ? <span className={css.actions}><button type="button" className={styles.btn} disabled={busy} onClick={() => setMerging(s.id)}>Merge into this…</button></span> : null}
    {merging === s.id ? <Modal title="Merge into this task?" sub={`“${s.title}” is cancelled with a note pointing here. Whatever waited on it now waits on this task, and its proof and ticked steps move here. Nothing else changes.`} onClose={() => setMerging(null)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setMerging(null)}>Keep both</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => decide(`tasks/${taskId}/merge`, { otherId: s.id }, "Merged")}>Merge</button></div>}><span /></Modal> : null}
  </div>)}</>;
}

