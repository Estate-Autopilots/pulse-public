export type Step = { text: string; shot?: string; note?: string; /** The label a walkthrough points at first (default: the first **label**). */ point?: string };
export type Tutorial = { id: string; title: string; who: string; minutes: number; tryHref: string; pages: string[]; tags: string[]; summary: string; steps: Step[];
  /** What an AI employee doing it for someone is doing, in a few words ("adding a task"): the operator view's strip says it. */
  doing?: string };
export type Playlist = { id: string; kind: "topic" | "role"; title: string; about: string; youtube?: string; items: string[] };
export const DONE_KEY: string;
export const TUTORIALS: Tutorial[];
export const PLAYLISTS: Playlist[];
export function tutorial(id: string): Tutorial | undefined;
export function playlistTutorials(id: string): Tutorial[];
export function tutorialsFor(pathname: string): Tutorial[];
export function stepParts(text: string): { text: string; ui: boolean }[];
export function parseDone(raw: string | null | undefined): Set<string>;
export function matchTutorial(question: string | null | undefined): Tutorial | null;
export function stepTargets(step: Step | null | undefined): string[];
export function stepPlain(step: Step | null | undefined): string;
