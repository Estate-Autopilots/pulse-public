"use client";
// UX-DELIGHT (6 Nov 2026, owner: "a gamified feel in Finance too, kept professional"): how much of what was billed has
// come in, as a ring; how many months in a row money came in, as a streak; and a quiet toast (with a small burst) the
// first time the ring passes a half, three quarters or all of it in this period on this device. Figures are Numbers'
// own (paise, without GST); nothing new is computed on the server.
import { useEffect, useState } from "react";
import { Flame, Target } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { StripeCard } from "../components/kit";
import { rupees } from "../lib/finance-numbers.mjs";
import { milestone, streakOf } from "../lib/task-states.mjs";
import { burst } from "../lib/motion";
import type { NumbersData } from "./numbers";
import css from "./progress.module.css";

const STEPS = [0.5, 0.75, 1] as const;
const WORDS: Record<string, string> = { "0.5": "Half of what was billed is in", "0.75": "Three quarters of what was billed is in", "1": "Everything billed is collected" };

function Ring({ ratio, label }: { ratio: number; label: string }) {
  const r = 34, c = 2 * Math.PI * r, [shown, setShown] = useState(0);
  // The ring fills from empty once on arrival (CSS transition; none with reduced motion).
  useEffect(() => { const f = requestAnimationFrame(() => setShown(ratio)); return () => cancelAnimationFrame(f); }, [ratio]);
  return <svg className={css.ring} viewBox="0 0 84 84" role="img" aria-label={label}>
    <circle cx="42" cy="42" r={r} className={css.track} />
    <circle cx="42" cy="42" r={r} className={css.fill} data-full={ratio >= 1 ? "" : undefined} strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, shown))} transform="rotate(-90 42 42)" />
    <text x="42" y="47" textAnchor="middle" className={css.ringText}>{Math.round(ratio * 100)}%</text>
  </svg>;
}

export function CollectionsProgress({ d }: { d: NumbersData }) {
  const paid = d.totals.revenue, due = d.totals.baseOutstanding, billed = paid + due;
  const ratio = billed > 0 ? paid / billed : 0;
  // Months in a row with money in, counting back from the latest; the month still running only adds, never breaks.
  const latest = d.months.at(-1)?.month;
  const streak = streakOf(d.months.map((m) => ({ month: m.month, hit: m.payments > 0 || (m.collected ?? 0) > 0 ? true : m.month === latest ? null : false })));
  useEffect(() => {
    if (!billed) return;
    const key = `pulse.finance.collected.${d.period}`;
    let before = 0; try { before = Number(localStorage.getItem(key) ?? "0") || 0; } catch { /* private mode */ }
    try { localStorage.setItem(key, String(ratio)); } catch { /* private mode */ }
    const hit = milestone(before, ratio, STEPS);
    if (hit !== null && before > 0) {
      burst(document.querySelector(`.${css.ring}`));
      notify({ id: "finance-milestone", tone: "success", title: WORDS[String(hit)], message: `${rupees(paid)} of ${rupees(billed)} collected, without GST`, timeout: 5200 });
    }
  }, [billed, d.period, paid, ratio]);
  if (!billed) return null;
  return <StripeCard title="Collections" icon={Target} stripe={ratio >= 0.75 ? "good" : "in"} sub="What came in against what was billed in the period · without GST">
    <div className={css.body}>
      <Ring ratio={ratio} label={`${Math.round(ratio * 100)} percent of what was billed is collected`} />
      <dl className={css.facts}>
        <div><dt>Collected</dt><dd>{rupees(paid)}</dd></div>
        <div><dt>Still due</dt><dd data-tone={due ? "warn" : undefined}>{rupees(due)}</dd></div>
        <div className={css.next}><dt>Next mark</dt><dd>{ratio >= 1 ? "All in. Well done." : `${rupees(Math.max(0, Math.ceil((STEPS.find((s) => s > ratio) ?? 1) * billed - paid)))} more reaches ${Math.round((STEPS.find((s) => s > ratio) ?? 1) * 100)}%`}</dd></div>
      </dl>
      <p className={css.streak} data-on={streak > 1 ? "" : undefined}><Flame size={15} aria-hidden="true" />
        {streak > 1 ? <span><b>{streak} months</b> in a row with money in</span> : streak === 1 ? <span><b>1 month</b> with money in. Keep the run going.</span> : <span>No payments recorded yet in this period.</span>}</p>
    </div>
  </StripeCard>;
}
