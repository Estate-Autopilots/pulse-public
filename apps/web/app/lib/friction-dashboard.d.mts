export type RrEvent = { type: number; timestamp: number; data?: unknown; delay?: number };
export function duration(ms: number | null | undefined): string;
export function share(part: number, whole: number): number;
export function mergeEvents(chunks: unknown[][]): RrEvent[];
export function lastFrame(events: RrEvent[]): { events: RrEvent[]; offset: number } | null;
export function seekOffset(t: unknown, first: number, last: number): number;
export const HEAT: Record<"rage" | "dead" | "click", { colour: string; label: string }>;
export function fit(w: number, h: number, boxW: number, boxH?: number): number;
