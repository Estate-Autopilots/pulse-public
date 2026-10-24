import type { PulseShell } from './native-shell';
export function enrollShell(person: string, native: PulseShell, request: typeof fetch, current?: () => boolean): Promise<void>;
