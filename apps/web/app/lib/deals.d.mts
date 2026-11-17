// KAZUK-V2 G12: types for deals.mjs (the negotiation numbers' words and sums).
export type DealSummary = { deals: number; won: number; lost: number; open: number; v1Won: number; finalWon: number; versions: number | null; revised: number; daysToYes: number | null; daysToPaid: number | null; paid: number };
export function money(paise: number | null | undefined): string;
export function discount(v1: number, final: number): number | null;
export function discountText(pct: number | null | undefined): string;
export function discountTone(pct: number | null | undefined): "neutral" | "accent";
export function daysText(n: number | null | undefined): string;
export const LOST_WORDS: Record<"price" | "competitor" | "no_response" | "timing" | "scope" | "other" | "not_said", string>;
export const WHY_WORDS: Record<"price" | "scope" | "timeline" | "other" | "not_said", string>;
export function cutText(c: { removed: number; lowered: number }): string;
export function headline(s: DealSummary): { pct: number | null; discount: string; discountNote: string; versions: string; versionsNote: string; yes: string; yesNote: string; paid: string; paidNote: string };
