// Types for qty-dims.js (QUOTE-BUILDER-4): a quantity in two or three numbers (6 users × 6 months) and term tiers.
import type { QtyDim } from './gst.js';
export type TermTier = { months: number; percent: number };
export function singular(word: unknown): string;
export function counted(n: number, unit: string): string;
export function dimsOfUnit(unit: unknown): string[] | null;
export function cleanQtyDims(raw: unknown): QtyDim[] | null;
export function dimsQty(dims: QtyDim[] | null | undefined): number;
export function dimsMatch(dims: unknown, qty: number | string): dims is QtyDim[];
export function dimsText(dims: QtyDim[] | null | undefined): string;
export function monthsOf(dims: QtyDim[] | null | undefined): number | null;
export function splitQty(qty: number, unit: string | null | undefined, months: number | null | undefined): QtyDim[] | null;
export function cleanTiers(raw: unknown): TermTier[];
export function termPercent(tiers: unknown, months: number | null | undefined): number;
export function offRate(rate: number, percent: number | null | undefined): number;
