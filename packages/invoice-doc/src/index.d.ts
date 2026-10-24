// Types for @pulse/invoice-doc: GST arithmetic, the document model and its PDF and DOCX writers (ERP-INVOICE).
export * from './gst.js';
import type { Computed, LineInput } from './gst.js';

export type DocType = 'invoice' | 'proforma' | 'quotation' | 'credit_note';
export const DOC_TYPES: readonly DocType[];
export const DOC_LABELS: Readonly<Record<DocType, { title: string; number: string; date: string; noun: string }>>;
export type ShowKey = 'sac' | 'qtyRate' | 'discount' | 'lineTax' | 'taxSummary' | 'words' | 'bank' | 'signature' | 'placeOfSupply' | 'dueDate' | 'project' | 'contact' | 'notes' | 'terms' | 'pageNumbers' | 'balance';
export const SHOW_DEFAULTS: Readonly<Record<ShowKey, boolean>>;
export const STYLES: readonly ('band' | 'line' | 'minimal')[];
export type Design = {
  style: 'band' | 'line' | 'minimal'; accent: string; text: string; muted: string; fontScale: number;
  logo: { show: boolean; position: 'left' | 'right'; height: number };
  titles: Record<DocType, string>; show: Record<ShowKey, boolean>; terms: string;
  bank: { accountName: string; bankName: string; accountNumber: string; ifsc: string; branch: string; upi: string };
  signature: { label: string; name: string; title: string; showImage: boolean }; footer: string;
};
export function normaliseDesign(design?: unknown): Design;

export type Party = { name?: string; legalName?: string; tradeName?: string; gstin?: string | null; stateCode?: string | null; pan?: string | null; address?: string[]; email?: string | null; phone?: string | null; website?: string | null; contactName?: string | null };
export type DocumentInput = {
  docType: DocType; status?: string; number?: string | null; issueDate: string; dueDate?: string | null; validUntil?: string | null;
  seller: Party; buyer: Party; placeOfSupply?: string | null;
  reference?: { project?: string; milestone?: string; po?: string };
  against?: { number?: string | null; date?: string | null } | null;
  lines: LineInput[]; notes?: string | null; terms?: string | null;
  reverseCharge?: boolean; zeroRated?: boolean; roundTotal?: boolean; paid?: number; credited?: number;
};
export type Asset = { bytes: Uint8Array; mime: string };
export type Model = {
  docType: DocType; page: { width: number; height: number; margin: number }; style: Design['style'];
  colors: { accent: string; text: string; muted: string }; fontScale: number; title: string; draft: boolean; cancelled: boolean;
  logo: (Asset & { position: 'left' | 'right'; height: number; width?: number }) | null;
  seller: { name: string; lines: string[] }; parties: { heading: string; name: string; lines: string[] }[]; meta: [string, string][];
  table: { columns: { key: string; label: string; align: 'left' | 'right'; width: number }[]; rows: { cells: Record<string, string>; sub: Record<string, string> }[] };
  totals: { label: string; value: string; strong?: boolean }[]; balance: { label: string; value: string; strong?: boolean }[] | null;
  words: string | null; taxSummary: { columns: string[]; rows: string[][]; total: string[] } | null;
  notes: string | null; terms: string | null; bank: [string, string][] | null;
  signature: { forLine: string; label: string; name: string; title: string; image: Asset | null } | null;
  footer: string | null; pageNumbers: boolean; computed: Computed;
  meta_info: { title: string; subject: string; date: string | null };
};
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null;
export function buildModel(design: unknown, doc: DocumentInput, assets?: { logo?: Asset | null; signature?: Asset | null }): Model;
export type Fonts = { regular: Uint8Array | ArrayBuffer; semibold: Uint8Array | ArrayBuffer };
export function renderPdf(model: Model, options: { fonts: Fonts }): Promise<{ bytes: Uint8Array; pages: number }>;
export function renderDocx(model: Model, options?: { fonts?: Fonts }): Promise<Uint8Array>;
export const SAMPLE_BUYERS: Readonly<Record<'intra' | 'inter', Party>>;
export function sampleDocument(seller: Party | null, options?: { docType?: DocType; inter?: boolean; number?: string | null; issueDate?: string }): DocumentInput;
export const FONT_URLS: Readonly<{ regular: URL; semibold: URL }>;

// COMP-A: pay letters with the same design, fonts and writers.
export type LetterKind = 'offer' | 'revision' | 'promotion' | 'role_change' | 'correction' | 'start' | 'probation_confirm' | 'probation_extend' | 'probation_end' | 'pause' | 'settlement';
export const LETTER_KINDS: readonly LetterKind[];
export const LETTER_DEFAULTS: Readonly<Record<LetterKind, { title: string; body: string }>>;
export type LetterTable = { columns: string[]; rows: string[][]; total: string[] | null };
export type LetterData = Record<string, unknown> & { currency?: string; components?: { label: string; amount: number }[]; statement?: { label: string; kind: 'earning' | 'deduction'; amount: number }[] };
export function letterMoney(paise: number, currency?: string): string;
export function letterFields(data: LetterData): Record<string, string>;
export function fillLetter(template: string, fields: Record<string, string>): string[];
export function letterContent(kind: string, data: LetterData, overrides?: Record<string, { title?: string; body?: string }>): { kind: LetterKind; title: string; paragraphs: string[]; table: LetterTable | null };
export type LetterInput = { kind: string; title: string; paragraphs: string[]; table: LetterTable | null; date: string; reference?: string; to: { name: string; lines?: string[] };
  company: { name: string; lines?: string[] }; accepted?: { name: string; at: string; via?: string } | null; draft?: boolean };
export type LetterModel = ReturnType<typeof buildLetterModel>;
export function buildLetterModel(design: unknown, letter: LetterInput, assets?: { logo?: Asset | null; signature?: Asset | null }): {
  page: { width: number; height: number; margin: number }; title: string; paragraphs: string[]; table: LetterTable | null; [k: string]: unknown };
export function renderLetterPdf(model: LetterModel, options: { fonts: Fonts }): Promise<{ bytes: Uint8Array; pages: number }>;
export function renderLetterDocx(model: LetterModel, options?: { fonts?: Fonts }): Promise<Uint8Array>;
