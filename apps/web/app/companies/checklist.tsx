// R53: the setup plan as rows and the activation checklist as a guide, shared by the operator's wizard and the
// company's own Settings → Organisation → Setup. Presentational only: the database decides what each row and gate is.
import { AlertTriangle, ArrowUpRight, Check, Clock, Info, Minus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "../ui";
import css from "./companies.module.css";
import type { GuideStep, Plan, PlanAction, Readiness } from "./types";

const AREA: Record<string, string> = { company: "Company", address: "Address", defaults: "Defaults", modules: "Modules", roles: "Roles", storage: "Storage", sources: "Sources", copied: "Copied" };
const ACTION: Record<PlanAction["action"], { label: string; tone: "success" | "accent" | "neutral" }> = {
  create: { label: "Create", tone: "success" }, update: { label: "Change", tone: "accent" }, keep: { label: "Keep", tone: "neutral" }, none: { label: "Note", tone: "neutral" },
};
/** A source row's value as words (the plan carries it as JSON text). */
function value(a: PlanAction, which: "before" | "after"): string {
  const v = a[which];
  if (v == null) return "—";
  if (a.area !== "sources" || !v.startsWith("{")) return v;
  try { const s = JSON.parse(v); return [s.kind === "google_drive" ? "Google Drive (EA Connect)" : s.kind === "plugin" ? `plugin ${s.connector}` : s.kind, s.categories?.length ? s.categories.join(", ") : null, `granted by ${s.grants}`].filter(Boolean).join(" · "); }
  catch { return v; }
}

export function PlanTable({ plan, areas }: { plan: Plan; areas?: string[] }) {
  const rows = plan.actions.filter((a) => !areas || areas.includes(a.area));
  return <>
    <div className={css.summary}>
      <Badge tone="success">{plan.summary.create} to create</Badge><Badge tone="accent">{plan.summary.update} to change</Badge><Badge>{plan.summary.keep} kept</Badge>
      {plan.applied ? <Badge tone="success">Applied in one transaction</Badge> : <Badge tone="warning">Preview: nothing written yet</Badge>}
    </div>
    <div className={css.tableWrap}><table className={css.table}>
      <thead><tr><th>Part</th><th>What</th><th>Now</th><th>After</th><th>Row</th></tr></thead>
      <tbody>{rows.map((a) => <tr key={a.key}>
        <td>{AREA[a.area] ?? a.area}{a.table ? <small className={css.mono}>{a.table}</small> : null}</td>
        <td><b>{a.item}</b>{a.needsApproval?.length ? <small>Needs the company admin&apos;s specific approval: {a.needsApproval.join(", ")}</small> : null}</td>
        <td>{a.action === "create" ? "—" : value(a, "before")}</td>
        <td>{value(a, "after")}</td>
        <td><Badge tone={ACTION[a.action].tone}>{ACTION[a.action].label}</Badge></td>
      </tr>)}</tbody>
    </table></div>
  </>;
}

const STATE: Record<GuideStep["state"], { icon: ReactNode; data: string; label: string }> = {
  done: { icon: <Check size={12} aria-hidden="true" />, data: "done", label: "Done" },
  todo: { icon: null, data: "todo", label: "To do" },
  blocked: { icon: <AlertTriangle size={12} aria-hidden="true" />, data: "blocked", label: "Blocked" },
  waiting: { icon: <Clock size={12} aria-hidden="true" />, data: "info", label: "Waiting for an earlier step" },
  later: { icon: <Minus size={12} aria-hidden="true" />, data: "info", label: "After activation" },
};

export function GuideList({ steps }: { steps: GuideStep[] }) {
  return <ul className={css.items}>{steps.map((s) => <li key={s.key}>
    <span className={css.state} data-state={STATE[s.state].data} title={STATE[s.state].label}>{STATE[s.state].icon}</span>
    <span>
      <b>{s.title}</b>{" "}
      <span className={css.tags}>
        <Badge tone={s.who === "Pulse" ? "accent" : s.who === "Owner" ? "warning" : "neutral"}>{s.who}</Badge>
        <Badge tone="neutral">{s.how === "automatic" ? "Automatic" : "By hand"}</Badge>
        {s.gate && s.state !== "done" ? <Badge tone="danger">Blocks activation</Badge> : null}
        {s.errands.map((e) => <Badge key={e} tone="warning">Owner errand {e}</Badge>)}
      </span>
      <small>{s.detail}</small>
      {s.href && (s.state === "todo" || s.state === "blocked") ? <Link href={s.href} className={css.guideLink}>Open<ArrowUpRight size={12} aria-hidden="true" /></Link> : null}
    </span>
  </li>)}</ul>;
}

export function GateLine({ blocked, live, open }: { blocked: string[]; live: boolean; open: boolean }) {
  if (live) return <Badge tone="success">Live for staff</Badge>;
  if (!open) return <Badge tone="warning">Being set up</Badge>;
  return blocked.length ? <Badge tone="warning">Trial · {blocked.length} {blocked.length === 1 ? "gate" : "gates"} open</Badge> : <Badge tone="success">Trial · ready to activate</Badge>;
}

/** R54: the explicit readiness result, the same words for the operator and the company. A rehearsal says so first. */
export function ReadinessNote({ r }: { r: Readiness }) {
  const tone = r.verdict === "not_ready" ? "warning" : r.rehearsal ? "info" : "success";
  return <div className={css.banner} data-tone={tone}>
    {r.verdict === "not_ready" ? <AlertTriangle size={16} aria-hidden="true" /> : r.rehearsal ? <Info size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
    <span>
      <b>{r.title}.</b> {r.summary}
      {r.errands.length ? <span className={css.tags} style={{ display: "flex", marginTop: 6 }}>{r.errands.map((e) => <Badge key={e} tone="warning">Owner errand {e}</Badge>)}</span> : null}
      {r.evidence.length ? <small style={{ display: "block", marginTop: 6 }}>Pilot evidence: {r.evidence.join("; ")}</small> : null}
    </span>
  </div>;
}

export function TrialNote({ name }: { name: string }) {
  return <p className={css.banner} data-tone="info"><Info size={16} aria-hidden="true" /><span><b>Trial.</b> Only {name}&apos;s admins, HR and leadership can sign in. Everyone else waits until the platform operator activates it for staff, once every gate below passes. Nothing is e-mailed by this checklist.</span></p>;
}
