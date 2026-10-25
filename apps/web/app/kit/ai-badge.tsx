"use client";
import { Sparkles } from "lucide-react";
import { Tooltip } from "./popover";
import css from "./kit.module.css";

/** The shared marker for an AI employee. Only pass an ID supplied by the server. */
export function AiBadge({ employeeId, size = "sm" }: { employeeId?: string | null; size?: "sm" | "md" }) {
  const label = employeeId ? `AI employee · ${employeeId}` : "AI employee";
  return <Tooltip content={label}><span className={css.aiBadge} data-size={size} role="img" aria-label={label}>
    <Sparkles size={size === "sm" ? 10 : 12} aria-hidden="true" />AI
  </span></Tooltip>;
}
