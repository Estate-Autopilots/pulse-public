// BILLING-KIT (18 Oct 2026): one next step (rule 6 of the billing blueprint). Every record shows a single main button
// whose label follows its state (Approve, Send, Log reply, Make proforma, Make invoice, Record payment), with what still
// blocks it in words beside it. On a computer it sits at the end of the page; on a phone it stays at the bottom of the
// screen, inside thumb reach, above the tab bar. ChainBar shows the documents made from one another
// (Quotation → Proforma → Tax invoice), so nobody hunts for "Convert". Server-safe: no hooks.
import Link from "next/link";
import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import css from "./next-step.module.css";

export type ChainStep = { key: string; label: ReactNode; href?: string; sub?: ReactNode };

/** The chain of documents: done ones tick and link back, the current one is filled, later ones are quiet. */
export function ChainBar({ steps, current, label = "Document chain" }: { steps: ChainStep[]; current: string; label?: string }) {
  const at = steps.findIndex((s) => s.key === current);
  return <nav className={css.chain} aria-label={label}>
    <ol>{steps.map((s, i) => {
      const state = i < at ? "done" : i === at ? "now" : "next";
      const body = <>{state === "done" ? <Check size={12} aria-hidden="true" /> : null}<span>{s.label}</span>{s.sub ? <small>{s.sub}</small> : null}</>;
      return <li key={s.key} data-state={state}>
        {s.href && state !== "now" ? <Link href={s.href} className={css.step}>{body}</Link> : <span className={css.step} aria-current={state === "now" ? "step" : undefined}>{body}</span>}
        {i < steps.length - 1 ? <ChevronRight size={13} className={css.sep} aria-hidden="true" /> : null}
      </li>;
    })}</ol>
  </nav>;
}

/** The one main button (`primary`), quiet ones before it (`secondary`), and `status`: what it does or what blocks it. */
export function NextStep({ primary, secondary, status, tone = "info", label = "Next step", className }: {
  primary: ReactNode; secondary?: ReactNode; status?: ReactNode; tone?: "info" | "warning" | "error"; label?: string; className?: string;
}) {
  return <section className={`${css.next}${className ? ` ${className}` : ""}`} aria-label={label}>
    <p className={css.status} data-tone={tone} role={tone === "error" ? "alert" : undefined} aria-live="polite">{status}</p>
    <div className={css.actions}>{secondary}{primary}</div>
  </section>;
}
