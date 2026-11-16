"use client";
// UX-5A (owner, 13 Oct 2026: "accepting work must be dead simple"): one way to accept finished work, wherever it is
// accepted (a list row, the board, Work → Reviews, the bell, Notifications, the task page). The only input is
// TASKS-4B's one quality rating (Great / Good / Needs work, or 1–5 by the company's policy) and "above and beyond"; an
// optional note hides behind "Add a note". INTEGRITY (owner, 22 Oct 2026): tasks carry no value points, so accepting
// credits nothing; GET tasks/:id/credit only says how this task is accepted. Leadership's and founders' work is
// acknowledged with one tap.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BadgeCheck, Check, CircleCheck, Undo2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { ContextChip, Drawer, DrawerFooter, DrawerSection, PersonChip } from "../kit";
import { styles } from "../ui";
import { Rating, Toggle } from "./kit";
import css from "./accept.module.css";

/** How a task is accepted: rated or acknowledged (GET tasks/:id/credit). No points. */
export type CreditPreview = { mode: "rate" | "acknowledge"; task?: { id: string; title: string; status: string }; doer?: { id: string; name: string; photoAt: string | null } | null; scale?: "three" | "five" };
export type QualityOption = { value: string; label: string };
const THREE: QualityOption[] = [{ value: "great", label: "Great" }, { value: "good", label: "Good" }, { value: "needs_work", label: "Needs work" }];
const FIVE: QualityOption[] = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));
export const qualityFor = (scale: "three" | "five" | undefined) => scale === "five" ? FIVE : THREE;
export const defaultQualityFor = (scale: "three" | "five" | undefined) => scale === "five" ? "4" : "good";
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
export const firstName = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];

const previews = new Map<string, Promise<CreditPreview | null>>();
/** How accepting this task works; read once per task (and again after it changes). */
export function useCreditPreview(taskId: string, initial?: CreditPreview | null) {
  const [p, setP] = useState<CreditPreview | null | undefined>(initial);
  useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    let q = previews.get(taskId);
    if (!q) { q = fetch(`/api/v0/tasks/${taskId}/credit`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null); previews.set(taskId, q); setTimeout(() => previews.delete(taskId), 30000); }
    void q.then((x) => { if (live) setP(x); });
    return () => { live = false; };
  }, [taskId, initial]);
  return p;
}

/** Sends the review; returns the API's answer (kind). */
export async function acceptTaskNow(taskId: string, { ack, quality, above, note }: { ack: boolean; quality?: string; above?: boolean; note?: string }) {
  previews.delete(taskId);
  return post<{ kind?: string }>(`tasks/${taskId}/accept`, ack ? { acknowledge: true, note } : { quality, above, note });
}
export function acceptedNotice(r: { kind?: string }, who: string, title: string) {
  notify({ id: "accept", tone: "success", title: r.kind === "acknowledged" ? `Accepted · thanks to ${who}` : `Accepted · ${who} is told`, message: title, timeout: 3500 });
}

/** The rating and "above and beyond", one row (wraps on a phone). */
export function AcceptChoice({ scale, quality, setQuality, above, setAbove, size = "md", label = "How was the work?" }: { scale: "three" | "five" | undefined; quality: string; setQuality: (q: string) => void;
  above: boolean; setAbove: (b: boolean) => void; size?: "sm" | "md"; label?: string }) {
  return <div className={css.choice} data-size={size}>
    <Rating label={label} options={qualityFor(scale)} value={quality} onChange={setQuality} size={size} hideLabel />
    <Toggle label="Above and beyond" checked={above} onChange={setAbove} />
  </div>;
}

type TaskLike = { id: string; title: string; assigneeName?: string | null; assigneeId?: string | null; assigneePhotoAt?: string | null };
/** The drawer every list opens to accept one task: who and what on top, the rating, and Accept. */
export function AcceptDrawer({ task, onClose, onDone, initial }: { task: TaskLike; onClose: () => void; onDone?: (r: { kind?: string }) => void; initial?: CreditPreview | null }) {
  const router = useRouter();
  const preview = useCreditPreview(task.id, initial);
  const scale = preview?.scale;
  const [quality, setQuality] = useState<string | null>(null), [above, setAbove] = useState(false), [note, setNote] = useState(""), [noting, setNoting] = useState(false);
  const [back, setBack] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const doer = preview?.doer ?? (task.assigneeName ? { id: task.assigneeId ?? task.id, name: task.assigneeName, photoAt: task.assigneePhotoAt ?? null } : null);
  const who = firstName(doer?.name);
  const ack = preview?.mode === "acknowledge";
  const chosen = quality ?? defaultQualityFor(scale);
  async function accept() {
    setBusy(true); setError("");
    try { const r = await acceptTaskNow(task.id, { ack, quality: chosen, above, note: note.trim() || undefined }); acceptedNotice(r, who, task.title); onDone?.(r); onClose(); router.refresh(); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function sendBack() {
    setBusy(true); setError("");
    try { await post(`tasks/${task.id}/return`, { note: note.trim() }); notify({ id: "return", tone: "success", title: `Sent back to ${who}`, message: "They see your note at the top of the task.", timeout: 3000 }); onDone?.({}); onClose(); router.refresh(); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const context = <>{doer ? <PersonChip person={doer} size="sm" /> : null}<ContextChip icon={<CircleCheck size={12} aria-hidden="true" />} href={`/tasks/${task.id}`} tip={task.title}>{task.title}</ContextChip></>;
  if (back) return <Drawer title={`Send back to ${who}`} context={context} onClose={onClose} size="sm" icon={<Undo2 size={16} />}
    footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setBack(false)}>Back</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || note.trim().length < 3} onClick={() => void sendBack()}><Undo2 size={14} aria-hidden="true" />Send back</button></DrawerFooter>}>
    <DrawerSection title="What still needs doing?" help="It goes back to Doing with your note at the top of the task.">
      <textarea className={css.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={4} aria-label="What still needs doing?" data-autofocus="" />
    </DrawerSection>
  </Drawer>;
  return <Drawer title={`Accept ${who}’s work`} context={context} onClose={onClose} size="sm" icon={ack ? <BadgeCheck size={16} /> : <Check size={16} />}
    help={ack ? "Leadership’s and founders’ work is acknowledged, not graded: their scorecard is outcomes." : "Say how good the work was. Tasks carry no points."}
    footer={<DrawerFooter status={error} tone={error ? "error" : "info"}>
      <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => { setBack(true); setError(""); }}><Undo2 size={14} aria-hidden="true" />Send back</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || preview === undefined} onClick={() => void accept()} data-autofocus="">
        {ack ? <><BadgeCheck size={14} aria-hidden="true" />Accept</> : <><Check size={14} aria-hidden="true" />Accept</>}</button></DrawerFooter>}>
    {ack ? null : <DrawerSection title="How was it?">
      <AcceptChoice scale={scale} quality={chosen} setQuality={setQuality} above={above} setAbove={setAbove} />
    </DrawerSection>}
    <DrawerSection>
      {noting ? <textarea className={css.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} aria-label={`Note for ${who} (optional)`} placeholder="What this changed, or a thank-you" autoFocus />
        : <button type="button" className={css.linkBtn} onClick={() => setNoting(true)}>Add a note for {who}</button>}
    </DrawerSection>
  </Drawer>;
}

/** A button that opens the accept drawer ("Review" in lists). */
export function AcceptButton({ task, label = "Accept", icon, className }: { task: TaskLike; label?: string; icon?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={className ?? `${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}>{icon ?? <Check size={13} aria-hidden="true" />}{label}</button>
    {open ? <AcceptDrawer task={task} onClose={() => setOpen(false)} /> : null}
  </>;
}

/** The link to a task, for places that only have its id and title. */
export function TaskLink({ id, title }: { id: string; title: string }) { return <Link href={`/tasks/${id}`}>{title}</Link>; }
