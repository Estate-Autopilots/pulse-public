// Types for @pulse/invoice-doc: GST arithmetic, the document model and its PDF and DOCX writers (ERP-INVOICE).
export * from './gst.js';
export * from './qty-dims.js';
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
  /** QUOTE-BUILDER: charges settled at the end, printed apart as estimates and left out of the total. */
  estimates?: LineInput[];
  reverseCharge?: boolean; zeroRated?: boolean; roundTotal?: boolean; paid?: number; credited?: number;
};
export type Asset = { bytes: Uint8Array; mime: string };
export type Model = {
  docType: DocType; page: { width: number; height: number; margin: number }; style: Design['style'];
  colors: { accent: string; text: string; muted: string }; fontScale: number; title: string; draft: boolean; cancelled: boolean;
  logo: (Asset & { position: 'left' | 'right'; height: number; width?: number }) | null;
  seller: { name: string; lines: string[] }; parties: { heading: string; name: string; lines: string[] }[]; meta: [string, string][];
  table: { columns: { key: string; label: string; align: 'left' | 'right'; width: number }[];
    rows: { cells: Record<string, string>; sub: Record<string, string>; /** QUOTE-STRUCT */ kind?: 'intro' | 'heading' | 'group'; strike?: string }[] };
  totals: { label: string; value: string; strong?: boolean }[]; balance: { label: string; value: string; strong?: boolean }[] | null;
  words: string | null; taxSummary: { columns: string[]; rows: string[][]; total: string[] } | null;
  notes: string | null; terms: string | null; bank: [string, string][] | null;
  signature: { forLine: string; label: string; name: string; title: string; image: Asset | null } | null;
  footer: string | null; pageNumbers: boolean; computed: Computed; /** QUOTE-BUILDER: the estimates' sum (with GST), 0 without. */ estimate: number;
  meta_info: { title: string; subject: string; date: string | null };
};
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null;
/** QUOTE-STRUCT: a quotation line's printed name and amount in the phase-wise layout, and its table rows. */
export function phasedName(line: LineInput): string;
export function phasedAmount(line: LineInput & { taxable?: number }): string;
export function phasedRows(lines: (LineInput & { taxable?: number })[]): Model['table']['rows'];
export function buildModel(design: unknown, doc: DocumentInput, assets?: { logo?: Asset | null; signature?: Asset | null }): Model;
export type Fonts = { regular: Uint8Array | ArrayBuffer; semibold: Uint8Array | ArrayBuffer };
/** OFFICE-PRINT (2503): how many pages a PDF has. */
export function pdfPageCount(bytes: Uint8Array): Promise<number>;
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

// CONTRACTS-2: an agreement's words (agreement-text.js) and its PDF with the audit page (agreement.js).
export type AgreementBlank = { key: string; label: string; group: 'Client' | 'Work' | 'Money' | 'Us' };
export const AGREEMENT_BLANKS: readonly AgreementBlank[];
export function blankLabel(key: string): string;
export function blanksIn(body: string): string[];
export function fillAgreement(body: string, values?: Record<string, string | null | undefined>): string;
export type AgreementClause = { key: string; number: number | null; title: string; text: string };
export function agreementClauses(body: string): AgreementClause[];
export function clauseName(c: { number: number | null; title: string }): string;
// AGREEMENTS: a published policy's key terms, the steps of its acceptance view (API and screens split one way).
export type PolicyTerm = { key: string; number: number | null; title: string; text: string };
export function policyTerms(body: string): { intro: string; terms: PolicyTerm[]; closing: { title: string; text: string } | null };
export function diffLines(before: string, after: string): { kind: 'same' | 'added' | 'removed'; text: string }[];
export function clauseChanges(before: string, after: string): { changed: string[]; added: string[]; removed: string[] };
// CONTRACTS-3: word by word, and clause by clause for "Compare".
export type WordPart = { kind: 'same' | 'added' | 'removed'; text: string };
export function diffWords(before: string, after: string): WordPart[];
export type ClauseCompare = { key: string; name: string; status: 'same' | 'changed' | 'added' | 'removed'; words: WordPart[] };
export function compareClauses(before: string, after: string): ClauseCompare[];
export const STARTER_AGREEMENT: string;
export const STARTER_SERVICE_AGREEMENT: string;
export const STARTER_TEMPLATES: readonly { key: "standard" | "msa"; name: string; body: string }[];
export const SHEET_BLANKS: readonly { key: string; label: string; hint: string }[];
export type AgreementPdfModel = { title: string; from?: string; reference?: string; version: number; status: string; signedAt?: string | null; body: string;
  sha256?: string; printed?: string;
  parties: { name: string; role?: string; signer?: string | null; signedAt?: string | null; kind?: string | null; image?: Uint8Array | null; declinedAt?: string | null }[];
  audit: { at: string; what: string; who?: string | null; via?: string | null; detail?: string | null }[] };
export function renderAgreementPdf(model: AgreementPdfModel, options: { fonts: Fonts }): Promise<{ bytes: Uint8Array; pages: number }>;
// COMPANY-OPS: a Docs doc (its Markdown) as a PDF and a Word file, for the Drive backup.
export type DocBlock = { type: 'heading'; level: 1 | 2 | 3 | 4; text: string } | { type: 'paragraph' | 'quote'; text: string }
  | { type: 'bullet' | 'number'; level: number; text: string; n?: number } | { type: 'table'; rows: string[][] } | { type: 'rule' };
export function docBlocks(markdown: string): DocBlock[];
export function docRuns(line: string): { text: string; bold: boolean }[];
export function safeFileName(name: string, ext?: string): string;
export type DocExport = { title: string; markdown: string; footer?: string };
export function renderDocPdf(doc: DocExport, options: { fonts: Fonts }): Promise<Uint8Array>;
export function renderDocDocx(doc: DocExport): Promise<Buffer>;

// CONTRACTS-PRO: a contract's source (facts + light Markdown), its parts, and the typeset PDF.
export type ContractRun = { text: string; bold?: boolean; field?: string; gap?: boolean; filled?: boolean };
export type ContractBlock =
  | { kind: 'heading'; level: 1 | 2; number: string | null; title: string; part: 'clause' | 'recitals' | 'schedule' | 'signatures' }
  | { kind: 'para'; number: string | null; runs: ContractRun[]; hang?: boolean }
  | { kind: 'item'; depth: 1 | 2; number: string; runs: ContractRun[] }
  | { kind: 'table'; rows: ContractRun[][][] }
  | { kind: 'note'; runs: ContractRun[] }
  | { kind: 'rule' };
export type ContractPartyFacts = { key?: string; name: string; type: string; defined: string; role?: string; address?: string; reg?: string; gstin?: string; email?: string;
  signatory?: string; title?: string; note?: string; order?: number };
export type ContractMeta = { v: 1; type: string; date?: string; place?: string; ordered?: boolean; parties: ContractPartyFacts[]; deal: Record<string, string> };
export type ContractTypeDef = { key: string; label: string; short: string; kind: string; title: string; parties: { role: string; defined: string; type: string }[]; fields: string[] };
export const PARTY_TYPES: readonly { key: string; label: string; reg: string }[];
export const CONTRACT_TYPES: readonly ContractTypeDef[];
export const DEAL_FIELDS: Readonly<Record<string, { label: string; hint: string }>>;
export const CLAUSE_LIBRARY: readonly { key: string; title: string; text: string }[];
export function contractType(key: unknown): ContractTypeDef;
export function dealLabel(key: string): string;
export function readSource(body: string): { meta: ContractMeta | null; text: string };
export function writeSource(meta: Partial<ContractMeta> | null, text: string): string;
export function tidyMeta(m: unknown): ContractMeta;
export function contractFields(meta: ContractMeta | null, text?: string | null): { key: string; label: string; value: string; group: string }[];
export function refKey(title: string): string;
export function clauseRefs(text: string): Map<string, { number: string; title: string }>;
export function emptyFields(body: string): string[];
export function fieldLabel(key: string, meta: ContractMeta | null): string;
export function stripNumber(t: string): string;
export function parseContract(text: string): { title: string; blocks: ContractBlock[] };
export function runsOf(s: string): ContractRun[];
export function fillRuns(runs: ContractRun[], meta: ContractMeta | null, refs?: Map<string, { number: string; title: string }> | null): ContractRun[];
export function partyDescription(p: Partial<ContractPartyFacts>): string;
export function partyRuns(p: Partial<ContractPartyFacts>): ContractRun[];
export function documentParties(meta: ContractMeta | null, rows?: Record<string, unknown>[]): (ContractPartyFacts & { row: Record<string, unknown> | null })[];
export function starterText(type: string): string;
export function starterSource(type: string, over?: Partial<ContractMeta>): string;
/** POLISH-1115: the contract as its layers (parties, money, duties, ideas and data, term, limits, law, general, schedules). */
export type ContractLayer = { key: string; label: string; hint: string; clauses: { number: string; title: string }[]; facts: { label: string; value: string }[];
  parties?: { name: string; defined: string; type: string; signatory: string }[]; terms?: string[] };
export function contractLayers(body: string): ContractLayer[];
export function definedTerms(text: string): string[];
export function longDate(s: string): string;
export type ContractSignRow = { key?: string; name: string; role?: string; kind?: string; signer?: string | null; signedAt?: string | null; signKind?: string | null;
  image?: Uint8Array | null; paths?: { w: number; h: number; d: string[] } | null; network?: string | null; device?: string | null; declinedAt?: string | null };
export type ContractInput = { title: string; body: string; status: string; version: number; reference?: string; company?: { name: string; lines: string[] };
  parties?: ContractSignRow[]; audit?: { at: string; what: string; who?: string | null; via?: string | null; detail?: string }[]; sha256?: string; printed?: string };
export function buildContractModel(design: unknown, input: ContractInput, assets?: { logo?: Asset | null }): unknown;
export function renderContractPdf(model: unknown, options: { fonts: Fonts }): Promise<{ bytes: Uint8Array; pages: number }>;
export function scriptSignature(name: string): { d: string; width: number; height: number; baseline: number } | null;
export function scriptSignatureSvg(name: string, o?: { color?: string; stroke?: number }): string | null;
/** POLISH-1115: a signature's vector, kept inside its PNG (tEXt "pulse-signature"). */
export type SignatureVector = { v: 1; box: [number, number, number, number]; d: string[]; stroke?: number };
export function tidyVector(v: unknown): SignatureVector | null;
export function pngWithVector(png: Uint8Array, vector: unknown): Uint8Array;
export function vectorOfPng(png: Uint8Array | null | undefined): SignatureVector | null;
export function pngBytesOf(dataUrl: string): Uint8Array | null;
export function pngDataUrl(bytes: Uint8Array): string;
export { isEstimate, priceComparison } from './quote-compare.js';
export type { CompareLine, PriceComparison } from './quote-compare.js';
