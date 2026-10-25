// R49: how one requirement was read for one person, in words, with the arithmetic. Shared by HR's job page and the
// person's own check on their Skills & CV tab, so both read the same explanation (migration 0370).
import { Badge } from "../../ui";
import css from "./jobs.module.css";

export type Weights = Record<"required" | "preferred" | "verified" | "approvedWork" | "self" | "close" | "notRecent", number>;
export type Scale = { confirmed: boolean; levels: { level: number; label: string; description: string }[] };
export type Considered = { skillId: string; label: string; family: string; via: "same" | "alternative" | "replaced" | "exact" | "close"; viaFactor: number;
  selfLevel: number; verified: { level: number; by: string | null; basis: string; at: string } | null; verifiedEarlier: boolean; approvedWork: number;
  level: number; basis: "verified" | "approvedWork" | "self"; basisFactor: number; lastUsed: string | null; recent: boolean; meetsLevel: boolean;
  factor: number; counted: boolean };
export type Outcome = "matched" | "unknown" | "missing";
export type ReqResult = { requirementId?: string; label: string; importance: "required" | "preferred"; minLevel: number | null; recentMonths: number | null;
  weight: number; outcome: Outcome; points: number; considered: Considered[]; related: string[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const month = (m: string | null | undefined) => m && /^\d{4}-\d{2}/.test(m) ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "";
/** Points and factors as people write them: 3, 1.8, 0.75. */
export const num = (x: number | string | null | undefined) => Number(x ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
export const levelName = (scale: Scale, n: number | null | undefined) => n ? scale.levels.find((l) => l.level === n)?.label ?? `level ${n}` : "";
export const OUTCOME: Record<Outcome, { label: string; tone: "success" | "neutral" | "warning" }> = {
  matched: { label: "Matched", tone: "success" }, unknown: { label: "Unknown", tone: "neutral" }, missing: { label: "Below the level asked", tone: "warning" } };
export const STATUS: Record<"draft" | "open" | "closed", { label: string; tone: "neutral" | "success" | "warning" }> = {
  draft: { label: "Draft", tone: "neutral" }, open: { label: "Open", tone: "success" }, closed: { label: "Closed", tone: "warning" } };
const VIA: Record<Considered["via"], string> = { same: "", alternative: " (the job accepts it as the same)", replaced: " (the list replaced it with this skill)",
  exact: " (the same skill in another list)", close: " (a close match in another list)" };
const BASIS: Record<string, string> = { manager: "manager", hr: "HR" };

/** What the job asks for one skill: required or preferred, the level and how recently. */
export function Ask({ r, scale }: { r: Pick<ReqResult, "importance" | "minLevel" | "recentMonths">; scale: Scale }) {
  return <span className={css.ask}><Badge tone={r.importance === "required" ? "accent" : "neutral"}>{r.importance === "required" ? "Required" : "Preferred"}</Badge>
    {r.minLevel ? <span>at least {levelName(scale, r.minLevel)}</span> : <span>any level</span>}
    {r.recentMonths ? <span>used in the last {r.recentMonths} months</span> : null}</span>;
}

function how(c: Considered, scale: Scale) {
  const lvl = levelName(scale, c.level);
  if (c.basis === "verified" && c.verified) return `verified ${lvl} by ${c.verified.by ?? "someone"} (${BASIS[c.verified.basis] ?? c.verified.basis})${c.selfLevel !== c.level ? `; self-assessed ${levelName(scale, c.selfLevel)}` : ""}`;
  const work = c.approvedWork ? `, with ${c.approvedWork} piece${c.approvedWork === 1 ? "" : "s"} of approved work` : "";
  return `self-assessed ${lvl}${work}${c.verifiedEarlier ? " · verified before the last change, so it counts as self-assessed" : ""}`;
}

/** One requirement: the outcome, every skill on record that could answer it, and the arithmetic for the one that counts. */
export function RequirementExplain({ r, scale, weights, who, self }: { r: ReqResult; scale: Scale; weights: Weights; who: string; self?: boolean }) {
  return <div className={css.req} data-outcome={r.outcome}>
    <div className={css.reqHead}>
      <span className={css.reqName}><b>{r.label}</b><Ask r={r} scale={scale} /></span>
      <span className={css.reqScore}><Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge><span>{num(r.points)} of {num(r.weight)}</span></span>
    </div>
    {r.outcome === "unknown" ? <p className={css.why}>{self ? "Nothing on record for this skill yet. It counts 0, never a minus: add it to your skills if you have it."
      : `Nothing on record for this skill. That is not a sign ${who} can’t do it: it counts 0, never a minus. Ask, or ask ${who} to check.`}
      {r.related.length ? <> Related skills on record (not counted): {r.related.join(", ")}.</> : null}</p> : null}
    {r.considered.length ? <ul className={css.considered}>{r.considered.map((c) => {
      const steps = [`${num(r.weight)} (${r.importance})`, `${num(c.basisFactor)} (${c.basis === "verified" ? "verified" : c.basis === "approvedWork" ? "self-assessed with approved work" : "self-assessed"})`];
      if (c.viaFactor !== 1) steps.push(`${num(c.viaFactor)} (close match)`);
      if (!c.recent) steps.push(`${num(weights.notRecent)} (not used in the last ${r.recentMonths} months)`);
      return <li key={c.skillId} data-counted={c.counted ? "" : undefined}>
        <span><b>{c.label}</b>{VIA[c.via]}: {how(c, scale)}{c.lastUsed ? ` · last used ${month(c.lastUsed)}` : " · in use now"}</span>
        <small>{!c.meetsLevel ? `Below the level asked (${levelName(scale, c.level)}; the job asks ${levelName(scale, r.minLevel)}): counts 0. ${self ? "If your level is higher now, change it above or ask to be verified again." : "The person can change it, or be verified again."}`
          : c.counted ? `Counts: ${steps.join(" × ")} = ${num(r.points)}`
          : `On record, not added: one skill counts per requirement, the strongest (this one would give ${num(r.weight * c.factor)}).`}</small>
      </li>;
    })}</ul> : null}
  </div>;
}

/** The published method in a few lines, with the weights in force. */
export function MethodText({ w }: { w: Weights }) {
  return <ul className={css.method}>
    <li>A <b>required</b> skill is worth <b>{num(w.required)}</b> points, a <b>preferred</b> one <b>{num(w.preferred)}</b>.</li>
    <li>A match counts in full when a manager, pod head or HR <b>verified</b> it at the level asked (×{num(w.verified)}); <b>{num(w.approvedWork)}</b> when it is self-assessed with approved work; <b>{num(w.self)}</b> when only self-assessed.</li>
    <li>A skill the job accepts as the same, or the same skill in another list, counts like the skill; a <b>close match</b> ×{num(w.close)}; not used within the months asked ×{num(w.notRecent)}.</li>
    <li>Below the level asked counts 0 (it can be corrected). <b>Unknown</b> (nothing on record) counts 0 and is never a minus: “up to” shows what checking could add.</li>
    <li>Only skills, verifications and approved work are read: never attendance, leave, pay, chats, app activity, contact or private details. Pulse ranks; people decide, and nobody is rejected by Pulse.</li>
  </ul>;
}
