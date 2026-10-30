export type DobParts = { year: string; month: string; day: string };
export function dobRange(today: string): { min: string; max: string };
export function dobParts(value: string | null | undefined, today: string): DobParts;
export function daysIn(year: string, month: string): number;
export function dobValue(parts: DobParts, today: string): { iso: string; day: string; problem: string };
