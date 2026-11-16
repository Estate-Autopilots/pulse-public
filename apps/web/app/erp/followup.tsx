"use client";

// EST-1239: a sent quotation's follow-up (EST-1238), on the quotation and on its follow-up task. Billing Blueprint (18 Oct):
// one main button, "Log reply", and the answer is given in the kit Drawer (a panel on the right on a computer, a sheet
// from the bottom on a phone). The card says when the next follow-up is (the company's follow-up hour, in its own time
// zone) and links the task. Only an explicit answer counts: a link opened or a PDF viewed never does. A quotation that was
// never sent has no follow-up (404), so nothing shows.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, FileText, ListTodo, MessageSquareReply } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, DrawerSection } from "../kit/drawer";
import { post } from "../records";
import { Badge, styles } from "../ui";
import css from "./erp.module.css";
import { SelectField } from "../kit/select-field";

export type FollowUp = {
  documentId: string; state: "scheduled" | "answered" | "closed" | "stopped"; nextDueAt: string | null; lastDueAt: string | null; occurrences: number;
  taskId: string | null; salesperson: { id: string; name: string } | null; answer: { at: string; note: string | null } | null;
  closed: { at: string; outcome: string; note: string | null } | null; stoppedReason: string | null; canAnswer: boolean;
};
type Action = "replied" | "later" | "close";
const STATE: Record<FollowUp["state"], [string, "warning" | "success" | "neutral"]> = {
  scheduled: ["Waiting for a reply", "warning"], answered: ["Customer replied", "success"], closed: ["Closed", "neutral"], stopped: ["Stopped", "neutral"] };
const OUTCOME: Record<string, string> = { converted: "Won: converting it", not_interested: "Not interested", lost: "Lost to someone else", other: "Other" };
const STOPPED: Record<string, string> = { accepted: "the client accepted it", declined: "the client declined it", converted: "it was converted", cancelled: "it was cancelled",
  off: "follow-ups are switched off for the company" };
const CHOICES: { key: Action; label: string; save: string; done: string }[] = [
  { key: "replied", label: "Customer replied", save: "Save reply", done: "Reply logged" },
  { key: "later", label: "Call again later", save: "Move the follow-up", done: "Next follow-up moved" },
  { key: "close", label: "Close it", save: "Close the follow-up", done: "Follow-up closed" },
];
const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");

export function QuoteFollowUp({ quoteId, zone, title, onTask = false }: { quoteId: string; zone: string; title?: string; onTask?: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<FollowUp | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action>("replied");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    fetch(`/api/v0/quotes/${encodeURIComponent(quoteId)}/follow-up`).then(async (r) => {
      if (mine !== seq.current) return;
      if (r.status === 404) setView(null); else if (r.ok) setView(await r.json()); else setFailed(true);
    }).catch(() => { if (mine === seq.current) setFailed(true); });
  }, [quoteId]);
  const when = (at: string) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  const choice = CHOICES.find((c) => c.key === action)!;
  async function save() {
    if (action === "close" && !outcome) { setError("Choose how it ended"); return; }
    setBusy(true); setError(null);
    const mine = ++seq.current;
    try {
      const v = await post<FollowUp>(`quotes/${encodeURIComponent(quoteId)}/follow-up`, { action, outcome: action === "close" ? outcome : undefined, note });
      if (mine === seq.current) { setView(v); setNote(""); setOutcome(""); setOpen(false); }
      notify({ id: "quote-followup", tone: "success", title: choice.done, timeout: 3500 });
      router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (view === null) return null;
  if (failed) return <section className={css.card} aria-label="Follow-up"><p className={css.note}>The follow-up didn&apos;t load. Reload the page to try again.</p></section>;
  if (!view) return <section className={css.card} aria-label="Follow-up" aria-busy="true"><div className={css.cardHead}><h3>Follow-up</h3></div><p className={css.note}>Loading…</p></section>;
  const [label, tone] = STATE[view.state];
  const choices = CHOICES.filter((c) => c.key !== "replied" || view.state === "scheduled");
  return <section className={css.card} aria-label="Follow-up">
    <div className={css.cardHead}><h3>Follow-up{view.salesperson ? <small> · {view.salesperson.name}</small> : null}</h3><Badge tone={tone}>{label}</Badge></div>
    {view.state === "scheduled" && view.nextDueAt ? <p className={css.note}><CalendarClock size={13} aria-hidden="true" /> Next follow-up <b>{when(view.nextDueAt)}</b>
      {view.occurrences ? ` · ${view.occurrences} so far` : ""}. It repeats until the customer replies, or the quotation is won or closed.</p> : null}
    {view.answer ? <p className={css.note}>Customer replied {when(view.answer.at)}{view.answer.note ? <>: {view.answer.note}</> : null}</p> : null}
    {view.closed ? <p className={css.note}>Closed {when(view.closed.at)}: <b>{OUTCOME[view.closed.outcome] ?? view.closed.outcome}</b>{view.closed.note ? <> · {view.closed.note}</> : null}</p> : null}
    {view.state === "stopped" ? <p className={css.note}>No more follow-ups: {STOPPED[view.stoppedReason ?? ""] ?? "the quotation is no longer open"}.</p> : null}
    {onTask && view.state === "scheduled" ? <p className={css.note}>Finishing this task alone keeps the next follow-up; log the customer&apos;s reply instead.</p> : null}
    <div className={css.actionsBar}>
      {view.canAnswer ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => { setAction(view.state === "scheduled" ? "replied" : "later"); setError(null); setOpen(true); }}>
        <MessageSquareReply size={14} aria-hidden="true" />Log reply</button> : null}
      {onTask ? <Link className={`${styles.btn} ${styles.btnSmall}`} href={`/erp/documents/${view.documentId}`}><FileText size={13} aria-hidden="true" />Open the quotation</Link>
        : view.taskId && view.state === "scheduled" ? <Link className={`${styles.btn} ${styles.btnSmall}`} href={`/tasks/${view.taskId}`}><ListTodo size={13} aria-hidden="true" />Open the follow-up task</Link> : null}
    </div>
    {open ? <Drawer title="Log reply" size="sm" context={title} onClose={() => setOpen(false)}
      footer={<DrawerFooter status={error} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void save()}>{choice.save}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button></DrawerFooter>}>
      <DrawerSection title="What happened">
        <div role="radiogroup" aria-label="What happened" className={styles.choiceRow}>
          {choices.map((c) => <label key={c.key} className={styles.choiceItem}><input type="radio" name="followup-action" checked={action === c.key} onChange={() => { setAction(c.key); setError(null); }} /><span>{c.label}</span></label>)}
        </div>
      </DrawerSection>
      {action === "close" ? <DrawerSection title="How it ended">
        <label className={styles.field}>How it ended<SelectField value={outcome} onChange={(e) => { setOutcome(e.target.value); setError(null); }}><option value="">Choose…</option>
          {Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</SelectField></label>
      </DrawerSection> : null}
      <DrawerSection title="Note">
        <label className={styles.field}>Note (optional)<textarea value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="What the customer said" /></label>
      </DrawerSection>
    </Drawer> : null}
  </section>;
}
