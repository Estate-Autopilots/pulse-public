import type { ActionId } from '@pulse/companion';
import type { CompanionDay } from './companion-day';
export type CheckinView = { show: false } | {
  show: true; state: 'out' | 'in' | 'break' | 'done' | 'pending' | 'stale'; tone: 'action' | 'attention' | 'success' | 'warning' | 'neutral';
  label: string; short: string; title: string; worked: number; onBreak: number;
  arrival: { office: string | null; at: string } | null;
  actions: { id: ActionId; label: string; primary?: boolean }[];
  /** POLISH-1: a forgotten check-out (state "stale"); POLISH-2: or one Pulse closed for review (`closed`, any state). */
  fix?: Forgotten;
  /** ATT: Pulse's one question about the session (the signals conflict), answered in one tap. */
  question?: Question;
};
export type Question = { entryId: string; kind: 'left' | 'left_early'; leftAt: string; office: string | null; label: string; short: string; title: string };
export type Forgotten = { since: string; date: string; entryId: string | null; in: string; suggested: string; pending: boolean; closed?: boolean; day?: string };
export const FORGOTTEN_AFTER_HOURS: number;
export const AFTER_SHIFT_HOURS: number;
export function closedFix(payload: CompanionDay, unresolved: NonNullable<CompanionDay['unresolved']>): Forgotten;
export function forgotten(payload: CompanionDay, entry: NonNullable<CompanionDay['entry']>, at: number): Forgotten | null;
export const ACTION_LABEL: Record<ActionId, string>;
export function hm(seconds: number): string;
export function words(seconds: number): string;
export function clock(iso: string, payload?: { utcOffsetMinutes?: number } | null): string;
export function checkinView(payload: CompanionDay | null, at: number, records?: { state: string }[], env?: { online?: boolean; tapped?: boolean }): CheckinView;
