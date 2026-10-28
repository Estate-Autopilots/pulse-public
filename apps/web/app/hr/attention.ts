import { lower } from "../lib/words.mjs";
// HR desk → Policies → "Needs your attention": the setup still open, built on the server from counts (hr/policy-attention),
// the working rules and the policy drafts. Each task names the exact page where it is settled.

export type AttentionCounts = { rulesUnconfirmed: boolean; holidays: number; openingBalances: number; historyUnlinked: number; podsWithoutHead: number; offices: number };
export type AttentionDraft = { kind: string; label: string; version: number; confirm: number };
export type AttentionTask = { key: "draft" | "rules" | "holidays" | "balances" | "pods" | "office" | "history"; id: string; title: string; detail: string; href: string; count?: number };

const n = (count: number, one: string, many: string) => `${count.toLocaleString("en-IN")} ${count === 1 ? one : many}`;

export function attentionTasks(counts: AttentionCounts | null, drafts: AttentionDraft[], rulesUnconfirmed: boolean): AttentionTask[] {
  const tasks: AttentionTask[] = drafts.map((d) => ({ key: "draft", id: `draft-${d.kind}`, title: `Publish the ${d.label.toLowerCase()} policy`, detail: `Draft, version ${d.version}${d.confirm ? ` · ${n(d.confirm, "item", "items")} marked (confirm)` : ""}`, href: `/hr?tab=policies&view=documents&doc=${d.kind}`, count: d.confirm || undefined }));
  if (rulesUnconfirmed) tasks.push({ key: "rules", id: "rules", title: "Confirm the working rules", detail: "Shift, working days and grace are still Pulse's starting values", href: "/hr?tab=policies&view=rules" });
  if (!counts) return tasks;
  if (counts.holidays) tasks.push({ key: "holidays", id: "holidays", title: "Confirm proposed holidays", detail: "Found in company documents; each becomes a day off once confirmed", href: "/review-data?kind=holiday", count: counts.holidays });
  if (counts.openingBalances) tasks.push({ key: "balances", id: "balances", title: "Confirm opening leave balances", detail: "Balances carried in from before Pulse", href: "/review-data?kind=opening_balance", count: counts.openingBalances });
  if (counts.podsWithoutHead) tasks.push({ key: "pods", id: "pods", title: `Name pod heads`, detail: `Until then these pods' requests go straight to HR`, href: "/hr?tab=pods", count: counts.podsWithoutHead });
  if (!counts.offices) tasks.push({ key: "office", id: "office", title: "Add the office location", detail: "Phones can only check in automatically at a known office", href: "/hr?tab=policies&view=presence" });
  if (counts.historyUnlinked) tasks.push({ key: "history", id: "history", title: "Match imported monthly history", detail: "Monthly reports whose name did not match a person", href: "/hr-history", count: counts.historyUnlinked });
  return tasks;
}
