"use client";
// TASKS-4B: Settings → Who can do what → Reviews and value. The company's review policy (docs/ops/VALUE.md): who reviews
// by default, the rating, how leadership's and founders' work is accepted, the bonus for above and beyond, the credit
// for helping and when Pulse nudges a reviewer. Leadership and admins change it; everyone reads it.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import type { ReviewPolicy } from "./types";
import css from "./work-two.module.css";
import { dest } from "../destinations/registry.mjs";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
type Data = ReviewPolicy & { canEdit: boolean; updatedBy: string | null };
const BY = [{ key: "assigner", label: "Whoever assigned it", hint: "The default. Self-made work goes to the person’s head." }, { key: "head", label: "The person’s head", hint: "Pod head or manager, whoever assigned it." },
  { key: "creator", label: "Whoever created it", hint: "Stays with the creator when the work changes hands." }] as const;
const SCALE = [{ key: "three", label: "Great · Good · Needs work", hint: "One tap. The default." }, { key: "five", label: "1 to 5", hint: "Finer, slower." }] as const;
const LEADERS = [{ key: "acknowledge", label: "Accepted with one tap", hint: "The default. No grade; their scorecard is outcomes." },
  { key: "auto_proof", label: "Accepted once proof is attached", hint: "No tap needed when a link or file is there." }, { key: "review", label: "Reviewed like everyone’s", hint: "A quality rating, as for the team." }] as const;
// UX-5B: when everything a task's confirmed signals watch for has happened (docs/ops/VALUE.md, "Finishing by itself").
const AUTO = [{ key: "on", label: "Pulse marks it done", hint: "The default. Only when every confirmed signal happened exactly; the doer can undo, the reviewer reviews as usual." },
  { key: "ask", label: "Pulse asks first", hint: "The companion asks whoever does it to mark it done." }] as const;

export function ReviewSettings({ data }: { data: Data }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const [v, setV] = useState({ reviewBy: data.reviewBy, reviewScale: data.reviewScale, reviewLeaders: data.reviewLeaders, autoDone: data.autoDone ?? "on", aboveBonus: String(data.aboveBonus), helpPoints: String(data.helpPoints), reviewNudgeHours: String(data.reviewNudgeHours) });
  async function save(body: Record<string, unknown>, ok: string) {
    setBusy(true); try { await post("work/settings", body); notify({ id: "review-policy", tone: "success", title: ok, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "review-policy", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const pick = <K extends "reviewBy" | "reviewScale" | "reviewLeaders" | "autoDone">(key: K, opts: readonly { key: string; label: string; hint: string }[], label: string) =>
    <div className={css.policyRow}><h3>{label}</h3><div className={css.models} role="radiogroup" aria-label={label}>{opts.map((o) => <button key={o.key} type="button" role="radio" aria-checked={v[key] === o.key} disabled={!data.canEdit || busy}
      onClick={() => { setV({ ...v, [key]: o.key }); void save({ [key]: o.key }, `${label}: ${o.label.toLowerCase()}`); }}><b>{o.label}</b><small>{o.hint}</small></button>)}</div></div>;
  const num = (key: "aboveBonus" | "helpPoints" | "reviewNudgeHours", label: string, unit: string, min: number, max: number) =>
    <label className={css.limit}>{label}<input type="number" min={min} max={max} value={v[key]} disabled={!data.canEdit || busy} onChange={(e) => setV({ ...v, [key]: e.target.value })}
      onBlur={() => { if (Number(v[key]) !== data[key]) void save({ [key]: Number(v[key]) }, "Saved"); }} />{unit}</label>;
  return <section className={css.model} aria-labelledby="review-policy-title" {...dest("settings.work-rules.reviews")}>
    <header><h2 id="review-policy-title">Reviews</h2><p>Tasks carry no value points: nobody is credited points for work, so no number moves by anyone’s own clicks. On acceptance the reviewer says only how good the work was. Leadership and admins change this; it applies to everyone at once.</p></header>
    {pick("reviewBy", BY, "Who reviews")}
    {pick("reviewScale", SCALE, "The rating")}
    {pick("reviewLeaders", LEADERS, "Leadership’s and founders’ work")}
    {pick("autoDone", AUTO, "When Pulse sees a task done")}
    <div className={css.autoRow}>
      {num("reviewNudgeHours", "Nudge reviewers, and whoever others wait on, after", "hours", 4, 168)}
    </div>
    {data.updatedBy ? <p className={css.formNote}>Last changed by {data.updatedBy}.</p> : null}
  </section>;
}
