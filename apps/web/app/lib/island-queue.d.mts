export const PER_MINUTE: number;
export const BURST: number;
export type QueueItem = { id: string; title: string; tone?: string; priority?: "action" };
export function hasPriority(item: QueueItem | null | undefined): boolean;
export function priorityIndex(queue: QueueItem[], incoming?: QueueItem): number;
export function shouldPreempt(current: QueueItem | null | undefined, incoming: QueueItem): boolean;
export function nextArrival<T extends QueueItem>(queue: T[], shown: number[], now: number, summary: (rest: T[]) => T): { item: T | null; queue: T[]; shown: number[] };
