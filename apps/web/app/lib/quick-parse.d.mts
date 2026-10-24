export type QuickPerson = { id: string; name: string; username?: string | null };
export type QuickProject = { id: string; name: string };
export type QuickPart = { kind: "person" | "project" | "tag" | "priority" | "due"; text: string; label: string; id?: string; start: number; end: number };
export type QuickProblem = { kind: "person" | "project"; text: string; start: number; end: number };
export type Parsed<P extends QuickPerson = QuickPerson, J extends QuickProject = QuickProject> = {
  title: string; assignee: P | null; project: J | null; dueOn: string | null; priority: "low" | "normal" | "high" | "urgent"; tags: string[]; tokens: QuickPart[]; problems: QuickProblem[] };
export const PRIORITY: Record<string, "low" | "normal" | "high" | "urgent">;
export function addDays(day: string, n: number): string;
export function findPeople<P extends QuickPerson>(query: string, people: P[], me?: P | null): P[];
export function matchPerson<P extends QuickPerson>(token: string, people: P[], me?: P | null): { person: P | null; problem?: string; hits?: P[] };
export function matchProject<J extends QuickProject>(token: string, projects: J[]): { project: J | null; problem?: string; hits?: J[] };
export function parseLine<P extends QuickPerson, J extends QuickProject>(text: string, ctx: { today: string; people?: P[]; projects?: J[]; me?: P | null }): Parsed<P, J>;
export function activeToken(text: string, caret: number): { kind: "person" | "project" | "priority"; query: string; start: number; end: number } | null;
export function cut(text: string, start: number, end: number): string;
