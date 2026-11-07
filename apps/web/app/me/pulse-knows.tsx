import { Eye } from "lucide-react";
import { dayYear } from "../lib/format";
import { CorrectButton } from "./my-pulse-actions";
import type { MyPulse } from "./my-pulse";
import css from "./my-pulse.module.css";

const STAGE: Record<string, string> = { candidate: "Candidate", offer: "Offer", joining: "Joining", probation: "On probation", active: "Working here", notice: "On notice", left: "Alumni" };

/** UX-5A: "What Pulse knows about me", on the person's own profile (My info) instead of My desk: each fact, where it
 *  comes from, and "Not right?" which sends a correction to HR. */
export function PulseKnows({ knows }: { knows: MyPulse["knows"] }) {
  const facts = knows.filter((k) => k.value !== null && k.value !== "");
  return <section className={css.card} aria-label="What Pulse knows about me">
    <header><h3><Eye size={15} aria-hidden="true" />What Pulse knows about me</h3><small>in plain words</small></header>
    <dl className={css.facts}>{facts.map((k) => { const value = k.key === "joined" ? dayYear(String(k.value)) : k.key === "stage" ? STAGE[String(k.value)] ?? String(k.value) : String(k.value);
      return <div key={k.key}><dt>{k.label}</dt><dd>{value}<small>{k.source}</small></dd><CorrectButton label={k.label} value={value} /></div>; })}</dl>
    <p className={css.muted}>Only you, HR and the founders see your pay, and every look is logged.</p>
  </section>;
}
