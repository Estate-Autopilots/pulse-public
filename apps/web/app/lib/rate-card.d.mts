export type RateCardChoice = { cardId: string; part: string; x: number; talent: string; period: string };
export type RateCardPick = {
  id: string; itemId: string; name: string; base: number | null; xLabel: string; xMin: number; xMax: number;
  talents: { key: string; label: string; factor: number | null }[]; periods: { key: string; label: string; months: number; factor: number | null }[];
  /** QUOTE-STRUCT: for a seat that does not see cost the base and factors are null and each level × period's price for one
   *  X comes instead (millionths of a paisa, as text). */
  units?: Record<string, Record<string, string>>;
  addOns: { key: string; label: string; price: number; per: "month" | "once" }[];
  serviceName?: string; sac?: string | null; unit?: string; gstRate?: number; status?: string; version?: number; updatedAt?: string; serviceStatus?: string;
};
export type CardLine = { itemId: string; description: string; details: string; sac: string | null; unit: string; qty: number; rate: number; discount: number; discountPercent: null;
  gstRate: number; open: false; rateCard: RateCardChoice; catalogueRate: number };
export function cardPrice(card: Pick<RateCardPick, "base" | "xMin" | "xMax" | "talents" | "periods" | "addOns">, sel: { x: number; talent: string; period: string; part?: string }): number | null;
export function periodUnit(months: number): string;
export function cardLines(card: RateCardPick, sel: { x: number; talent: string; period: string; addOns?: string[] }): { main: CardLine; addOns: CardLine[] } | null;
