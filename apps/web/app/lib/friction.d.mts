export function rageDetector(options?: { clicks?: number; windowMs?: number; radius?: number }): (x: number, y: number, t: number) => number;
export function backLoopDetector(options?: { count?: number; windowMs?: number }): (t: number) => boolean;
export type PromptStore = { get(key: string): string | null; set(key: string, value: string): void };
export function promptGate(store: PromptStore, options?: { gapMs?: number; perDay?: number; afterDismissMs?: number }): { may(now: number): boolean; shown(now: number): void; dismissed(now: number): void };
export function stableSelector(el: Element): string | null;
export function componentOf(el: Element): string | null;
export type PickedElement = { sel: string | null; component: string | null; label: string | null; tag: string; role?: string; box: { x: number; y: number; w: number; h: number }; vw: number; vh: number; sy: number };
export function describeElement(el: Element, win?: Window): PickedElement;
export function privateScreen(href: string): boolean;
export function replayText(text: string, options?: { inPrivate?: boolean; screenPrivate?: boolean }): string;
export type FrictionTrigger = "rage" | "dead" | "error" | "back" | "stuck";
export function installFrictionWatch(options?: {
  emit?: (kind: string, fields: Record<string, unknown>) => void;
  signal?: (trigger: FrictionTrigger, info: { name?: string | null }) => void;
  notices?: { current?: () => readonly { id: string; tone: string; title: string }[]; subscribe: (fn: () => void) => () => void };
}): () => void;
