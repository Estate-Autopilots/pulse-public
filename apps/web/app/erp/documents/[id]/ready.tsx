"use client";
// UX-POLISH-3 (owner, 6 Nov 2026: "New invoice: good, but make it more gamified"): the draft's way to done.
//   - A stepper (who it is for, the lines, the checks, approve) fills as each part is done.
//   - The total is live, and rolls to each new figure (CountUp).
//   - Each completion check ticks with a small pop as it passes.
//   - When nothing is left, an "Invoice ready" moment lights up, with confetti once per document per browser.
// It only reads what the composer already worked out (who, lines, amounts, GSTIN, serials, totals); the composer's own
// rules still decide what can be approved.
import type { CSSProperties } from "react";
import { Check, PartyPopper } from "lucide-react";
import { CountUp } from "../../../kit/count-up";
import { Celebrate } from "../../../kit/celebrate";
import css from "./ready.module.css";

export type ReadyCheck = { key: string; label: string; done: boolean; hint?: string };

export function ReadyPath({ docId, noun, checks, total, totalText }: { docId: string; noun: string; checks: ReadyCheck[]; total: number | null; totalText: string | null }) {
  const byKey = new Map(checks.map((c) => [c.key, c.done]));
  const steps = [
    { key: "who", label: "For whom", done: !!byKey.get("client") },
    { key: "lines", label: "Lines", done: !!byKey.get("lines") && !!byKey.get("amounts") },
    { key: "checks", label: "Checks", done: checks.every((c) => c.done) },
    { key: "approve", label: "Approve", done: false },
  ];
  const ready = checks.every((c) => c.done);
  const at = steps.findIndex((s) => !s.done);
  const passed = checks.filter((c) => c.done).length;
  const title = noun.charAt(0).toUpperCase() + noun.slice(1);
  return <section className={css.card} data-ready={ready ? "" : undefined} aria-label={`${title} progress`}>
    <Celebrate when={ready && (total ?? 0) > 0} id={`doc-ready-${docId}`} />
    <ol className={css.stepper} style={{ "--p": String(Math.max(0, at) / (steps.length - 1)) } as CSSProperties}>
      {steps.map((s, i) => <li key={s.key} data-state={s.done ? "done" : i === at ? "current" : "todo"}>
        <span className={css.dot} aria-hidden="true">{s.done ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
        <span className={css.stepLabel}>{s.label}</span>
        <span className={css.srOnly}>{s.done ? "done" : i === at ? "current step" : "to do"}</span>
      </li>)}
    </ol>
    <div className={css.body}>
      <div className={css.total}>
        <small>Total</small>
        <b>{totalText ? <CountUp text={totalText} /> : "—"}</b>
        <small>{passed} of {checks.length} checks</small>
      </div>
      <ul className={css.checks} aria-label="Before it can be approved">
        {checks.map((c) => <li key={c.key} data-done={c.done ? "" : undefined}>
          <span className={css.tick} aria-hidden="true">{c.done ? <Check size={12} strokeWidth={3} /> : null}</span>
          <span>{c.label}{!c.done && c.hint ? <small>{c.hint}</small> : null}</span>
          <span className={css.srOnly}>{c.done ? "done" : "to do"}</span>
        </li>)}
      </ul>
    </div>
    {ready ? <p className={css.readyLine} role="status"><PartyPopper size={16} aria-hidden="true" /><b>{title} ready.</b> Approve it to number it and file the PDF.</p> : null}
  </section>;
}
