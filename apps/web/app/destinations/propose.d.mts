// Types for propose.mjs (UX-5B: a task's target and Pip's proposed completion signals).
import type { Destination } from "./registry.mjs";

export type TaskText = { title: string; notes?: string | null; /** A destination the creator picked. */ target?: string | null };
export type Who = { role?: string | null; modulesOff?: readonly string[] | null };
export type Target = { dest: Destination; /** "Go to Office presence" */ button: string; source: "creator" | "notes" | "title"; /** The phrase that named it. */ via: string };
export type Where = Record<string, { gte?: number; eq?: string | number | boolean }>;
export type ProposedSignal = { event: string; label: string; need: number; distinct?: "subject"; where?: Where; dest: string };

export declare function pageOf(d: Destination): Destination;
export declare function buttonFor(d: Destination): string;
export declare function targetFor(task: TaskText, who: Who): Target | null;
export declare function peopleCount(text: string): number | null;
export declare function proposeFor(task: TaskText): ProposedSignal[];
export declare function shellRole(role: string | null | undefined): string;
