// Types for quote-phases.js (QUOTE-STRUCT: a package opened phase by phase on a quotation; shared by the composer and the API since QUOTE-BUILDER-4).
import type { QtyDim } from "./gst.js";
import type { TermTier } from "./qty-dims.js";
export type Phase = { key: string; name: string; groups: string[] };
export type LineRole = "included" | "to_quote" | "bonus";
export type PhaseFields = { phase?: string | null; phaseOrder?: number | null; phaseGroup?: string | null; role?: LineRole | null; packageId?: string | null; packageLabel?: string | null;
  packageDefault?: { qty: number; rate: number | null; itemId: string | null; qtyDims?: QtyDim[]; discountPercent?: number } | null; listRate?: number | null;
  /** QUOTE-BUILDER-4: the quantity in numbers (5 users × 4 months). */
  qtyDims?: QtyDim[] | null };
/** A package's part as the document API answers it (price per unit; the item's details when linked). */
export type PackagePart = { position: number; itemId: string | null; label: string; quantity: number; unit: string | null; price: number | null; itemPrice: number | null; itemName: string | null;
  itemDescription?: string | null; sac: string | null; itemUnit: string | null; gstRate: number | null; phase: string | null; phaseGroup: string | null; included: boolean | null };
type PhasedItem = { id: string; kind: string; name: string; price: number; sac?: string | null; unit?: string | null; gstRate?: number; status?: string; phase?: string | null; phaseGroup?: string | null; included?: boolean };
type PartLine = { itemId: string | null; description: string; details: string; sac: string | null; unit: string | null; qty: number; rate: number; discount: number; discountPercent: number | null;
  gstRate: number; open: false; notNeeded: false } & Required<Omit<PhaseFields, "qtyDims">> & { qtyDims?: QtyDim[] };
export function phaseOf(phases: Phase[] | null | undefined, item: { phase?: string | null; phaseGroup?: string | null } | null | undefined): { phase: string | null; phaseOrder: number | null; phaseGroup: string | null };
export function packageLabel(pkg: { name?: string; description?: string | null }): string;
export function opensIntoParts(parts: PackagePart[] | null | undefined): boolean;
export function packageMonths(pkg: { name?: string; description?: string | null }, parts: PackagePart[] | null | undefined): number | null;
export function termFields(qtyDims: QtyDim[], listRate: number, tiers: TermTier[] | null | undefined): { rate: number; discount: number; discountPercent: number | null };
export function startDims(unit: string | null | undefined, months?: number | null): QtyDim[] | null;
export function withDims<L extends { qtyDims?: QtyDim[] | null; discountPercent?: number | null }>(line: L, dims: QtyDim[], tiers: TermTier[] | null | undefined): { qtyDims: QtyDim[]; qty: number; discountPercent?: number | null; discount?: number };
export function offered(item: { status?: string } | null | undefined): boolean;
export function autoPercent(line: { qtyDims?: QtyDim[] | null } | null | undefined, tiers: TermTier[] | null | undefined): number;
export function packageLines(pkg: { id: string; name: string; description?: string | null; sac?: string | null; gstRate?: number; phase?: string | null; phaseGroup?: string | null; price?: number | null },
  parts: PackagePart[], phases: Phase[] | null | undefined, termTiersOf?: (itemId: string | null) => TermTier[] | null | undefined): PartLine[];
export function changes(line: PhaseFields & { itemId?: string | null; qty: number; rate: number; notNeeded?: boolean; discountPercent?: number | null; catalogueRate?: number | null }, tiers?: TermTier[] | null): string[];
export function packageTotal(lines: (PhaseFields & { qty: number; rate: number; notNeeded?: boolean; discountPercent?: number | null })[], packageId: string): number;
export function groupLines<T extends PhaseFields>(lines: T[]): { key: string; name: string | null; lines: T[]; subGroups: string[] }[];
export function swapOptions<I extends PhasedItem>(line: { itemId?: string | null }, items: I[]): I[];
export function swapTo<L extends PhaseFields & { itemId: string | null; description: string; sac: string | null; unit: string | null; gstRate: number; rate: number }>(line: L, item: PhasedItem): L;
