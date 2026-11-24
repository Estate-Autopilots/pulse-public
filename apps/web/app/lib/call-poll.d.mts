export const POLL_SETUP_MS: number;
export function pollWait(s: { setup: boolean; down: boolean; hidden: boolean; offline: boolean; fails: number }): number | null;
