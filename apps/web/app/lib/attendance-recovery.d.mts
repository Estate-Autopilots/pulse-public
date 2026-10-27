import type { ActionId, QueueItem } from '@pulse/companion';
export const ATTENDANCE_KEY: string;
export const REQUEST_TIMEOUT_MS: number;
export type AttendanceReceipt = QueueItem & { state: 'queued' | 'accepted' | 'rejected' | 'needs-correction'; receiptId?: string };
export type AttendanceTrigger = 'manual' | 'suggested' | 'notification' | 'reminder' | 'widget';
/** A tap Pulse could not take (no confirmed clock): nothing was saved. */
export type UnsavedTap = { action: ActionId; mode?: string; trigger?: AttendanceTrigger; extra?: { leave?: 'cancel' }; signedOut: boolean };
export class AttendanceRecovery {
  constructor(options: { owner: string; storage: Pick<Storage, 'getItem' | 'setItem'>; request: (path: string, body?: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>; clock?: () => number; lock?: (fn: () => Promise<void>) => Promise<void>; changed?: () => void; timeoutMs?: number });
  records: AttendanceReceipt[]; note: string; busy: boolean; unsaved: UnsavedTap | null;
  act(action: ActionId, mode?: string, trigger?: AttendanceTrigger, extra?: { leave?: 'cancel' }): Promise<AttendanceReceipt['state'] | 'unsaved' | undefined>;
  again(): Promise<AttendanceReceipt['state'] | 'unsaved' | undefined>;
  retry(): Promise<void>; clearReviewed(): Promise<void>; dispose(): void;
}
