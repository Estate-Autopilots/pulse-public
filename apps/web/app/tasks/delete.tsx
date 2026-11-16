"use client";
// TASKS-3: delete a task made by mistake. The dialog first says what is connected (subtasks go with it, tasks waiting
// on it stop waiting, chats that carry its card, files, comments, value already credited); the delete is soft and can be
// undone at once, or restored for 30 days from Work → Recently deleted.
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, FolderKanban, Hourglass, ListTree, MessageSquare, MessagesSquare, Package, Paperclip, RotateCcw, Timer, Trash2, Users } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import css from "./work3.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
type Preview = { id: string; title: string; canDelete: boolean; subtasks: { id: string; title: string; status: string }[]; waiting: { id: string; title: string; person: string | null }[];
  waitsOn: number; chats: number; files: number; comments: number; people: number; credits: { points: number; person: string; title: string }[]; asks: number; time: number };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function restoreTask(id: string, title: string, after?: () => void) {
  try { await post(`tasks/${id}/restore`, {}); notify({ id: "restore", tone: "success", title: "Restored", message: title, href: `/tasks/${id}`, timeout: 3500 }); after?.(); }
  catch (e) { notify({ id: "restore", tone: "error", title: "Not restored", message: msg(e) }); }
}

export function DeleteDialog({ taskId, onClose, goTo = "/tasks" }: { taskId: string; onClose: () => void; goTo?: string | null }) {
  const router = useRouter();
  const [p, setP] = useState<Preview | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { fetch(`/api/v0/tasks/${taskId}/delete-preview`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Could not load"); setP(d); }).catch((e) => setError(msg(e))); }, [taskId]);
  async function remove() {
    if (!p) return; setBusy(true);
    try {
      await post(`tasks/${taskId}/delete`, {});
      notify({ id: "delete", tone: "success", title: "Deleted", message: `${p.title}${p.subtasks.length ? ` and ${plural(p.subtasks.length, "subtask")}` : ""}. Restore it for 30 days from Recently deleted.`, timeout: 6500,
        action: { label: "Undo", run: () => void restoreTask(taskId, p.title, () => router.refresh()) } });
      onClose(); if (goTo) router.push(goTo); router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const facts: { icon: ReactNode; text: string; detail: string | null; tone?: string }[] = [];
  if (p) {
    if (p.subtasks.length) facts.push({ icon: <ListTree size={15} />, text: `${plural(p.subtasks.length, "subtask")} ${p.subtasks.length === 1 ? "goes" : "go"} with it`, detail: p.subtasks.slice(0, 4).map((s) => s.title).join(" · ") });
    if (p.waiting.length) facts.push({ icon: <Hourglass size={15} />, text: `${plural(p.waiting.length, "task")} waiting on it ${p.waiting.length === 1 ? "stops" : "stop"} waiting`, detail: p.waiting.slice(0, 3).map((w) => `${w.title}${w.person ? ` (${w.person.split(" ")[0]})` : ""}`).join(" · ") });
    if (p.waitsOn) facts.push({ icon: <Hourglass size={15} />, text: `It waits on ${plural(p.waitsOn, "task")}`, detail: "Those tasks stay as they are." });
    if (p.chats) facts.push({ icon: <MessagesSquare size={15} />, text: `Shared in ${plural(p.chats, "chat")}`, detail: "The chat keeps the message; its task card opens nothing while it is deleted." });
    if (p.files) facts.push({ icon: <Paperclip size={15} />, text: `${plural(p.files, "file or link", "files and links")} attached`, detail: "Kept with the task, and back if you restore it." });
    if (p.comments) facts.push({ icon: <MessageSquare size={15} />, text: plural(p.comments, "comment"), detail: null });
    if (p.people) facts.push({ icon: <Users size={15} />, text: `${plural(p.people, "person", "people")} working on or following it`, detail: "They stop hearing about it." });
    if (p.asks) facts.push({ icon: <Users size={15} />, text: `${plural(p.asks, "open request")} withdrawn`, detail: null });
    if (p.time) facts.push({ icon: <Timer size={15} />, text: `${Math.round(p.time / 6) / 10} h of logged time`, detail: "The time stays in the person's week." });
  }
  return <Modal title="Delete this task?" sub={p ? p.title : "Checking what is connected…"} onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Keep it</button>
      <button type="button" className={`${styles.btn} ${css.danger}`} disabled={busy || !p?.canDelete} onClick={remove}><Trash2 size={14} aria-hidden="true" />{p?.subtasks.length ? `Delete with ${plural(p.subtasks.length, "subtask")}` : "Delete task"}</button></div>}>
    <div className={css.dialogBody} style={{ minHeight: 0 }}>
      {error ? <p className={css.dangerNote} role="alert"><AlertTriangle size={14} aria-hidden="true" />{error}</p> : null}
      {p && !p.canDelete ? <p className={css.dangerNote}><AlertTriangle size={14} aria-hidden="true" />Whoever created the task, an admin or the project’s owner deletes it.</p> : null}
      {p ? facts.length ? <ul className={css.connected} aria-label="What is connected">{facts.map((f) => <li key={f.text} data-tone={f.tone}>{f.icon}<span><b>{f.text}</b>{f.detail ? <small>{f.detail}</small> : null}</span></li>)}</ul>
        : <p className={css.line}>Nothing else is connected to it.</p> : <p className={css.line} aria-busy="true">Checking what is connected…</p>}
      <p className={css.line}><RotateCcw size={13} aria-hidden="true" />You can restore it for 30 days from Work → Recently deleted. The audit log keeps who deleted it.</p>
    </div>
  </Modal>;
}

/** Restore from Recently deleted. */
export function RestoreButton({ id, title }: { id: string; title: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={styles.btn} disabled={busy} onClick={async () => { setBusy(true); await restoreTask(id, title, () => router.refresh()); setBusy(false); }}><RotateCcw size={13} aria-hidden="true" />Restore</button>;
}

// ------------------------------------------------------------------------------------------------ projects (TASKS-4B)
type ProjectPreview = { id: string; name: string; kind: string; canDelete: boolean; tasks: { total: number; open: number; finished: number; cancelled: number; sample: { id: string; title: string; status: string }[] };
  waiting: { id: string; title: string; person: string | null; project: string | null }[]; waitsOn: number; chats: number; files: number; comments: number; people: number;
  credits: { points: number; people: number }; time: number; asks: number; packages: { id: string; name: string }[] };

export async function restoreProject(id: string, name: string, after?: () => void) {
  try { const r = await post<{ tasks: number }>(`work/projects/${id}/restore`, {}); notify({ id: "restore", tone: "success", title: "Restored", message: `${name}${r.tasks ? ` with ${plural(r.tasks, "task")}` : ""}`, href: `/tasks/projects/${id}`, timeout: 3500 }); after?.(); }
  catch (e) { notify({ id: "restore", tone: "error", title: "Not restored", message: msg(e) }); }
}
/** Delete a project: first everything that is connected and exactly what happens to it; then one soft delete of the
 *  project and all its tasks, undone at once or restored for 30 days. */
export function DeleteProjectDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const router = useRouter();
  const [p, setP] = useState<ProjectPreview | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [sure, setSure] = useState("");
  useEffect(() => { fetch(`/api/v0/work/projects/${projectId}/delete-preview`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Could not load"); setP(d); }).catch((e) => setError(msg(e))); }, [projectId]);
  // A project with open work asks for its name typed in.
  const needName = !!p && p.tasks.open > 0;
  async function remove() {
    if (!p) return; setBusy(true);
    try {
      const r = await post<{ tasks: number }>(`work/projects/${projectId}/delete`, {});
      notify({ id: "delete", tone: "success", title: "Project deleted", message: `${p.name}${r.tasks ? ` and ${plural(r.tasks, "task")}` : ""}. Restore it for 30 days from Recently deleted.`, timeout: 6500,
        action: { label: "Undo", run: () => void restoreProject(projectId, p.name, () => router.refresh()) } });
      onClose(); router.push("/tasks?view=projects"); router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const facts: { icon: ReactNode; text: string; detail: string | null; tone?: string }[] = [];
  if (p) {
    if (p.tasks.total) facts.push({ icon: <ListTree size={15} />, text: `${plural(p.tasks.total, "task")} ${p.tasks.total === 1 ? "is" : "are"} deleted with it`, detail: `${p.tasks.open} open · ${p.tasks.finished} finished${p.tasks.cancelled ? ` · ${p.tasks.cancelled} cancelled` : ""}: ${p.tasks.sample.map((t) => t.title).join(" · ")}${p.tasks.total > p.tasks.sample.length ? " …" : ""}`, tone: p.tasks.open ? "late" : undefined });
    if (p.waiting.length) facts.push({ icon: <Hourglass size={15} />, text: `${plural(p.waiting.length, "task")} in other projects stop${p.waiting.length === 1 ? "s" : ""} waiting on its tasks`, detail: p.waiting.slice(0, 3).map((w) => `${w.title}${w.person ? ` (${w.person.split(" ")[0]})` : ""}`).join(" · ") });
    if (p.waitsOn) facts.push({ icon: <Hourglass size={15} />, text: `Its tasks wait on ${plural(p.waitsOn, "task")} elsewhere`, detail: "Those tasks stay as they are." });
    if (p.packages.length) facts.push({ icon: <Package size={15} />, text: `Placed under ${p.packages.map((x) => x.name).join(", ")}`, detail: "The client package stays; it no longer counts this project's tasks while it is deleted." });
    if (p.chats) facts.push({ icon: <MessagesSquare size={15} />, text: `Task cards shared in ${plural(p.chats, "chat")}`, detail: "The chats keep their messages; the cards open nothing while it is deleted." });
    if (p.files) facts.push({ icon: <Paperclip size={15} />, text: `${plural(p.files, "file or link", "files and links")} attached to its tasks`, detail: "Kept, and back if you restore it." });
    if (p.comments) facts.push({ icon: <MessageSquare size={15} />, text: plural(p.comments, "comment"), detail: "Kept, and back if you restore it." });
    if (p.people) facts.push({ icon: <Users size={15} />, text: `${plural(p.people, "person", "people")} on it or its tasks`, detail: "They stop hearing about it; open requests are withdrawn." });
    if (p.time) facts.push({ icon: <Timer size={15} />, text: `${Math.round(p.time / 6) / 10} h of captured time`, detail: "The time stays in each person's week." });
  }
  return <Modal title="Delete this project?" sub={p ? p.name : "Checking what is connected…"} onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Keep it</button>
      <button type="button" className={`${styles.btn} ${css.danger}`} disabled={busy || !p?.canDelete || (needName && sure.trim().toLowerCase() !== p.name.trim().toLowerCase())} onClick={remove}>
        <Trash2 size={14} aria-hidden="true" />{p?.tasks.total ? `Delete with ${plural(p.tasks.total, "task")}` : "Delete project"}</button></div>}>
    <div className={css.dialogBody} style={{ minHeight: 0 }}>
      {error ? <p className={css.dangerNote} role="alert"><AlertTriangle size={14} aria-hidden="true" />{error}</p> : null}
      {p && !p.canDelete ? <p className={css.dangerNote}><AlertTriangle size={14} aria-hidden="true" />{p.kind === "internal" ? "The project’s owner, leadership or an admin deletes it." : "A client package’s fulfilment is not deleted from Work: close the package from Clients."}</p> : null}
      {p ? facts.length ? <ul className={css.connected} aria-label="What is connected">{facts.map((f) => <li key={f.text} data-tone={f.tone}>{f.icon}<span><b>{f.text}</b>{f.detail ? <small>{f.detail}</small> : null}</span></li>)}</ul>
        : <p className={css.line}><FolderKanban size={13} aria-hidden="true" />Nothing is connected to it: no tasks, people or links.</p> : <p className={css.line} aria-busy="true">Checking what is connected…</p>}
      {needName && p?.canDelete ? <label className={styles.field}>It still has open work. Type its name to delete it<input value={sure} onChange={(e) => setSure(e.target.value)} placeholder={p.name} autoComplete="off" /></label> : null}
      <p className={css.line}><RotateCcw size={13} aria-hidden="true" />Everything comes back together if you restore it within 30 days (Work → Recently deleted). The audit log keeps who deleted it.</p>
    </div>
  </Modal>;
}
export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Trash2 size={13} aria-hidden="true" />Delete…</button>{open ? <DeleteProjectDialog projectId={projectId} onClose={() => setOpen(false)} /> : null}</>;
}
export function RestoreProjectButton({ id, name }: { id: string; name: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={styles.btn} disabled={busy} onClick={async () => { setBusy(true); await restoreProject(id, name, () => router.refresh()); setBusy(false); }}><RotateCcw size={13} aria-hidden="true" />Restore</button>;
}
