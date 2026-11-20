export const REOPEN_MAX_MS: number;
export function reopenWait(previous: number): number;
export interface KeptStream { readonly current: EventSource | null; wake(): void; close(): void }
export function keepStream(url: string, setup: (es: EventSource) => void,
  env?: { EventSource: typeof EventSource; setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }): KeptStream;
