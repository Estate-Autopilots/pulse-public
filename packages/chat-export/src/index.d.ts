// Types for @pulse/chat-export (plain ESM: the browser preview, the API and the tests run the same code).

export const PARSER: 'whatsapp-text/1';
export const LIMITS: Readonly<{ bytes: number; messages: number; body: number; sender: number }>;

export type ExportErrorCode = 'not_text' | 'empty' | 'too_large' | 'not_utf8' | 'not_whatsapp' | 'too_many' | 'zone' | 'date_order';
export class ExportError extends Error {
  code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string);
}

export type DateOrder = 'dmy' | 'mdy' | 'ymd';
export type MessageKind = 'text' | 'media' | 'deleted' | 'system';
export type ExportMessage = {
  /** Line of the export where the message starts (1-based). */
  line: number;
  /** The phone's wall-clock time as written, YYYY-MM-DDTHH:MM:SS. */
  local: string;
  /** The same moment in UTC (ISO). */
  at: string;
  /** exact, or around a clock change: ambiguous (happened twice) or missing (skipped by the clock). */
  time: 'exact' | 'ambiguous' | 'missing';
  /** The sender as the export names them; null for a notice with no sender. */
  sender: string | null;
  kind: MessageKind;
  body: string;
  edited: boolean;
};
export type ExportParticipant = {
  label: string;
  /** What Pulse shows and stores: a phone number becomes "Number ending 210". */
  display: string;
  phone: boolean;
  messages: number;
  text: number;
  media: number;
  deleted: number;
  first: string;
  last: string;
};
export type ExportWarning =
  | { code: 'date_order_guess'; order: DateOrder }
  | { code: 'leading_lines' | 'out_of_order' | 'long_message' | 'phone_senders'; count: number }
  | { code: 'bad_stamp' | 'time_ambiguous' | 'time_missing'; count: number; line: number };
export type ExportStats = {
  lines: number; messages: number; text: number; media: number; deleted: number; system: number;
  multiline: number; edited: number; outOfOrder: number; first: string | null; last: string | null;
};
export type ParsedExport = {
  parser: typeof PARSER;
  timeZone: string;
  dateOrder: DateOrder;
  dateOrderCertain: boolean;
  messages: ExportMessage[];
  participants: ExportParticipant[];
  stats: ExportStats;
  warnings: ExportWarning[];
};

export function decodeExport(bytes: Uint8Array): string;
export function validZone(zone: unknown): boolean;
export function zonedToUtc(wall: number, zone: string, cache?: Map<string, number[]>): { ms: number; time: ExportMessage['time'] };
export function detectDateOrder(stamps: { a: string; b: string; c: string }[]): { order: DateOrder | null; certain: boolean };
export function cleanLabel(raw: string): string;
export function isPhoneLabel(label: string): boolean;
export function displayLabel(label: string): string;
export function parseWhatsAppExport(text: string, options: { timeZone: string; dateOrder?: DateOrder | 'auto' }): ParsedExport;
export function sha256Hex(data: Uint8Array | string): Promise<string>;
export function participantKey(label: string): Promise<string>;
export function importKeys(messages: Pick<ExportMessage, 'local' | 'sender' | 'kind' | 'body'>[]): Promise<string[]>;
export type Suggestion = { status: 'same_name' | 'several' | 'first_name' | 'phone' | 'none'; candidates: string[] };
export function suggestPeople(participants: Pick<ExportParticipant, 'label' | 'phone'>[], people: { id: string; name: string }[]): Suggestion[];
