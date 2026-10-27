export function maskSecrets(text: unknown): string;
export function scrubText(value: unknown, limit: number): string;
export function hiddenValue(value: unknown, password?: boolean): string;
export function shortcutAction(event: { key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } | null, inEditor: boolean): "open" | null;
export function shortcutLabel(mac: boolean): { open: string; editor: string };
export function shakeDetector(now?: () => number): (x: number, y: number, z: number) => boolean;
export const STATUS_WORDS: Record<string, string>;
export const TRIAGE_WORDS: Record<string, string>;
