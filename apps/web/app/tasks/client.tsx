"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Ban, CalendarDays, Check, CircleCheck, Compass, CornerDownRight, Flag, FolderKanban, Hourglass, Inbox, Link2, ListTree, Paperclip, Pencil, Plus, Trophy, UserRound } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { AcceptDrawer } from "./accept";
import { ContextChip, DatePicker, Drawer, DrawerFooter, DrawerSection, PersonSelect, Segmented, Select } from "../kit";
import { useOrgZone } from "../org-code";
import { zoneDay } from "../lib/zone.mjs";
import { ProjectPicker, useWorkOptions } from "../create";
import { Avatar, styles } from "../ui";
import { PRIORITY, STATUS, Chip, doneText, dueText, shortDay } from "./parts";
import type { Blocker, Detail, Person, Task } from "./types";
import { SmartAdd } from "./smart-add";
import { armedClass, tickDone, tickProps, useArmedTask } from "./confirm-done";
import css from "./tasks.module.css";
import { DateField } from "../kit/date-field";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** A small, calm celebration: the circle pulses and a card says what the week looks like. No leaderboard. */
export function celebrate(r: { weekDone?: number; streak?: number; released?: number }, title: string, next?: { id: string; title: string } | null, undo?: () => void) {
  const week = r.weekDone ? `${r.weekDone} done this week` : "";
  const streak = r.streak && r.streak > 1 ? ` · ${r.streak}-week streak` : "";
  const freed = r.released ? ` · unlocked ${r.released === 1 ? "a waiting task" : `${r.released} waiting tasks`}` : "";
  // TASKS-P0: what to do next, gently: the next task by urgency × value, one tap away.
  const after = next ? ` · Next up: ${next.title.length > 44 ? `${next.title.slice(0, 43)}…` : next.title}` : "";
  // TASKS-3: a tick made by mistake is one tap to take back.
  notify({ id: "task-done", tone: "success", title: `Done: ${title.length > 48 ? `${title.slice(0, 47)}…` : title}`, message: `${week}${streak}${freed}${after}` || "Nice work.", timeout: next || undo ? 6500 : 4200,
    ...(undo ? { action: { label: "Undo", run: undo } } : next ? { href: `/tasks/${next.id}` } : {}) });
}

// --------------------------------------------------------------------------------------------- quick add
/** The quick-add line (TASKS-3: one input with live chips and suggestions; see smart-add.tsx). */
export function QuickAdd(props: { parentId?: string; projectId?: string; placeholder?: string; autoFocusKey?: boolean; label?: string; compact?: boolean }) {
  return <SmartAdd {...props} />;
}

// --------------------------------------------------------------------------------------------- one task row
export function TaskRow({ task, today, me, showAssignee = true, children, onChanged, domainOwner, hideProject }: { task: Task; today: string; me: string | null; showAssignee?: boolean; children?: ReactNode; onChanged?: () => void;
  /** Whose domains `inDomain` was matched against, when not the viewer's (a leader's view of one person). */ domainOwner?: string;
  /** TASKS-4B: leave out the project chip when it is the page's own (subtasks under their parent). */ hideProject?: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const finished = ["done", "accepted", "in_review"].includes(task.status) || state === "done";
  const due = dueText(task, today), when = finished ? doneText(task) : null;
  const st = STATUS[task.status] ?? STATUS.unknown;
  const asking = useArmedTask() === task.id, tick = tickProps(task.title, asking);
  async function done() {
    if (finished || state === "busy") return;
    // TASKS-4B: a task with open subtasks cannot be Done; its page shows them with Finish, Move out and Cancel.
    if (task.subtasksOpen) { notify({ id: "task-move", tone: "info", title: `Finish its ${task.subtasksOpen === 1 ? "open subtask" : `${task.subtasksOpen} open subtasks`} first`, message: "Each has Finish, Move out and Cancel.", timeout: 3500 }); router.push(`/tasks/${task.id}?finish=1`); return; }
    setState("busy");
    try {
      const before = task.status === "unknown" ? "open" : task.status;
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${task.id}/move`, { status: "done" });
      // EST-997: a tick made by mistake is one tap to take back here too.
      setState("done"); celebrate(r, task.title, null, () => { void post(`tasks/${task.id}/move`, { status: before }).then(() => { setState("idle"); onChanged?.(); router.refresh(); })
        .catch((e) => notify({ id: "undo", tone: "error", title: "Not undone", message: msg(e) })); });
      setTimeout(() => { onChanged?.(); router.refresh(); }, 650);
    } catch (e) { setState("idle"); notify({ id: "task-move", tone: "error", title: "Not marked done", message: msg(e) }); }
  }
  return <li className={css.row} data-leaving={state === "done" ? "" : undefined}>
    <button type="button" className={asking ? `${css.check} ${armedClass}` : css.check} data-done={finished ? "" : undefined} data-pop={state === "done" ? "" : undefined} data-armed={asking ? "" : undefined}
      onClick={() => task.subtasksOpen ? void done() : tickDone(task.id, task.title, () => void done())} disabled={finished || state === "busy" || !me}
      aria-label={finished ? `${task.title}: ${st.label}` : tick.label} title={finished ? st.label : tick.tip}><Check size={13} strokeWidth={3} /></button>
    <div className={css.rowMain}>
      <Link href={`/tasks/${task.id}`} className={css.title} data-done={finished ? "" : undefined} title={task.title}>{task.title}</Link>
      {task.parentId ? <span className={css.hierarchy}><CornerDownRight size={12} aria-hidden="true" /><span>Subtask of</span>{task.parentTitle
        ? <Link href={`/tasks/${task.parentId}`} title={task.parentTitle}>{task.parentTitle}</Link>
        : <span>another task</span>}</span> : null}
      <span className={css.meta}>
        {task.inDomain && !finished ? <Chip tone="accent" title={`${domainOwner ? `In ${domainOwner}’s` : "In your"} domain: ${task.inDomain.title}`}><Compass size={11} />{domainOwner ? `In ${domainOwner}’s domain` : "In your domain"}</Chip> : null}
        {task.poolScope && !task.assigneeId ? <Chip title="Nobody has it yet: anyone eligible can claim it"><Inbox size={11} />In the {task.poolScope === "company" ? "company" : task.poolRef} pool</Chip> : null}
        {task.priority === "urgent" || task.priority === "high" ? <Chip tone={task.priority === "urgent" ? "late" : "warning"}><Flag size={11} />{PRIORITY[task.priority]}</Chip> : null}
        {task.status !== "open" && !finished ? <Chip tone={st.tone === "danger" ? "late" : st.tone === "accent" ? "accent" : undefined}>{st.label}</Chip> : null}
        {task.status === "accepted" ? <Chip tone="success"><Trophy size={11} />Accepted</Chip> : task.status === "done" || task.status === "in_review" ? <Chip>{task.reviewerName ? `Waiting for ${task.reviewerName.split(" ")[0]}` : "Waiting for review"}</Chip> : null}
        {due && !finished ? <Chip tone={due.late ? "late" : undefined}><CalendarDays size={11} />{due.text}</Chip> : null}
        {when ? <Chip>{when}</Chip> : !due && task.workOn ? <Chip><CalendarDays size={11} />For {shortDay(task.workOn)}</Chip> : null}
        {task.projectName && task.projectId !== hideProject ? <Link href={`/tasks/projects/${task.projectId}`} title={task.projectName}><Chip><FolderKanban size={11} />{task.projectName}</Chip></Link> : task.projectName ? null : task.trackerProject ? <Chip title="The tracker names this; it is not linked to a project yet">#{task.trackerProject}</Chip> : null}
        {task.type ? <Chip>{task.type}</Chip> : null}
        {task.subtasks ? <Chip title={`Parent task · ${task.subtasksDone} of ${task.subtasks} subtasks done`}><ListTree size={11} aria-hidden="true" />{task.subtasksDone}/{task.subtasks} subtasks</Chip> : null}
        {task.openBlockers ? <Chip tone="late"><Hourglass size={11} />Waiting on {task.openBlockers}</Chip> : null}
        {task.proof ? <Chip><Paperclip size={11} />{task.proof}</Chip> : null}
      </span>
      {children}
    </div>
    <span className={css.end}>{showAssignee ? task.assigneeName ? <span title={task.assigneeName}><Avatar name={task.assigneeName} id={task.assigneeId ?? undefined} photoAt={task.assigneePhotoAt} size={24} status /></span> : <span className={styles.muted} title="Nobody has this yet">Open</span> : null}</span>
  </li>;
}

export function BlockerLines({ blockers, taskId }: { blockers: Blocker[]; taskId: string }) {
  const router = useRouter();
  if (!blockers.length) return <span className={css.waits}><Ban size={12} />Marked blocked by hand. <button type="button" className={styles.btn} onClick={async () => { try { await post(`tasks/${taskId}/unblock`, {}); router.refresh(); } catch (e) { notify({ id: "unblock", tone: "error", title: "Still blocked", message: msg(e) }); } }}>Unblock</button></span>;
  return <>{blockers.map((b) => <span key={b.linkId} className={css.waits}><Hourglass size={12} />Waiting on {b.visible ? <Link href={`/tasks/${b.id}`}><b>{b.title}</b></Link> : <b>{b.title}</b>} · {b.assigneeName ?? "nobody has it yet"}</span>)}</>;
}

// --------------------------------------------------------------------------------------------- accept
// UX-5A: one way to accept, everywhere (tasks/accept.tsx). These names stay for the lists that import them.
export { AcceptButton } from "./accept";
export function AcceptDialog({ task, onClose }: { task: Pick<Task, "id" | "title" | "assigneeName"> & Partial<Pick<Task, "assigneeId" | "assigneePhotoAt">>; onClose: () => void }) {
  return <AcceptDrawer task={task} onClose={onClose} />;
}

// --------------------------------------------------------------------------------------------- detail page actions
/** UX-5A: editing a task in the shared drawer: what (title, why it matters, notes), when and how urgent, where and who
 *  reviews; the kit's day picker, priority segments, project and person pickers. */
export function EditDialog({ detail, reviewers, onClose }: { detail: Detail; projects?: { id: string; name: string }[]; reviewers: Person[]; onClose: () => void }) {
  const router = useRouter(); const t = detail.task; const zone = useOrgZone(); const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // TASKS-3: the project is searched (internal work and client fulfilment, recent first), not picked from 800 options.
  const { data: work } = useWorkOptions(); const [project, setProject] = useState<string | null>(t.projectId);
  const [due, setDue] = useState<string | null>(t.dueOn ?? null), [priority, setPriority] = useState<string>(t.priority), [reviewer, setReviewer] = useState<string | null>(t.reviewerId ?? null);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const f = new FormData(e.currentTarget);
    const body = { title: f.get("title"), notes: f.get("notes"), priority, dueOn: due, projectId: project, reviewerId: reviewer, valueNote: f.get("valueNote") };
    try { await post(`tasks/${t.id}`, body); notify({ id: "task-edit", tone: "success", title: "Saved", timeout: 2000 }); onClose(); router.refresh(); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <Drawer title="Edit task" context={<ContextChip icon={<CircleCheck size={12} aria-hidden="true" />} tip={t.title}>{t.title}</ContextChip>} icon={<Pencil size={16} />} onClose={onClose}
    footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button form="task-edit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Save"}</button></DrawerFooter>}>
    <form id="task-edit" onSubmit={save} className={styles.drawerForm}>
      <DrawerSection title="What">
        <label className={styles.field}>Task<input name="title" defaultValue={t.title} required maxLength={300} /></label>
        <label className={styles.field}>Why it matters<input name="valueNote" defaultValue={t.valueNote ?? ""} maxLength={1000} placeholder="Unlocks …, or Client: … (one line)" /></label>
        <label className={styles.field}>Notes<textarea name="notes" defaultValue={t.notes ?? ""} maxLength={20000} rows={4} /></label>
      </DrawerSection>
      <DrawerSection title="When">
        <div className={styles.kitField}><span>Due</span><DatePicker label="Due" value={{ date: due, time: null }} onChange={(v) => setDue(v.date)} today={zoneDay(zone)} placeholder="No due day" /></div>
        <div className={styles.kitField}><span>Priority</span><Segmented label="Priority" value={priority} onChange={setPriority} fill options={["low", "normal", "high", "urgent"].map((v) => ({ value: v, label: PRIORITY[v] }))} /></div>
      </DrawerSection>
      <DrawerSection title="Where and who" help="With no reviewer, leadership accepts the work.">
        <div className={styles.kitField}><span>Project</span>{work ? <ProjectPicker projects={t.projectId && !work.projects.some((p) => p.id === t.projectId) ? [{ id: t.projectId, name: t.projectName ?? "This project", kind: t.projectKind ?? "internal", clientName: null }, ...work.projects] : work.projects}
          value={project} onChange={setProject} /> : <span className={styles.muted}>Loading projects…</span>}</div>
        <div className={styles.kitField}><span>Reviewer</span><PersonSelect label="Reviewer" people={reviewers.filter((p) => p.id !== t.assigneeId)} value={reviewer} onChange={(p) => setReviewer(p?.id ?? null)} noneLabel="Leadership accepts" placeholder="Leadership accepts" /></div>
      </DrawerSection>
    </form>
  </Drawer>;
}
export function BlockerForm({ taskId, people }: { taskId: string; people: Person[] }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [q, setQ] = useState(""), [found, setFound] = useState<{ q: string; hits: Task[] }>({ q: "", hits: [] }), [assignee, setAssignee] = useState(""), [busy, setBusy] = useState(false);
  const term = q.trim(); const hits = open && term.length >= 2 && found.q === term ? found.hits : [];
  useEffect(() => {
    if (!open || term.length < 2) return;
    const h = setTimeout(async () => { const r = await fetch(`/api/v0/tasks?size=10&q=${encodeURIComponent(term)}`).catch(() => null); if (r?.ok) setFound({ q: term, hits: ((await r.json()).rows as Task[]).filter((t) => t.id !== taskId && !["done", "accepted", "cancelled"].includes(t.status)) }); }, 250);
    return () => clearTimeout(h);
  }, [term, open, taskId]);
  async function link(body: Record<string, unknown>) { setBusy(true); try { await post(`tasks/${taskId}/block`, body); notify({ id: "block", tone: "success", title: "Blocker added", message: "Its owner is told; you hear when it clears.", timeout: 3000 }); setOpen(false); setQ(""); router.refresh(); } catch (e) { notify({ id: "block", tone: "error", title: "Not added", message: msg(e) }); } finally { setBusy(false); } }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Hourglass size={13} />Waiting on…</button>
    {open ? <Modal title="What is this task waiting on?" sub="Choose an existing task, or write one for the person you are waiting on." onClose={() => setOpen(false)}>
      <label className={styles.field}>Search tasks or describe a new one<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Share the September bank statement" autoFocus /></label>
      <ul className={css.pickerList}>{hits.map((t) => <li key={t.id}><button type="button" onClick={() => link({ blockerId: t.id })} disabled={busy}><Link2 size={13} />{t.title}<small>{t.assigneeName ?? "Open"}</small></button></li>)}</ul>
      {q.trim().length >= 3 ? <div className={css.inlineForm}><PersonSelect label="Who owns the new blocker" people={people} value={assignee || null} onChange={(p) => setAssignee(p?.id ?? "")} noneLabel="Nobody yet" placeholder="Nobody yet" size="sm" />
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => link({ title: q.trim(), assigneeId: assignee || null })}><Plus size={13} />New blocker task</button></div> : null}
    </Modal> : null}</>;
}
export function UnblockButton({ taskId, blockerId, label = "Clear" }: { taskId: string; blockerId?: string; label?: string }) {
  const router = useRouter();
  return <button type="button" className={styles.btn} onClick={async () => { try { await post(`tasks/${taskId}/unblock`, blockerId ? { blockerId } : {}); router.refresh(); } catch (e) { notify({ id: "unblock", tone: "error", title: "Not cleared", message: msg(e) }); } }}>{label}</button>;
}
export function ProofForm({ taskId, compact, to = "proof" }: { taskId: string; /** One line: no label field. */ compact?: boolean; /** READY: "attachments" adds the brief and references, not proof. */ to?: "proof" | "attachments" }) {
  const router = useRouter(); const [url, setUrl] = useState(""), [label, setLabel] = useState(""), [busy, setBusy] = useState(false); const file = useRef<HTMLInputElement>(null);
  const what = to === "proof" ? "Proof" : "Attachment";
  async function addLink(e: FormEvent) { e.preventDefault(); setBusy(true); try { await post(`tasks/${taskId}/${to}`, { url: url.trim(), label: label.trim() }); setUrl(""); setLabel(""); router.refresh(); } catch (err) { notify({ id: "proof", tone: "error", title: "Not attached", message: msg(err) }); } finally { setBusy(false); } }
  async function upload(f: File) {
    if (f.size > 5 * 1024 * 1024) { notify({ id: "proof", tone: "error", title: "File too large", message: "Attach files up to 5 MB, or paste a Drive link." }); return; }
    setBusy(true);
    try { const bytes = await new Promise<string>((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(",")[1] ?? ""); r.onerror = () => fail(new Error("Could not read the file")); r.readAsDataURL(f); });
      await post(`tasks/${taskId}/${to}`, { name: f.name, mime: f.type || "application/octet-stream", bytes, label: f.name }); router.refresh(); }
    catch (err) { notify({ id: "proof", tone: "error", title: "Not attached", message: msg(err) }); } finally { setBusy(false); if (file.current) file.current.value = ""; }
  }
  return <form className={css.inlineForm} onSubmit={addLink}>
    <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={to === "proof" ? "Link: Drive, Docs, GitHub PR or commit, report" : "Link: the brief, a Drive folder, a reference"} aria-label={`${what} link`} required />
    {compact ? null : <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label={`${what} label`} maxLength={200} />}
    <button className={styles.btn} disabled={busy || !url.trim()}><Link2 size={13} />Add link</button>
    <input ref={file} type="file" hidden accept="application/pdf,image/*,.csv,.txt,.zip,.docx,.xlsx,.pptx" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
    <button type="button" className={styles.btn} disabled={busy} onClick={() => file.current?.click()}><Paperclip size={13} />Attach file</button>
  </form>;
}
/** DATUP-TASKS: "Add" first, the link field and file button once asked for (an empty task page stays quiet). */
export function AddAttachment({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  return open ? <ProofForm taskId={taskId} compact to="attachments" />
    : <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><span>The brief, references</span><button type="button" className={styles.btn} style={{ marginLeft: "auto" }} onClick={() => setOpen(true)}><Paperclip size={13} aria-hidden="true" />Add</button></div>;
}
export function LogTime({ taskId, projectId, today }: { taskId?: string; projectId?: string | null; today: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); const hours = Number(f.get("hours") || 0), minutes = Math.round(hours * 60);
    setBusy(true); try { await post("time", { taskId, projectId, date: f.get("date"), minutes, note: f.get("note") }); notify({ id: "time", tone: "success", title: `Logged ${hours} h`, timeout: 2500 }); form.reset(); router.refresh(); }
    catch (err) { notify({ id: "time", tone: "error", title: "Not logged", message: msg(err) }); } finally { setBusy(false); }
  }
  return <form className={css.inlineForm} onSubmit={save}>
    <DateField name="date" defaultValue={today} max={today} aria-label="Day" required />
    <input type="number" name="hours" min="0.25" max="24" step="0.25" placeholder="Hours" aria-label="Hours" required />
    <input name="note" placeholder="What you did (optional)" aria-label="Note" maxLength={500} />
    <button className={styles.btn} disabled={busy}><Hourglass size={13} />Log time</button>
  </form>;
}
export function RemoveAttachment({ id }: { id: string }) {
  const router = useRouter();
  return <button type="button" className={styles.iconBtn} title="Remove this attachment" aria-label="Remove this attachment" onClick={async () => { try { await post(`tasks/attachments/${id}/remove`, {}); router.refresh(); } catch (e) { notify({ id: "attachment", tone: "error", title: "Kept", message: msg(e) }); } }}>×</button>;
}
export function RemoveProof({ id }: { id: string }) {
  const router = useRouter();
  return <button type="button" className={styles.iconBtn} title="Remove this proof" aria-label="Remove this proof" onClick={async () => { try { await post(`tasks/proof/${id}/remove`, {}); router.refresh(); } catch (e) { notify({ id: "proof", tone: "error", title: "Kept", message: msg(e) }); } }}>×</button>;
}

// --------------------------------------------------------------------------------------------- outcomes
export function TimeProposals({ rows }: { rows: { id: string; date: string; minutes: number; note: string | null; source: string; taskTitle: string | null; projectName: string | null; status: string }[] }) {
  const router = useRouter(); const proposed = rows.filter((r) => r.status === "proposed");
  const decide = async (id: string, decision: string) => { try { await post(`time/${id}`, { decision }); router.refresh(); } catch (e) { notify({ id: "time", tone: "error", title: "Not saved", message: msg(e) }); } };
  if (!proposed.length) return <p className={css.empty}><b>No time waiting for you</b>Time Pulse proposes from your work (commits, agent runs, documents, meetings) appears here for you to confirm.</p>;
  return <>
    <ul className={css.list} data-items="">{proposed.map((r) => <li key={r.id} className={css.row}>
      <Hourglass size={16} aria-hidden="true" />
      <div className={css.rowMain}><span className={css.title}>{(r.minutes / 60).toFixed(r.minutes % 60 ? 1 : 0)} h · {r.taskTitle ?? r.projectName ?? "No project"}</span><span className={css.meta}><Chip>{shortDay(r.date)}</Chip><Chip>{r.source === "estimate" ? "Estimate" : `From ${r.source.replace("_", " ")}`}</Chip>{r.note ? <span>{r.note}</span> : null}</span></div>
      <span className={css.end}><button type="button" className={styles.btn} onClick={() => decide(r.id, "dismiss")}>Not mine</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => decide(r.id, "confirm")}>Confirm</button></span>
    </li>)}</ul>
    <p className={css.note}><button type="button" className={styles.btn} onClick={async () => { try { const r = await post<{ confirmed: number }>("time/confirm-all", {}); notify({ id: "time", tone: "success", title: `Confirmed ${r.confirmed} entries`, timeout: 2500 }); router.refresh(); } catch (e) { notify({ id: "time", tone: "error", title: "Not saved", message: msg(e) }); } }}>Confirm all {proposed.length}</button></p>
  </>;
}
export function KpiProgress({ kpi }: { kpi: { id: string; title: string; progress: number | null; status: string; note: string | null } }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [progress, setProgress] = useState(kpi.progress ?? 0), [status, setStatus] = useState(kpi.status), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await post(`kpis/${kpi.id}`, { progress, status, note }); setOpen(false); router.refresh(); } catch (e) { notify({ id: "kpi", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); } }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}>Update</button>
    {open ? <Modal title="KPI progress" sub={kpi.title} onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={save}>Save</button></div>}>
      <label className={styles.field}>Progress · {progress}%<input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setProgress(Number(e.target.value))} /></label>
      <div className={styles.kitField}><span>Status</span><Select label="Status" value={status} onChange={(v) => setStatus(v ?? status)} options={[["not_started", "Not started"], ["on_track", "On track"], ["at_risk", "At risk"], ["behind", "Behind"], ["met", "Met"], ["missed", "Missed"]].map(([value, label]) => ({ value, label }))} /></div>
      <label className={styles.field}>Evidence or note<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Link or one line on what moved" /></label>
    </Modal> : null}</>;
}
export function LinkTracker({ trackerKey, label, n, projects }: { trackerKey: string; label: string; n: number; projects: { id: string; name: string }[] }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [q, setQ] = useState("");
  const list = projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  async function link(id: string, name: string) { try { const r = await post<{ linked: number }>("tasks/link-tracker", { key: trackerKey, projectId: id }); notify({ id: "link", tone: "success", title: `Linked ${r.linked} tasks to ${name}`, timeout: 3000 }); setOpen(false); router.refresh(); } catch (e) { notify({ id: "link", tone: "error", title: "Not linked", message: msg(e) }); } }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}>Link {n} to a project</button>
    {open ? <Modal title={`Link “${label}” tasks to a project`} sub={`${n} tracker tasks name “${label}”. Choose the project they belong to.`} onClose={() => setOpen(false)}>
      <input className={styles.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" autoFocus aria-label="Search projects" />
      <ul className={css.pickerList}>{list.map((p) => <li key={p.id}><button type="button" onClick={() => link(p.id, p.name)}><FolderKanban size={13} />{p.name}</button></li>)}</ul>
    </Modal> : null}</>;
}
