// FIX-PEOPLE-MONEY C5: types for work-cost.mjs (People → Work and cost).
export declare const HOURS_A_MONTH: number;
export type Rate = { month: string; total: number; people: number; monthly: number; hourly: number } | null;
export type PersonRow = { id: string; name: string; role: string | null; pod: string | null; photoAt: string | null; tasks: number; perTask: number | null };
export type People = { rows: PersonRow[]; tasks: number; cost: number | null; busy: number; perTask: number | null; idle: number };
export type AiRow = { id: string; name: string; role: string | null; tasks: number; given: number; returned: number; tokens: number; perTask: number | null; inr: number | null; inrPerTask: number | null };
export type Ai = { rows: AiRow[]; tasks: number; tokens: number; perTask: number | null; inr: number | null };
export declare function payRate(payroll: { month: string; total: number; people: number | null }[] | null | undefined): Rate;
export declare function peopleCost(people: { id: string; name: string; role?: string | null; pod?: string | null; photoAt?: string | null; values?: number[] }[] | null | undefined, rate: Rate, weeks: number): People;
export declare function aiCost(agents: { id: string; name: string; title?: string | null; accepted?: number; given?: number; returned?: number; tokens?: number }[] | null | undefined, inrPerToken?: number | null): Ai;
export declare function tokensText(n: number | null | undefined): string;
export type ProjectRow = { id: string; name: string; people: number; ai: number; cost: number | null; tokens: number };
export declare function projectCost(tasks: { projectId: string | null; project: string | null; who: string; ai: boolean; tokens: number }[] | null | undefined, rate: Rate, days: number, scope?: { people: Map<string, number | null>; ai: Set<string> } | null): ProjectRow[];
