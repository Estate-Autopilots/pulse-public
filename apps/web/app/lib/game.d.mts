export { rupees } from "./goals.mjs";
export function levelSpan(level: number): number;
export function levelOf(xp: number): { level: number; into: number; span: number; toNext: number; pct: number };
export function streakOf(days: readonly string[], today: string, opts?: { weekends?: boolean }): { days: number; today: boolean };
export type Trend = { pct: number | null; dir: "up" | "down" | "flat"; good: boolean | null };
export function trendOf(now: number, before: number, better?: "up" | "down"): Trend;
export function trendText(t: { pct: number | null; dir: string }): string;
export function dayDone(done: number, total: number): { pct: number; words: string; all: boolean };
