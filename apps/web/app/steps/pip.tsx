"use client";
// FLOW-C: Pip beside the work. It works on what the person points it at (the section being written, the asset's tab, the
// transcript), grounded on the step's write-up part and the run's records (the Word Library, the facts and their status,
// the known product constraints). Pip suggests; the person decides: an outline is put in only when they press it.
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { flow, why } from "../processes/flow-client";
import type { PipAction } from "../processes/flow-types";
import type { AssistResult } from "../../../../services/api/src/ai/flow-assist";
import css from "./work.module.css";

export type PipFocus = { label: string; text: string; use?: { label: string; put: (text: string) => void } };
const WORD: Record<PipAction, string> = { draft: "Draft it", critique: "Critique it", summarise: "Summarise", extract: "Pull out facts", check: "Check it", suggest: "Suggest" };
const HELP: Record<PipAction, string> = {
  draft: "An outline from the write-up's headings and what the run already has",
  critique: "Each line of what good looks like, checked",
  summarise: "The main points and the follow-ups",
  extract: "Facts with figures and sources, open questions, quotes",
  check: "Words to avoid, claims without a confirmed fact, constraints, numbers that differ",
  suggest: "Candidates to keep",
};

export function PipPanel({ stepId, actions, focus }: { stepId: string; actions: PipAction[]; focus: PipFocus | null }) {
  const [busy, setBusy] = useState<PipAction | null>(null), [out, setOut] = useState<{ action: PipAction; result: AssistResult; on: string | null } | null>(null);
  const [own, setOwn] = useState(""), [typing, setTyping] = useState(false);
  const text = typing ? own : focus?.text ?? "";
  async function ask(action: PipAction) {
    setBusy(action);
    try { const r = await flow<{ result: AssistResult }>(`steps/${stepId}/pip`, "POST", { action, text: text.trim() || undefined }); setOut({ action, result: r.result, on: typing ? null : focus?.label ?? null }); }
    catch (e) { notify({ id: "pip", tone: "error", title: "Pip could not help just now", message: why(e) }); }
    finally { setBusy(null); }
  }
  const r = out?.result, words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return <section className={css.pip} aria-label="Pip">
    <h4><span className={css.pipFace} aria-hidden="true"><Sparkles size={12} /></span>Pip<small>suggests; you decide</small></h4>
    {typing ? <textarea rows={3} value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Paste a draft or a transcript" aria-label="What Pip works on" maxLength={120000} />
      : <p className={css.pipOn}>{focus ? <>Works on <b>{focus.label}</b>{words ? ` · ${words} words` : " · empty so far"}</> : "Works on this step and the run's records"}
        <button type="button" onClick={() => { setOwn(focus?.text ?? ""); setTyping(true); }}>Paste something else</button></p>}
    {typing ? <button type="button" className={css.pipBack} onClick={() => setTyping(false)}>{focus ? `Back to ${focus.label}` : "Back"}</button> : null}
    <div className={css.pipActions}>{actions.map((a) => <button key={a} type="button" disabled={!!busy} title={HELP[a]} onClick={() => void ask(a)} aria-pressed={out?.action === a}>{busy === a ? "Working…" : WORD[a]}</button>)}</div>
    {r ? <div className={css.pipOut} aria-live="polite">
      {out?.on ? <small className={css.basis}>On {out.on}</small> : null}
      {r.summary?.length ? <List title="Summary" items={r.summary} /> : null}
      {r.followups?.length ? <List title="Follow-ups" items={r.followups} /> : null}
      {r.findings ? r.findings.length ? <ul className={css.findings}>{r.findings.map((f, i) => <li key={i} data-level={f.level}><b>{f.text}</b>{f.suggestion ? <span>{f.suggestion}</span> : null}<small>{f.rule}{f.where ? ` · ${f.where}` : ""}</small></li>)}</ul>
        : <p className={css.ok}>Nothing to fix against the Word Library, the facts and the constraints.</p> : null}
      {r.checks?.length ? <ul className={css.findings}>{r.checks.map((c, i) => <li key={i} data-level={c.verdict === "looks ok" ? "ok" : c.verdict === "missing" ? "fix" : "check"}><b>{c.test}: {c.verdict}</b><small>{c.why}</small></li>)}</ul> : null}
      {r.facts?.length ? <List title="Facts" items={r.facts.map((f) => `${f.statement}${f.source ? ` (${f.source})` : ""}`)} /> : null}
      {r.openItems?.length ? <List title="Open questions" items={r.openItems.map((o) => `${o.question} · ${o.tag}`)} /> : null}
      {r.quotes?.length ? <List title="Quotes" items={r.quotes} /> : null}
      {r.tags?.length ? <List title="Tagged" items={r.tags.map((t) => `${t.tag}: ${t.line}`)} /> : null}
      {r.outline ? <>
        <pre className={css.outline}>{r.outline}</pre>
        {focus?.use && !typing ? <button type="button" className={css.pipUse} onClick={() => focus.use!.put(r.outline!)}>{focus.use.label}</button> : null}
      </> : null}
      {r.basis?.length ? <p className={css.basis}>Based on: {r.basis.join(" · ")}</p> : null}
    </div> : null}
  </section>;
}
const List = ({ title, items }: { title: string; items: string[] }) => <div><b className={css.listTitle}>{title}</b><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
