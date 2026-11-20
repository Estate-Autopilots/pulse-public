import type { PulseShell } from './native-shell';
export function enrollShell(person: string, native: PulseShell, request: typeof fetch, current?: () => boolean, options?: { force?: boolean; now?: () => number }): Promise<void>;
export const ENROLL_PAUSE_MS: number;
export function enrollPaused(now?: number, at?: number): boolean;
export function refusal(status: unknown): boolean;
export const REFUSED_WORDS: string;
