// SOP-WORKFLOW: small server-safe pieces shared by the SOP pages (no hooks, no "use client").
import { FileText, HardDrive, Sparkles } from "lucide-react";
import { hoursText, layoutFlow, SIZE } from "../lib/sop-flow.mjs";
import { Badge } from "../ui";
import type { SopStep } from "./types";
import css from "./sops.module.css";

export function timeText(s: Pick<SopStep, "minutes" | "slaHours">) {
  const work = s.minutes ? hoursText(s.minutes / 60) : null, sla = s.slaHours ? hoursText(s.slaHours) : null;
  return [work ? `~${work}` : null, sla ? `SLA ${sla}` : null].filter(Boolean).join(" · ") || null;
}

export const STATUS = { draft: { label: "Draft", tone: "neutral" }, active: { label: "Active", tone: "success" }, archived: { label: "Archived", tone: "warning" } } as const;
export function StatusBadge({ status }: { status: keyof typeof STATUS }) { const s = STATUS[status]; return <Badge tone={s.tone}>{s.label}</Badge>; }

/** "High · 82%": how sure Pulse is that it read a document's steps right. */
export function Confidence({ value, words }: { value: number; words?: string }) {
  const w = words ?? (value >= 0.75 ? "High" : value >= 0.5 ? "Medium" : "Low");
  return <span className={css.confidence} data-level={w.toLowerCase()} title="How sure Pulse is that it read the steps, owners and order right"><Sparkles size={11} aria-hidden="true" />{w} · {Math.round(value * 100)}%</span>;
}

export function SourceChip({ source }: { source: string }) {
  return source === "drive" ? <span className={css.chip}><HardDrive size={11} aria-hidden="true" />From Drive</span>
    : source === "paste" ? <span className={css.chip}><FileText size={11} aria-hidden="true" />From text</span> : source === "template" ? <span className={css.chip}>Template</span> : null;
}

/** A small picture of the flow for a library card: lanes and steps only. */
export function FlowThumb({ steps }: { steps: Pick<SopStep, "id" | "title" | "kind" | "role" | "personId" | "phase" | "next">[] }) {
  if (!steps.length) return null;
  const L = layoutFlow(steps);
  const sx = 1 / 4, w = Math.max(60, (L.width - SIZE.rail) * sx), h = Math.max(24, L.height * sx);
  const slot = new Map(L.lanes.map((l, i) => [l.key, l.key === "none" ? 0 : (i % 6) + 1]));
  return <svg className={css.thumb} viewBox={`${(SIZE.rail - 6) * sx} 0 ${w} ${h}`} preserveAspectRatio="xMinYMid meet" aria-hidden="true">
    {L.edges.map((e, i) => <path key={i} d={e.d} transform={`scale(${sx})`} data-kind={e.back ? "back" : e.handoff ? "handoff" : "plain"} />)}
    {L.nodes.map((n) => <rect key={n.id} x={n.x * sx} y={n.y * sx} width={n.w * sx} height={n.h * sx} rx={3} data-slot={slot.get(n.lane)} />)}
  </svg>;
}

export const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
