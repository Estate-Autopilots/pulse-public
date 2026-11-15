// KAZUK-V2 G13: types for sales-home.mjs (the one salesperson home's words and lists).
export function firstName(name: string): string;
export function greeting(today?: string): string;
export const INCENTIVE: Record<"not_due" | "pending" | "released", { label: string; tone: "neutral" | "warning" | "success" }>;
export const NEETI_ROWS: [key: "leads" | "attempts" | "firstCallMinutes" | "settingCalls" | "strategySessions" | "proposals" | "closes", label: string][];
export function neetiValue(n: { connected: boolean } & Record<string, unknown>, key: string): string | null;
export function syncText(n: { connected: boolean; lastSync: string | null; lastError?: string | null }, zone?: string): string;
export type TodayItem = { key: string; kind: "follow" | "invoice" | "no_reply" | "renewal" | string; href: string; title: string; sub: string; late: boolean; amount?: number; draft?: string; phone?: string | null; rank: number };
export function todayItems(x: {
  pipeline: { followUps?: { items: { id: string; title: string; dueOn: string | null; overdue: boolean }[] } } | null;
  invoices: { id: string; number: string; buyer: string | null; dueDate: string | null; baseDue: number; gstDue: number }[];
  today: string;
  nudges?: { kind: string; key: string; title: string; sub: string; href: string; draft: string; phone?: string | null; amount?: number }[] | null;
}): TodayItem[];
