"use client";
// CASE-STUDIES (owner, 10 Nov 2026): one suggested goal (typed rules, services/api/src/case-studies-model.ts): the metric,
// the rule's verdict, "now → target" and the plain reasons, with "Make it a goal". Used by a case file and by Goals.
import { Target } from "lucide-react";
import { Chip } from "../kit/game";
import { rupees } from "../lib/goals.mjs";
import type { Suggestion } from "./model";
import css from "./case.module.css";

const METRIC: Record<Suggestion["metric"], { name: string; show: (n: number) => string; unit: string }> = {
  revenue: { name: "Revenue", show: (n) => rupees(n), unit: "a month" },
  clients: { name: "New clients", show: (n) => String(n), unit: "a month" },
  leads: { name: "Leads", show: (n) => String(n), unit: "a month" },
};
const VERDICT: Record<Suggestion["verdict"], { text: string; tone?: "good" | "warn" | "accent" }> = {
  grow: { text: "Grow", tone: "good" }, recover: { text: "Win it back", tone: "accent" }, steady: { text: "Stop the fall", tone: "warn" }, need_data: { text: "Needs numbers" },
};
export function SuggestionCard({ s, make, makeLabel = "Make it a goal" }: { s: Suggestion; make?: (s: Suggestion, el: HTMLElement) => void; makeLabel?: string }) {
  const m = METRIC[s.metric], v = VERDICT[s.verdict];
  return <li className={css.sug}>
    <div className={css.sugHead}><b>{m.name}</b><Chip tone={v.tone}>{v.text}</Chip></div>
    {s.verdict === "need_data" || s.low === null || s.high === null ? <p className={css.sugBig} data-muted="">Not enough numbers yet</p>
      : <p className={css.sugBig}><span>{m.show(s.baseline ?? 0)}</span><span aria-hidden="true">→</span><b>{s.low === s.high ? m.show(s.high) : `${m.show(s.low)}–${m.show(s.high)}`}</b><small>{m.unit}</small></p>}
    <ul className={css.reasons}>{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
    {make && s.verdict !== "need_data" ? <button type="button" className={css.linkBtn} onClick={(e) => make(s, e.currentTarget)}><Target size={14} aria-hidden="true" />{makeLabel}</button> : null}
  </li>;
}

