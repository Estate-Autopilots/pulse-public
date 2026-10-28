export type IntentMember = { id: string; username: string | null; name: string };
export type IntentProject = { id: string; name: string };
export type TaskIntent<M extends IntentMember = IntentMember, P extends IntentProject = IntentProject> = { assignee: M; title: string; dueOn: string | null; project: P | null };
export const DUE_PHRASE: RegExp;
export function dueDay(phrase: string, today: string): string | null;
export function taskIntent<M extends IntentMember, P extends IntentProject>(text: string, o: { members: M[]; viewer: string; projects?: P[]; today: string }): TaskIntent<M, P> | null;
