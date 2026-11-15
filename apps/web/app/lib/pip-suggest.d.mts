// Types for pip-suggest.mjs (TASK-MERGE Pip: suggestions from structure only, dismissals remembered per person).
export type Basis = "task" | "link" | "file" | "picked" | "written-place" | "task-type" | "project-type";
export type Suggestion = { kind: string; subject: string; basis: Basis | string; confidence: number; autoOk?: boolean; href?: string; label?: string; reason?: string };
export type KindStat = { accepted?: number; dismissed?: number };
export type PickOptions = { dismissed?: Set<string>; kinds?: Record<string, KindStat>; autoOpen?: boolean; max?: number };
export const STRUCTURE: Set<string>;
export const SUGGEST_MIN: number;
export const AUTO_MIN: number;
export function suggestionKey(kind: string, subject: string): string;
export function relevance(stat: KindStat | null | undefined): number;
export function qualifies(s: Suggestion | null | undefined, opts?: PickOptions): { ok: boolean; score: number; why: string };
export function pickSuggestions<T extends Suggestion>(list: readonly T[] | null | undefined, opts?: PickOptions): { auto: (T & { score: number }) | null; chips: (T & { score: number })[] };
export function chatSuggestions(m: { body?: string | null; attachments?: readonly { id?: string; name?: string; url?: string; mime?: string; task?: string }[] } | null | undefined,
  ctx?: { origin?: string; directed?: boolean; direct?: boolean }): (Suggestion & { href: string; label: string; reason: string; autoOk: boolean })[];
export function doneWhenSuggestion(taskId: string, target: { source: string } | null | undefined, signals: readonly unknown[] | null | undefined): Suggestion | null;
