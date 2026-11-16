"use client";
// CASE-STUDIES (owner, 10 Nov 2026: "goals connected to Finance, with suggested goals for revenue, clients per month and
// lead flow"): a card on Goals with targets suggested from the company's own numbers: revenue as Finance → Numbers counts
// it, new paying clients from Billing, leads from Leads. Fixed, typed rules (GET /api/v0/goals/suggestions; engine
// goal-rules-v1), never an AI guess. Each part shows only to people who may read its numbers; with nothing to suggest the
// card stays away. "Make it a goal" posts the goal the API prepared to /api/v0/goals, where the database decides who may set it.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { GameCard, celebrate, toast } from "../kit/game";
import { SuggestionCard } from "../case-studies/suggestion";
import type { Suggestion } from "../case-studies/model";
import css from "../case-studies/case.module.css";

type Sug = Suggestion & { goal: Record<string, unknown> | null };

export function GoalSuggestions({ canCompany }: { canCompany: boolean }) {
  const router = useRouter();
  const [list, setList] = useState<Sug[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/v0/goals/suggestions", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { if (live) setList(d?.suggestions ?? []); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  const usable = (list ?? []).filter((s) => s.verdict !== "need_data");
  if (!usable.length) return null;
  const make = async (s: Suggestion, el: HTMLElement) => {
    const goal = (s as Sug).goal; if (!goal) return;
    const r = await fetch("/api/v0/goals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goal) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(typeof d?.error === "string" ? d.error : "The goal was not made", { tone: "bad" }); return; }
    celebrate(el); toast("Goal set!"); router.refresh();
  };
  return <GameCard title={<><Sparkles size={16} aria-hidden="true" />Suggested from your numbers</>} note="Your last 3 months, by fixed rules">
    <ul className={css.sugs}>{usable.map((s) => <SuggestionCard key={s.metric} s={s} make={canCompany ? make : undefined} makeLabel="Make it a company goal" />)}</ul>
  </GameCard>;
}
