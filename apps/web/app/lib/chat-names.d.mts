export type SenderRow = { label: string; messages: number; groups: number };
export function exportGroup(name: string, path?: string): string;
export function looksLikePhone(label: string): boolean;
export function reconcileRows<R extends { id: string; decision: unknown; person: unknown; decidedBy: unknown }>(server: R[], local: R[], pending: ReadonlySet<string>): R[];
export function senderTotals(files: { group: string; participants: { label: string; phone: boolean; messages: number }[] }[]): { names: SenderRow[]; phoneSenders: number };
