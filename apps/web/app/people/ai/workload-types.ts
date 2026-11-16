// AI-EMP-2 (1056) + FIX-AI-EMPLOYEES (2011): what GET /api/v0/agents/workload answers. Shared by Autopilots (the cards)
// and the day log.

export type Card = { id: string; kind: string; body: string; why: string | null; urgent: boolean; channel: string; channelId: string; client: boolean; approver: string; since: string;
  reminded: string | null; escalatedTo: string | null; messageId: string | null; chatId: string; canOpen?: boolean };
export type Question = { id: string; colleague: string; question: string; for: string | null; channel: string; client: boolean; since: string; state: string; reminded: string | null; escalated: string | null; chatId: string };
export type Caught = { at: string; kind: string; by: string | null; channel: string | null; wrote: string | null; sent: string | null };
export type Step = { at: string; kind: string; state: string; error: string | null; tokens: number | null; seconds: number | null; about: string | null; from: string | null; where: string | null; did: string[] };
/** Tokens, and rupees when the platform has a price for every engine used (null: no price known, so none is shown). */
export type Spend = { tokens: number; inr: number | null };
export type Budget = { day: { used: number; limit: number; share: number }; month: { used: number; limit: number | null; share: number | null }; level: "ok" | "warn" | "out"; share: number; canAdd?: boolean };
export type Cost = { today: Spend; month: Spend; budget: Budget | null; tools: string[]; lastRunAt: string | null; queued: number; running: boolean };
export type Agent = { id: string; name: string; title: string; employeeId: string; approver: string | null; manager: string | null; status: "on" | "paused" | "off";
  runtime: { state: string | null; until: string | null; provider: string | null };
  did: { runs: number; tokens: number; failed: number; answered: number; tasks: number; afterAnswers: number; quietClients: number; missedCalls: number; recordedCalls: number };
  posted: number;
  cards: { made: number; replies: number; tasks: number; sent: number; edited: number; turnedDown: number; expired: number; waiting: number; reminded: number; escalated: number; urgent: number };
  asked: { asked: number; answered: number; relayed: number; reminded: number; escalated: number };
  waitingCards: Card[]; waitingQuestions: Question[]; caught: Caught[]; timeline: Step[];
  /** FIX-AI-EMPLOYEES (2011); missing from an older API. */
  cost?: Cost | null };
export type Workload = { day: string; timeZone: string; agents: Agent[]; priced?: boolean };
