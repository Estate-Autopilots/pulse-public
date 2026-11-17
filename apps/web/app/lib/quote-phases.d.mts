// Types for quote-phases.mjs (QUOTE-STRUCT: a package opened phase by phase on a quotation).
export type Phase = { key: string; name: string; groups: string[] };
export type LineRole = "included" | "to_quote" | "bonus";
export type PhaseFields = { phase?: string | null; phaseOrder?: number | null; phaseGroup?: string | null; role?: LineRole | null; packageId?: string | null; packageLabel?: string | null;
  packageDefault?: { qty: number; rate: number | null; itemId: string | null } | null; listRate?: number | null };
/** A package's part as the document API answers it (price per unit; the item's details when linked). */
export type PackagePart = { position: number; itemId: string | null; label: string; quantity: number; unit: string | null; price: number | null; itemPrice: number | null; itemName: string | null;
  itemDescription?: string | null; sac: string | null; itemUnit: string | null; gstRate: number | null; phase: string | null; phaseGroup: string | null; included: boolean | null };
type PhasedItem = { id: string; kind: string; name: string; price: number; sac?: string | null; unit?: string | null; gstRate?: number; status?: string; phase?: string | null; phaseGroup?: string | null; included?: boolean };
type PartLine = { itemId: string | null; description: string; details: string; sac: string | null; unit: string | null; qty: number; rate: number; discount: number; discountPercent: null;
  gstRate: number; open: false; notNeeded: false } & Required<PhaseFields>;
export function phaseOf(phases: Phase[] | null | undefined, item: { phase?: string | null; phaseGroup?: string | null } | null | undefined): { phase: string | null; phaseOrder: number | null; phaseGroup: string | null };
export function packageLabel(pkg: { name?: string; description?: string | null }): string;
export function opensIntoParts(parts: PackagePart[] | null | undefined): boolean;
export function packageLines(pkg: { id: string; name: string; description?: string | null; sac?: string | null; gstRate?: number; phase?: string | null; phaseGroup?: string | null },
  parts: PackagePart[], phases: Phase[] | null | undefined): PartLine[];
export function changes(line: PhaseFields & { itemId?: string | null; qty: number; rate: number; notNeeded?: boolean }): string[];
export function packageTotal(lines: (PhaseFields & { qty: number; rate: number; notNeeded?: boolean })[], packageId: string): number;
export function groupLines<T extends PhaseFields>(lines: T[]): { key: string; name: string | null; lines: T[]; subGroups: string[] }[];
export function swapOptions<I extends PhasedItem>(line: { itemId?: string | null }, items: I[]): I[];
export function swapTo<L extends PhaseFields & { itemId: string | null; description: string; sac: string | null; unit: string | null; gstRate: number; rate: number }>(line: L, item: PhasedItem): L;
