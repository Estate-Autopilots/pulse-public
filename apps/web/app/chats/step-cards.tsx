"use client";
// PM-BUILD-4 (KAZUK-PM-2 phase 3, "the chat moves the board"; migration 2520): what someone writes in a project's group
// ("M1 first draft done", "access granted, done") gives them ONE private card under their own message: "Move “Make the
// first set” to First draft? Yes · Not this". Only they see it (nothing is posted in the group, so nothing reaches a
// client); their tap moves the step through the same rules as the step page, and Undo puts it back for a day.
import { useEffect, useMemo, useState } from "react";
import { Check, EyeOff, Undo2 } from "lucide-react";
import { get, send } from "./net";
import css from "./step-cards.module.css";

export type StepCandidate = { id: string; code: string | null; title: string; status: string };
export type StepCardData = { id: string; kind: "chat" | "backfill" | "checkin"; what: "round" | "started" | "done"; round: string | null; quote: string | null;
  candidates: StepCandidate[]; state: "open" | "yes" | "no" | "undone" | "expired"; applied: { tasks: { id: string; from: string; to: string }[] } | null;
  channelId: string | null; messageId: string | null; projectId: string; project: string | null; createdAt: string; answeredAt: string | null };

/** The viewer's cards in one group, by the message they came from. Read again when the conversation syncs. */
export function useStepCards(channelId: string, on: boolean, bump: number) {
  const [list, setList] = useState<StepCardData[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void get<{ cards: StepCardData[] }>(`step-cards?channel=${encodeURIComponent(channelId)}`)
      .then((d) => { if (live) setList(d.cards); })
      .catch(() => { /* no cards until the next sync */ });
    return () => { live = false; };
  }, [channelId, on, bump]);
  return useMemo(() => new Map(list.filter((c) => c.messageId).map((c) => [c.messageId!, c])), [list]);
}

const quoteTitle = (c: StepCandidate) => `“${c.title}”`;
/** The question in words: "Move “Model video” to First draft?", "Mark “Access granted” done?". */
export function askWords(card: Pick<StepCardData, "what" | "round" | "kind" | "candidates">, step: StepCandidate | null): string {
  if (card.kind === "backfill") return card.candidates.length === 1 ? `Was ${quoteTitle(card.candidates[0])} finished too?` : "Were these finished too?";
  if (card.kind === "checkin") return step ? `Is ${quoteTitle(step)} done?` : "Is it done?";
  if (!step) return "Which step is this?";
  return card.what === "round" ? `Move ${quoteTitle(step)} to ${card.round ?? "the next draft"}?` : card.what === "started" ? `Mark ${quoteTitle(step)} as started?` : `Mark ${quoteTitle(step)} done?`;
}
/** What happened, after Yes, in words: "Moved to First draft", "Marked as started", "Marked done". */
export function doneWords(card: Pick<StepCardData, "what" | "round">): string {
  return card.what === "round" ? `Moved to ${card.round}` : card.what === "started" ? "Marked as started" : "Marked done";
}
/** The step(s) it moved: "“Model video”". */
export function doneSteps(card: Pick<StepCardData, "candidates" | "applied">): string {
  const ids = new Set((card.applied?.tasks ?? []).map((t) => t.id));
  const steps = card.candidates.filter((c) => ids.has(c.id));
  return steps.length ? steps.map(quoteTitle).join(", ") : "";
}

export function StepCardView({ card: start, quiet, note }: { card: StepCardData; /** Outline answer (a list where another card holds the filled one). */ quiet?: boolean;
  /** The card's top line in a list (My day says once that the cards are private): "You wrote “…”". */ note?: string }) {
  const [card, setCard] = useState(start);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  if (card.state === "no" || card.state === "undone" || card.state === "expired") return null;
  const one = card.candidates.length === 1 || card.kind === "backfill" ? card.candidates[0] : null;
  const act = async (answer: "yes" | "no" | "undo", taskId?: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await send<{ state: StepCardData["state"]; tasks?: { id: string; from: string; to: string }[] }>(`step-cards/${card.id}/answer`, { answer, taskId });
      setCard({ ...card, state: r.state, applied: r.tasks ? { tasks: r.tasks } : card.applied });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className={css.card} data-state={card.state} data-step-card={card.id} aria-live="polite">
    {card.kind === "checkin" || note ? <p className={css.only}><span>{card.kind === "checkin" ? card.quote : note}</span></p>
      : <p className={css.only}><EyeOff aria-hidden="true" /><span>Only you see this</span></p>}
    {card.state === "yes" ? <div className={css.done}><Check aria-hidden="true" /><b>{doneWords(card)}</b>
      <button type="button" className={css.undo} onClick={() => void act("undo")} disabled={busy}><Undo2 aria-hidden="true" />Undo</button>
      {doneSteps(card) ? <p className={css.doneStep}>{doneSteps(card)}</p> : null}</div>
      : <div className={css.row}>
        <p className={css.ask}>{askWords(card, one)}</p>
        {card.kind === "backfill" && card.candidates.length > 1 ? <ul className={css.list}>{card.candidates.map((c) => <li key={c.id}>{c.title}</li>)}</ul> : null}
        <div className={css.actions}>
          {one || card.kind === "backfill"
            ? <button type="button" className={css.yes} data-quiet={quiet ? "" : undefined} onClick={() => void act("yes")} disabled={busy}>{card.kind === "backfill" ? (card.candidates.length > 1 ? `Yes, all ${card.candidates.length}` : "Yes") : card.kind === "checkin" ? "Done" : "Yes"}</button>
            : card.candidates.map((c) => <button key={c.id} type="button" className={css.pick} onClick={() => void act("yes", c.id)} disabled={busy}>{c.title}</button>)}
          <button type="button" className={css.no} onClick={() => void act("no")} disabled={busy}>{card.kind === "chat" ? "Not this" : "Not yet"}</button>
        </div>
      </div>}
    {err ? <p className={css.err} role="alert">{err}</p> : null}
  </div>;
}

/** "Stop checking on me" / "Check on me again": the person's own end-of-day checks (someone waiting on them still asks). */
export function AssistantQuiet({ quiet: start }: { quiet: boolean }) {
  const [quiet, setQuiet] = useState(start), [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try { const r = await send<{ quiet: boolean }>("assistant/quiet", { on: !quiet }); setQuiet(r.quiet); } catch { /* unchanged */ } finally { setBusy(false); }
  };
  return <button type="button" className={css.quiet} onClick={() => void flip()} disabled={busy} aria-pressed={quiet}>{quiet ? "Check on me again" : "Stop checking on me"}</button>;
}
