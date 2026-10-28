"use client";
// KAZUK (28 Oct 2026), Kazuk's screen 3: after the doer takes a task given in a chat, Pulse asks on its card "When will
// you start and finish?" (Start today, Pick dates, Can't by then); a task finished after its due day asks its doer for
// one reason (footage late, client delay, revisions, other). Both answers are kept on the task (migration 1388).
import { useState, type FormEvent } from "react";
import { CalendarCheck, Clock } from "lucide-react";
import { send } from "./net";
import own from "./work.module.css";

export type TaskCommit = { start: string | null; finish: string | null; state: "committed" | "cant"; note: string | null } | null;
const REASONS: [string, string][] = [["footage_late", "Footage late"], ["client_delay", "Client delay"], ["revisions", "Revisions"], ["other", "Other"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string | null) => { if (!d) return "—"; const x = new Date(`${d}T00:00:00Z`); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };

/** The doer's commitment: asked once they took it; afterwards everyone sees the dates. */
export function CommitAsk({ taskId, commit, mine, today, due, onDone }: { taskId: string; commit: TaskCommit; mine: boolean; today: string; due: string | null; onDone: () => void }) {
  const [mode, setMode] = useState<null | "pick" | "cant">(null), [start, setStart] = useState(today), [finish, setFinish] = useState(due ?? today), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function answer(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try { await send(`tasks/${taskId}/commit`, body); setMode(null); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (commit) return <p className={own.commitLine} data-state={commit.state}><CalendarCheck size={13} aria-hidden="true" />
    {commit.state === "cant" ? <>Can&apos;t by then: <q>{commit.note}</q></> : <>Starts {short(commit.start)} · finishes {short(commit.finish)}</>}</p>;
  if (!mine) return null;
  function submit(e: FormEvent) { e.preventDefault(); if (mode === "cant") { if (!note.trim()) { setError("Say what you can do instead"); return; } void answer({ cant: true, note: note.trim() }); } else void answer({ start, finish }); }
  return <div className={own.answer} data-answer="commit">
    <p><Clock size={13} aria-hidden="true" />When will you start and finish?</p>
    {!mode ? <div className={own.buttons}>
      <button type="button" data-primary="" disabled={busy} onClick={() => void answer({ start: today, finish: due ?? today })}>Start today</button>
      <button type="button" disabled={busy} onClick={() => { setMode("pick"); setError(""); }}>Pick dates</button>
      <button type="button" disabled={busy} onClick={() => { setMode("cant"); setError(""); }}>Can&apos;t by then</button>
    </div> : <form className={own.note} onSubmit={submit}>
      {mode === "pick" ? <><input type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" required />
        <input type="date" value={finish} min={start} onChange={(e) => setFinish(e.target.value)} aria-label="Finish" required /></>
        : <input autoFocus value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="What you can do instead" aria-label="What you can do instead" />}
      <span className={own.buttons}><button type="submit" data-primary="" disabled={busy}>{mode === "pick" ? "Save" : "Send"}</button><button type="button" disabled={busy} onClick={() => setMode(null)}>Cancel</button></span>
    </form>}
    {error ? <p className={own.answerError} role="alert">{error}</p> : null}
  </div>;
}

/** A task finished after its due day: one reason, asked of its doer once. */
export function LateReason({ taskId, reason, mine, onDone }: { taskId: string; reason: string | null; mine: boolean; onDone: () => void }) {
  const [other, setOther] = useState(false), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function answer(r: string, n = "") {
    setBusy(true); setError("");
    try { await send(`tasks/${taskId}/late-reason`, { reason: r, note: n || null }); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (reason) return <p className={own.commitLine} data-state="late"><Clock size={13} aria-hidden="true" />Finished late: {REASONS.find(([k]) => k === reason)?.[1] ?? reason}</p>;
  if (!mine) return null;
  return <div className={own.answer} data-answer="late">
    <p><Clock size={13} aria-hidden="true" />Finished after its due day. One reason?</p>
    {!other ? <div className={own.buttons}>{REASONS.map(([k, l]) => <button key={k} type="button" disabled={busy} onClick={() => k === "other" ? setOther(true) : void answer(k)}>{l}</button>)}</div>
      : <form className={own.note} onSubmit={(e) => { e.preventDefault(); if (!note.trim()) { setError("Say why"); return; } void answer("other", note.trim()); }}>
        <input autoFocus value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Why it was late" aria-label="Why it was late" />
        <span className={own.buttons}><button type="submit" data-primary="" disabled={busy}>Send</button><button type="button" disabled={busy} onClick={() => setOther(false)}>Cancel</button></span>
      </form>}
    {error ? <p className={own.answerError} role="alert">{error}</p> : null}
  </div>;
}
