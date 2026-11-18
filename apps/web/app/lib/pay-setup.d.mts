type Row = { id: string; name: string; current: boolean; hasRecord: boolean; action: { key: string; label: string } | null;
  change?: { id: string; kind: string; status: string; effectiveOn: string; proposedBy?: string } };
export function setupStartDay(today: string, joinedOn: string | null | undefined): string;
export function setupWalk<T extends Row>(people: T[] | null | undefined, me: string | null | undefined): T[];
export function waitingSetups<T extends Row>(people: T[] | null | undefined): T[];
type PayFigures = { monthly?: number | null; rate?: number | null; hours?: number | null } | null;
export function offerStart(inForce: { payType?: string; figures?: PayFigures } | null | undefined, offer: { payType?: string; figures?: PayFigures } | null | undefined):
  { payType: string; monthly: string; rate: string; hours: string; fromPay: boolean };
export function inBatches<T>(items: T[], run: (item: T) => Promise<unknown>, opts?: { size?: number; onDone?: (done: number) => void }):
  Promise<{ done: number; failed: { item: T; index: number; error: unknown } | null }>;
export function ownPayLine(others: number): string;
export function readAll<K, V>(keys: K[], read: (key: K) => Promise<V | null | undefined>, opts?: { size?: number; tries?: number; live?: () => boolean }): Promise<Map<K, V>>;
export function setupTotalLabel(shown: number, all: number): string;
