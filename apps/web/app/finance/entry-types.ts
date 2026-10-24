/** FIN-ENTRY: what services/api/src/finance-entry.ts returns. */
export type EntryKind = 'expense' | 'income' | 'bill' | 'refund' | 'transfer';
export type EntryFile = { id: string; name: string; mime: string; size: number };
export type Entry = {
 id: string; kind: EntryKind; direction: 'in' | 'out' | 'neutral'; date: string; amountMinor: number; gstMinor: number; currency: string;
 category: string | null; accountFrom: string | null; accountTo: string | null; clientId: string | null; clientName: string | null;
 projectId: string | null; projectName: string | null; vendor: string | null; note: string | null; billStatus: 'unpaid' | 'paid' | null; dueDate: string | null;
 status: 'approved' | 'pending' | 'rejected'; source: 'manual' | 'quick' | 'whatsapp' | 'chat'; sourceRef: string | null; quickText: string | null;
 createdAt: string; updatedAt: string; deleted: boolean; deleteReason: string | null; decisionNote: string | null; createdBy: string | null; decidedBy: string | null; decidedAt: string | null;
 files: EntryFile[];
};
export type EntrySettings = { approvalMinor: number; categories: string[]; accounts: string[] };
export type EntryOptions = { canWrite: boolean; canApprove: boolean; settings: EntrySettings; clients: { id: string; name: string }[]; projects: { id: string; name: string; clientId: string | null }[] };
export type EntriesData = EntryOptions & {
 entries: Entry[]; months: string[]; whatsapp: number;
 totals: { moneyIn: number; moneyOut: number; count: number; pending: number; pendingMinor: number };
};
export type Quick = {
 kind: EntryKind; direction: 'in' | 'out' | 'neutral'; amountMinor: number | null; gstMinor: number; date: string | null; dueDate: string | null; category: string | null;
 accountFrom: string | null; accountTo: string | null; vendor: string | null; clientId: string | null; clientName: string | null; note: string | null; understood: string[]; missing: string[];
};
export type WaScreen = {
 sha256: string; amount: number | null; amounts: number[]; transactionIds: string[]; datesInText: string[]; payee: string | null; sentAt: string | null;
 sender: string | null; senderRole: string | null; messageText: string | null; groupTitle: string | null; clientHint: string | null; driveFileId: string | null; hasImage: boolean;
 decision: 'confirmed' | 'dismissed' | null; entryId: string | null;
 suggestion: { kind: EntryKind; direction: 'in' | 'out'; date: string; amountMinor: number | null; category: string | null; vendor: string | null; client: string | null; clientId: string | null; clientName: string | null; note: string | null };
 maybeDuplicate: { id: string; date: string } | null;
};
export type WaData = { total: number; offset: number; rows: WaScreen[] };
export const KIND_WORDS: Record<EntryKind, string> = { expense: 'Expense', income: 'Payment received', bill: 'Bill', refund: 'Refund', transfer: 'Transfer' };
export const rupees = (minor: number) => '₹' + (minor / 100).toLocaleString('en-IN', { maximumFractionDigits: minor % 100 ? 2 : 0, minimumFractionDigits: minor % 100 ? 2 : 0 });
