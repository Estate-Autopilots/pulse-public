// Types for chat-intent.mjs (CHAT-SHELL: which Pulse place a message or a task is about).
export type Coach = { selector?: string; button?: string; text: string };
export type Intent = { id: string; label: string; href: string; confidence: number; reason: string; source: "rule" | "project" | "person" | "place" | "model"; coach?: Coach };
export type IntentContext = { viewer?: string | null; projects?: readonly { id: string; name: string }[]; people?: readonly { id: string; name: string }[];
  role?: string; modulesOff?: readonly string[]; directed?: boolean };
export const AUTO_OPEN: number;
export const SUGGEST: number;
export function detectIntent(text: string | null | undefined, ctx?: IntentContext): Intent[];
export function decide(intents: readonly Intent[] | null | undefined): { auto: Intent | null; chips: Intent[] };
export function openablePlaces(role?: string, modulesOff?: readonly string[]): { id: string; label: string; href: string; words: string }[];
