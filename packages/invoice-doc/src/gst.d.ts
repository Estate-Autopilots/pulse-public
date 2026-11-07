// Types for @pulse/invoice-doc/gst (plain ESM: the browser preview, the API and the tests run the same code).

export type StateInfo = { name: string; ut?: boolean };
export const STATES: Readonly<Record<string, StateInfo>>;
export const GST_RATES: readonly number[];
export const EXPORT_STATE: '96';
export function stateName(code: string): string | null;
export function stateLabel(code: string): string;
export function gstinCheckChar(first14: string): string;
export function validGstin(value: unknown): boolean;
export function stateFromGstin(gstin: unknown): string | null;
export function panFromGstin(gstin: unknown): string | null;
export function divRound(a: number | bigint, b: number | bigint): number;
export function perMillion(percent: number | string): number;
export function milli(qty: number | string): number;

export type LineInput = {
  description?: string; details?: string; sac?: string | null; unit?: string | null; itemId?: string | null;
  /** Up to three decimals. */
  qty?: number | string;
  /** Rate in paise. */
  rate: number;
  /** Percent off before tax, or a fixed discount in paise. */
  discountPercent?: number | string | null; discount?: number | null;
  /** GST rate in percent (18, 5, 0.25). */
  gstRate?: number | string;
};
export type ComputedLine = LineInput & { qtyMilli: number; amount: number; discount: number; taxable: number; gstRate: number; cgst: number; sgst: number; igst: number; tax: number; total: number };
export type TaxGroup = { sac: string; gstRate: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number };
export type Computed = {
  mode: 'intra' | 'inter'; placeOfSupply: string; split: 'SGST' | 'UTGST'; reverseCharge: boolean; zeroRated: boolean;
  lines: ComputedLine[]; amount: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number;
  exact: number; roundOff: number; total: number; words: string; byRate: TaxGroup[]; bySac: TaxGroup[];
};
export function taxMode(sellerState: string, placeOfSupply?: string | null): 'intra' | 'inter';
export function computeDocument(input: { lines?: LineInput[]; sellerState: string; placeOfSupply?: string | null; roundTotal?: boolean; reverseCharge?: boolean; zeroRated?: boolean }): Computed;
export function rupeesInWords(rupees: number): string;
export function amountInWords(paise: number): string;
export function formatAmount(paise: number, options?: { decimals?: boolean }): string;
export function formatInr(paise: number, options?: { decimals?: boolean }): string;
export function toPaise(text: unknown): number | null;
export type FinancialYear = { label: string; short: string; start: string; end: string };
export function financialYear(day: string): FinancialYear;
export function formatDocNumber(pattern: string, fy: FinancialYear, n: number): string;
export function numberProblem(pattern: string, fy: FinancialYear): string | null;
export function addDays(day: string, days: number): string;
export function formatDate(day: string | null | undefined): string;
