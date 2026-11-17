export type CallParty = { id: string; name: string; photoAt?: string | null; state: string; joinedAt?: string | null };
export type RecentCall = { id: string; channelId: string; channelKind: string; channelName: string | null; video: boolean; state: string; endReason: string | null;
  startedBy: string; createdAt: string; answeredAt: string | null; endedAt: string | null; parties: CallParty[] | null };
export type CallEntry = { id: string; channelId: string; video: boolean; at: string; live: boolean; title: string; peer: CallParty | null; caller: CallParty | null;
  direction: "outgoing" | "incoming"; missed: boolean; declined: boolean; answered: boolean; seconds: number | null };
export function callEntry(call: RecentCall, me: string): CallEntry;
export function missedCalls(recent: RecentCall[] | null | undefined, me: string, now?: number, opts?: { days?: number; max?: number }): (CallEntry & { count: number })[];
export function byDay(entries: CallEntry[], now?: number, timeZone?: string): { label: string; entries: CallEntry[] }[];
export function duration(s: number | null | undefined): string | null;
