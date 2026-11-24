"use client";
import { Sparkles } from "lucide-react";
import { Tooltip } from "./popover";
import css from "./kit.module.css";

/** The shared marker for an AI employee. Only pass an ID supplied by the server. 12 px text and the 14 px icon (the
 *  design system's floor and its icon step for 12-13 px text; VITALS-DESIGN slice 4); the avatar's corner mark is the same icon. */
export function AiBadge({ employeeId, size = "sm" }: { employeeId?: string | null; size?: "sm" | "md" }) {
  const label = employeeId ? `AI employee · ${employeeId}` : "AI employee";
  return <Tooltip content={label}><span className={css.aiBadge} data-size={size} role="img" aria-label={label}>
    <Sparkles size={14} aria-hidden="true" />AI
  </span></Tooltip>;
}
