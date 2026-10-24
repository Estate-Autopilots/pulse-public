import type { ReactNode } from "react";
import type { Column, Task } from "./types";
import css from "./tasks.module.css";

/** The A1 states, in order. Tracker words ("Edit Pending", "In process") are mapped in the database; this is how they read. */
export const STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" | "accent"; column: Column | null }> = {
  open: { label: "To do", tone: "neutral", column: "todo" }, unknown: { label: "No status yet", tone: "neutral", column: "todo" },
  in_progress: { label: "Doing", tone: "accent", column: "doing" }, blocked: { label: "Blocked", tone: "danger", column: "blocked" },
  done: { label: "Done", tone: "success", column: "done" }, in_review: { label: "Done · in review", tone: "success", column: "done" },
  accepted: { label: "Accepted", tone: "success", column: "accepted" }, cancelled: { label: "Cancelled", tone: "neutral", column: null },
};
export const COLUMNS: { key: Column; label: string; status: string; hint: string; touch?: string }[] = [
  { key: "todo", label: "To do", status: "open", hint: "Nothing here. Press N to add a task, or take one from the pool.", touch: "Nothing here. Tap New task to add a task, or take one from the pool." },
  { key: "doing", label: "Doing", status: "in_progress", hint: "Drag a task here when you start it." },
  { key: "blocked", label: "Blocked", status: "blocked", hint: "Nothing is stuck." },
  { key: "done", label: "Done", status: "done", hint: "Finished work waits here for its reviewer." },
  { key: "accepted", label: "Accepted", status: "accepted", hint: "Reviewed work and its points land here." },
];
export const PRIORITY: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (day: string) => new Date(`${day}T00:00:00Z`);
export const shortDay = (day: string) => `${DAYS[at(day).getUTCDay()]} ${at(day).getUTCDate()} ${MONTHS[at(day).getUTCMonth()]}`;
export const dayMonthYear = (day: string) => `${at(day).getUTCDate()} ${MONTHS[at(day).getUTCMonth()]} ${at(day).getUTCFullYear()}`;
const diff = (a: string, b: string) => Math.round((at(a).getTime() - at(b).getTime()) / 86400000);
const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);

/** "Today", "Tomorrow", "Fri 16 Oct", or "3 days late" for open work; finished work shows when it was done. */
export function dueText(t: Pick<Task, "dueOn" | "status">, today: string): { text: string; late: boolean } | null {
  if (!t.dueOn) return null;
  const open = ["open", "in_progress", "blocked", "unknown"].includes(t.status);
  const d = diff(t.dueOn, today);
  if (open && d < 0) return { text: d === -1 ? "Due yesterday" : `${-d} days late`, late: true };
  if (d === 0) return { text: "Due today", late: false };
  if (d === 1) return { text: "Due tomorrow", late: false };
  return { text: `Due ${shortDay(t.dueOn)}${t.dueOn.slice(0, 4) !== today.slice(0, 4) ? ` ${t.dueOn.slice(0, 4)}` : ""}`, late: false };
}
export function doneText(t: Pick<Task, "doneAt" | "workOn">) {
  if (t.doneAt) return `Done ${shortDay(istDay(t.doneAt))}`;
  if (t.workOn) return `For ${shortDay(t.workOn)}`;
  return null;
}
/** Which My tasks group an open task belongs to. */
export function bucket(t: Task, today: string, weekEnd: string): "today" | "week" | "undated" | "later" | "blocked" | "done" {
  if (["done", "accepted", "in_review"].includes(t.status)) return "done";
  if (t.status === "blocked" || t.openBlockers > 0) return "blocked";
  if (t.status === "in_progress" || (t.dueOn && t.dueOn <= today)) return "today";
  if (!t.dueOn) return "undated";
  return t.dueOn <= weekEnd ? "week" : "later";
}
export function Chip({ children, tone, title }: { children: ReactNode; tone?: "late" | "accent" | "success" | "warning"; title?: string }) {
  return <span className={css.chip} data-tone={tone} title={title}>{children}</span>;
}
