"use client";
// UX-5B on the task page: "Go to Office presence" (the place this task is done, from the notes, the title or the
// creator's pick), and "Done when": the signals Pip proposes from the task's words and the destinations registry, which
// the creator confirms in one tap. Confirmed signals are watched by the database; when all are met and the task allows
// it, Pulse marks it done itself and the doer can undo.
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Check, Eye, MapPin, Pencil, Sparkles, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { DESTINATIONS, canSee, destination, goHref, type Destination } from "../destinations/registry.mjs";
import type { ProposedSignal } from "../destinations/propose.mjs";
import { keepTask } from "../destinations/go";
import { Combobox } from "../kit";
import css from "./go-there.module.css";

export type CompanionState = { target: string | null; autoDone: boolean; confirmedAt: string | null; confirmedBy: string | null; dismissed: boolean; companyAutoDone: "on" | "ask"; blocker: string | null;
  signals: { id: string; event: string; label: string; need: number; seen: number; metAt: string | null }[]; auto: { id: string; at: string; undoneAt: string | null } | null };
type Target = { id: string; button: string; source: "creator" | "notes" | "title"; via: string };

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const FROM = { creator: "Chosen for this task", notes: "From the notes", title: "Pip read the title" } as const;

/** The primary way to the place the task is done. On a task still to do, the doer's tap also starts it (one tap, not two). */
export function GoThere({ taskId, target, status, doer, canSet, stored, role, modulesOff }: { taskId: string; target: Target | null; status: string; doer: boolean; canSet: boolean; stored: string | null; role: string; modulesOff?: readonly string[] }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false);
  const dest = destination(target?.id);
  const choices = useMemo(() => DESTINATIONS.filter((d) => canSee(d, { role, modulesOff })).map((d) => ({ value: d.id, label: d.path.join(" → "), keywords: (d.synonyms ?? []).join(" "), group: d.path[0] })), [role, modulesOff]);
  async function go(d: Destination) {
    setBusy(true);
    try {
      // The place is remembered on the task, so changes made there light up the companion even after this tab is gone.
      if (canSet && stored !== d.id) await post(`tasks/${taskId}/companion`, { target: d.id, targetEvents: [...new Set([...(d.events ?? []), ...(d.signals ?? []).map((s) => s.event)])] }).catch(() => null);
      if (doer && status === "open") await post(`tasks/${taskId}/move`, { status: "in_progress" }).catch(() => null);
      keepTask(taskId);
      router.push(goHref(d, taskId));
    } finally { setBusy(false); }
  }
  async function pick(id: string) {
    const d = destination(id); if (!d) return;
    setPicking(false);
    try { await post(`tasks/${taskId}/companion`, { target: d.id, targetEvents: [...new Set([...(d.events ?? []), ...(d.signals ?? []).map((s) => s.event)])] }); notify({ id: "go-pick", tone: "success", title: `This task now goes to ${d.label}`, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "go-pick", tone: "error", title: "Not saved", message: msg(e) }); }
  }
  if (!dest && !canSet) return null;
  return <div className={css.go}>
    {dest ? <button type="button" className={css.goBtn} disabled={busy} onClick={() => void go(dest)}><MapPin size={16} aria-hidden="true" /><span>{target!.button}</span><ArrowRight size={16} aria-hidden="true" /></button> : null}
    <span className={css.where}>
      {dest ? <><small title={dest.path.join(" → ")}>{FROM[target!.source]}{target!.source === "title" ? `: “${target!.via}”` : ""}</small>
        <button type="button" className={css.textBtn} onClick={() => { keepTask(taskId, { open: true }); }}><Eye size={12} aria-hidden="true" />Keep it with me</button></> : null}
      {canSet ? (picking ? <span className={css.picker}><Combobox label="Place in Pulse" options={choices} value={null} onChange={(v) => { if (v) void pick(v); }} placeholder="Choose a place" searchPlaceholder="Search: office Wi-Fi, payroll…" searchable autoOpen size="sm" />
        <button type="button" className={css.iconBtn} onClick={() => setPicking(false)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button></span>
        : <button type="button" className={css.textBtn} onClick={() => setPicking(true)}><Pencil size={12} aria-hidden="true" />{dest ? "Change the place" : "Choose where this is done"}</button>) : null}
    </span>
  </div>;
}

/** "Done when …": Pip's proposal to confirm, or the confirmed signals with their progress. */
export function DoneWhen({ taskId, proposal, state, canSet, finished }: { taskId: string; proposal: ProposedSignal[]; state: CompanionState | null; canSet: boolean; finished: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const signals = state?.confirmedAt ? state.signals : [];
  async function save(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try { await post(`tasks/${taskId}/companion`, body); notify({ id: "done-when", tone: "success", title: ok, timeout: 2600 }); router.refresh(); }
    catch (e) { notify({ id: "done-when", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  if (signals.length) {
    const met = signals.filter((s) => s.metAt).length; const auto = !!state?.autoDone && state.companyAutoDone === "on";
    return <section className={css.card} aria-labelledby="done-when">
      <div className={css.head}><h2 id="done-when"><Sparkles size={16} aria-hidden="true" />Done when</h2><small>{met} of {signals.length} happened</small></div>
      <ul className={css.signals}>{signals.map((s) => <li key={s.id} data-met={s.metAt ? "" : undefined}><i aria-hidden="true">{s.metAt ? <Check size={11} strokeWidth={3} /> : null}</i>
        <span>{s.label}</span>{s.need > 1 ? <b>{s.seen} of {s.need}</b> : null}</li>)}</ul>
      <p className={css.fine}>{finished ? "" : auto ? "When all of these happen, Pulse marks it done and tells whoever does it, with Undo. The reviewer reviews as usual."
        : state?.companyAutoDone === "ask" ? "When all of these happen, Pulse asks whoever does it to mark it done (the company’s choice)." : "When all of these happen, Pulse asks whoever does it to mark it done."}
        {state?.confirmedBy ? ` Confirmed by ${state.confirmedBy}.` : ""}</p>
      {canSet && !finished ? <div className={css.row}>
        {state?.companyAutoDone === "on" ? <label className={css.switch}><input type="checkbox" checked={!!state?.autoDone} disabled={busy} onChange={(e) => void save({ autoDone: e.target.checked }, e.target.checked ? "Pulse will finish it by itself" : "Pulse will ask instead")} /><span>Finish it by itself</span></label> : null}
        <button type="button" className={css.textBtn} disabled={busy} onClick={() => void save({ dismiss: true }, "Pulse stopped watching")}>Stop watching</button>
      </div> : null}
    </section>;
  }
  if (!canSet || finished || state?.dismissed || !proposal.length) return null;
  return <section className={css.card} data-proposal="" aria-labelledby="done-when">
    <div className={css.head}><h2 id="done-when"><Sparkles size={16} aria-hidden="true" />Pip: done when</h2><small>Pulse can tell, and finish it for you</small></div>
    <ul className={css.signals}>{proposal.map((s) => <li key={`${s.event}:${s.label}`}><i aria-hidden="true" /><span>{s.label}</span></li>)}</ul>
    <p className={css.fine}>Pip read this from the task. Pulse only counts what happens in Pulse after the task was made, and never marks it done on a guess.</p>
    <div className={css.row}>
      <button type="button" className={css.confirm} disabled={busy} onClick={() => void save({ signals: proposal.map(({ event, label, need, distinct, where }) => ({ event, label, need, distinct, where })), autoDone: true }, "Pulse is watching for these")}><Check size={14} aria-hidden="true" />Confirm</button>
      <button type="button" className={css.textBtn} disabled={busy} onClick={() => void save({ dismiss: true }, "Pip will not suggest it again")}>Not needed</button>
    </div>
  </section>;
}
