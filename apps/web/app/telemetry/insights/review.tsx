"use client";
// TOKENS-2 (2280): work its AI employees did the same way again and again, waiting for an admin's yes before it becomes
// the known way (POST /api/v0/telemetry/ai-rules {key, on}; ai_heuristic_set, audited). A yes: the AI employees get it
// with their engines, follow those steps and start on a cheaper model. A no: it is not suggested again.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton, toast } from "../../kit/game";
import { Badge } from "../../ui";
import css from "./insights.module.css";

export type Pattern = { key: string; title: string; state: string; uses: number; saved: number;
  evidence: { runs?: number; agents?: number; avgTokens?: number; days?: number; tools?: string[]; shape?: string | null } | null };

/** An answer's shape in words: "task:comment+status=waiting" -> "a comment and the status set to waiting". */
const SHAPE: Record<string, string> = { comment: "a comment", files: "a file", subtasks: "sub-tasks", followups: "follow-ups", plan: "a plan" };
export function shapeWords(s: string) {
  const [kind, what = "", size = ""] = s.split(":");
  if (kind === "chat") return `${size === "short" ? "a short " : size === "long" ? "a long " : "a "}${what === "reply" ? "reply" : what.replace(/_/g, " ")}`;
  return what.split("+").map((p) => (p.startsWith("status=") ? `the status set to ${p.slice(7).replace(/_/g, " ")}` : SHAPE[p] ?? p)).join(" and ");
}
const titleWords = (t: string) => t.replace(/\(((?:task|chat):[^)]+)\)/, (_, x: string) => `(${shapeWords(x)})`).replace(/_/g, " ");
const tok = (n: number) => (n >= 1e5 ? `${(n / 1e5).toFixed(1)} lakh` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

export function PatternReview({ items, canReview }: { items: Pattern[]; canReview: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null), [gone, setGone] = useState<Record<string, true>>({});
  async function decide(key: string, on: boolean) {
    setBusy(key);
    try {
      const r = await fetch("/api/v0/telemetry/ai-rules", { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ key, on, note: on ? "Approved on Insights" : "Not now, on Insights" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not save. Try again.");
      setGone((g) => ({ ...g, [key]: true }));
      toast(on ? "Saved. AI employees will do it this way from now on." : "Set aside. It won't be suggested again.");
      router.refresh();
    } catch (e) { toast((e as Error).message, { tone: "bad" }); } finally { setBusy(null); }
  }
  const open = items.filter((p) => !gone[p.key]);
  if (!open.length) return <p className={css.lead}>Nothing to review. When AI employees do the same job the same way 5 times, it shows here.</p>;
  return <ul className={css.rows}>{open.map((p) => {
    const e = p.evidence ?? {};
    return <li key={p.key} className={css.review} data-pattern={p.key}>
      <span className={css.agentName}><b>{titleWords(p.title)}</b>
        <span>Done this way {e.runs ?? 0} times in {e.days ?? 14} days{(e.agents ?? 0) > 1 ? ` by ${e.agents} AI employees` : ""} · about {tok(e.avgTokens ?? 0)} tokens each</span></span>
      {canReview ? <span className={css.actions}>
        <ActionButton small action={{ label: "Make it a rule", onClick: () => void decide(p.key, true), busy: busy === p.key, disabled: !!busy }} />
        <ActionButton small action={{ label: "Not now", onClick: () => void decide(p.key, false), disabled: !!busy }} />
      </span> : <Badge tone="neutral">An admin decides</Badge>}
    </li>;
  })}</ul>;
}
