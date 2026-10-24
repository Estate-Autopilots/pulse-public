import type { EditorCreativeType, EditorWeekResponse } from "../../lib/api";

const editorCreativeTypes: readonly { type: EditorCreativeType; label: string }[] = [
  { type: "model_video", label: "Model video" },
  { type: "vov", label: "VOV" },
  { type: "founder_video", label: "Founder video" },
  { type: "testimonial", label: "Testimonial" },
  { type: "walkthrough", label: "Walkthrough" },
  { type: "other", label: "Other" },
];

export type EditorTarget = {
  type: EditorCreativeType;
  label: string;
  perWeek: number | null;
  delivered: { drafts: number; finals: number };
  claimed: { drafts: number; finals: number };
  gap: number | null;
  placeholder: boolean;
};

/** Adapt the weekly API response for the existing shared desktop/mobile target views. */
export function editorTargetsFromWeek(response: EditorWeekResponse | null): EditorTarget[] {
  if (!response) return [];
  return editorCreativeTypes.map(({ type, label }) => ({
    type,
    label,
    perWeek: response.types[type].target,
    delivered: response.types[type].delivered,
    claimed: response.types[type].claimed ?? { drafts: 0, finals: 0 },
    gap: response.types[type].gap,
    placeholder: response.types[type].placeholder,
  }));
}

export function editorTargetTotal(targets: readonly EditorTarget[]) {
  const configured = targets.filter((target) => target.perWeek !== null);
  return {
    value: configured.reduce((sum, target) => sum + (target.perWeek ?? 0), 0),
    configured: configured.length,
    unconfigured: targets.length - configured.length,
  };
}

export function editorTargetSummary(targets: readonly EditorTarget[]) {
  if (!targets.length) return "Unavailable";
  const total = editorTargetTotal(targets);
  if (!total.configured) return "Not set / week";
  const value = total.value.toLocaleString("en-IN");
  return total.unconfigured ? `${value} configured · ${total.unconfigured} not set / week` : `${value} / week`;
}
