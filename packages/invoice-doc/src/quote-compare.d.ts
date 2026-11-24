/** QUOTE-BUILDER: the seller-only comparison of a draft's prices with their base (never printed). Amounts in paise, before tax. */
export type CompareLine = { qty?: number | string; rate?: number; discount?: number | null; discountPercent?: number | null; catalogueRate?: number | null;
  charge?: 'fixed' | 'variable' | null; confirmed?: boolean; notNeeded?: boolean; role?: string | null; cost?: number | null };
export type PriceComparison = {
  /** Lines that have a base, by their index in the input. */
  lines: { index: number; base: number; yours: number; off: number; percentOff: number }[];
  base: number; yours: number; off: number; percentOff: number; changed: number; maxPercentOff: number;
  /** Item lines with no base (typed in, not from the catalogue). */
  unpriced: number;
  /** All item lines before tax; cost and margin only when every item line has a cost. */
  items: number; cost: number | null; margin: number | null; marginPercent: number | null;
  /** Extra charges before tax: fixed ones (in the total) and estimates (out of it). */
  charges: { fixed: number; estimate: number };
};
export function isEstimate(line: { charge?: unknown; confirmed?: unknown } | null | undefined): boolean;
export function priceComparison(lines?: CompareLine[]): PriceComparison;
