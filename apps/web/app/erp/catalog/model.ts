// BILLING (18 Oct 2026): how the catalogue reads a package and its parts in plain words (server-safe). Money is paise.
import { formatInr } from "@pulse/invoice-doc/gst";
import type { CatalogItem, Part } from "../types";

export type Milestone = { label: string; percent: number; offsetDays: number };
export type CatalogOption = { id: string; name: string; kind: string; unit: string; price: number; sac: string | null };
/** What the catalogue list knows about one package beyond its row. */
export type PackageInfo = { parts: Part[]; milestones: Milestone[] };

export const rupees = (paise: number) => formatInr(paise, { decimals: false });
export const KIND_LABEL: Record<CatalogItem["kind"], string> = { service: "Service", product: "Product", consumable: "Consumable", package: "Package" };
export const STATUS_LABEL: Record<CatalogItem["status"], string> = { draft: "To approve", active: "Active", archived: "Archived" };
export const STATUS_TONE = { draft: "warning", active: "success", archived: "neutral" } as const;

const qtyWord = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
/** "2 × month", "2 ×", or nothing for one of a thing without a unit. */
export const qtyText = (p: Pick<Part, "quantity" | "unit">) => (p.unit ? `${qtyWord(p.quantity)} × ${p.unit}` : p.quantity !== 1 ? `${qtyWord(p.quantity)} ×` : "");
/** What a part delivers when nobody wrote otherwise: its own name, "2 × " in front when there are two. */
export const deliverableDefault = (p: Pick<Part, "label" | "quantity">) => (p.quantity > 1 ? `${qtyWord(p.quantity)} × ${p.label.trim()}` : p.label.trim());
/** True when the part's deliverables are just its name (so the form needn't show them). */
export const deliverablesAreDefault = (p: Pick<Part, "label" | "quantity" | "deliverables">) =>
  p.deliverables.length === 0 || (p.deliverables.length === 1 && [deliverableDefault(p), p.label.trim()].includes(p.deliverables[0].trim()));
/** "Creative Strategist, Graphic designer" from "Team: Creative Strategist, Graphic designer". */
export const teamText = (setup: string) => setup.replace(/^\s*team\s*:\s*/i, "").trim();
/** The catalogue item a part's name matches, so it needn't be chosen again. */
export const matchOption = (label: string, options: CatalogOption[]) => {
  const k = label.trim().toLowerCase();
  return k ? options.find((o) => o.name.trim().toLowerCase() === k) ?? null : null;
};
/** A part ready to save: name matching is opt-in for untouched new parts; saved free parts stay unlinked. */
export function finishPart(p: Part, options: CatalogOption[], customDeliverables: boolean, matchByName = false): Part {
  const itemId = p.itemId ?? (matchByName ? matchOption(p.label, options)?.id ?? null : null);
  const deliverables = customDeliverables && p.deliverables.length ? p.deliverables : (p.price === null && !p.itemId && p.derives ? [] : [deliverableDefault(p)]);
  return { ...p, label: p.label.trim(), itemId, deliverables };
}
export const marginPercent = (price: number, cost: number | null) => (cost === null || !price ? null : Math.round((1 - cost / price) * 100));
/** "at start", "after 30 days". */
export const whenText = (days: number) => (days <= 0 ? "at start" : `after ${days} day${days === 1 ? "" : "s"}`);
/** "Month 2 · 25% after 30 days". */
export const milestoneText = (m: Milestone) => `${m.label ? `${m.label} · ` : ""}${m.percent}% ${whenText(m.offsetDays)}`;
export const partTotals = (parts: Part[]) => ({ price: parts.reduce((n, p) => n + (p.price ?? 0), 0), cost: parts.reduce((n, p) => n + (p.cost ?? 0), 0) });
