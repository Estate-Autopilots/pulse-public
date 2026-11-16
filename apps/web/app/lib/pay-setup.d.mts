type Row = { id: string; name: string; current: boolean; hasRecord: boolean; action: { key: string; label: string } | null;
  change?: { id: string; kind: string; status: string; effectiveOn: string; proposedBy?: string } };
export function setupStartDay(today: string, joinedOn: string | null | undefined): string;
export function setupWalk<T extends Row>(people: T[] | null | undefined, me: string | null | undefined): T[];
export function waitingSetups<T extends Row>(people: T[] | null | undefined): T[];
type PayFigures = { monthly?: number | null; rate?: number | null; hours?: number | null } | null;
export function offerStart(inForce: { payType?: string; figures?: PayFigures } | null | undefined, offer: { payType?: string; figures?: PayFigures } | null | undefined):
  { payType: string; monthly: string; rate: string; hours: string; fromPay: boolean };
