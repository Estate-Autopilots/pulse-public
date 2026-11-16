"use client";

// KAZUK-V2 G14 (Kazuk, 6 Nov 2026, R48; test T28): when a salesperson gives a discount on a quotation, their Sales
// Agent suggests what to offer first, in EA's order: better payment terms, then a bonus, then one package down. It is
// advice only: nothing waits on it and the price stays the salesperson's (the company has no approval step). The rule
// is typed, in the database (pulse.sales_discount_advice, 1932): GET /api/v0/sales-agent/advice.
import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import css from "../documents.module.css";

type Advice = { blocks: false; pct: number; level: "none" | "small" | "big"; say: string; steps: { key: string; title: string; detail: string }[]; note: string };

export function DiscountAdvice({ pct, amount, packageId }: { pct: number; amount: number; packageId: string | null }) {
  const [advice, setAdvice] = useState<Advice | null>(null);
  const shown = Math.round(pct * 10) / 10;
  useEffect(() => {
    if (!(shown > 0)) return;
    const ask = new AbortController();
    const t = setTimeout(() => {
      const q = new URLSearchParams({ discount: String(Math.min(100, shown)), amount: String(Math.max(0, Math.round(amount))), ...(packageId ? { package: packageId } : {}) });
      fetch(`/api/v0/sales-agent/advice?${q}`, { signal: ask.signal }).then((r) => (r.ok ? r.json() : null)).then((a: Advice | null) => setAdvice(a)).catch(() => undefined);
    }, 450);
    return () => { clearTimeout(t); ask.abort(); };
  }, [shown, amount, packageId]);
  if (!(shown > 0) || !advice || !advice.steps.length) return null;
  return <div className={css.flag} data-tone="info" role="note" aria-label="Your Sales Agent suggests">
    <b className={css.adviceTitle}><Lightbulb size={14} aria-hidden="true" /> Your Sales Agent suggests</b>
    <span>Your prices are {shown}% under the catalogue. {advice.say}</span>
    <ol className={css.adviceSteps}>{advice.steps.map((s) => <li key={s.key}><b>{s.title}.</b> {s.detail}</li>)}</ol>
    <span className={css.adviceNote}>{advice.note}</span>
  </div>;
}
