// ERP-INVOICE: what services/api/src/erp.ts answers. Money is integer paise.
import type { DocType, DocumentInput } from "@pulse/invoice-doc";

export type Company = { legalName?: string; tradeName?: string; gstin?: string | null; stateCode?: string; pan?: string | null; address?: string[]; email?: string; phone?: string; website?: string };
export type Buyer = { name?: string; gstin?: string | null; stateCode?: string | null; address?: string[]; contactName?: string | null; email?: string | null; phone?: string | null };
export type DocStatus = "draft" | "issued" | "sent" | "part_paid" | "paid" | "cancelled" | "accepted" | "declined" | "converted";
export type Doc = {
  id: string; docType: DocType; status: DocStatus; number: string | null; fy: string | null; issueDate: string; dueDate: string | null; validUntil: string | null;
  clientId: string | null; projectId: string | null; engagementId: string | null; milestoneId: string | null; againstId: string | null; sourceId: string | null; templateId: string | null;
  seller: Company; buyer: Buyer; placeOfSupply: string | null; reference: { project?: string; milestone?: string; po?: string }; notes: string; terms: string | null;
  reverseCharge: boolean; zeroRated: boolean; roundTotal: boolean; taxMode: "intra" | "inter" | null; taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number;
  amountWords: string | null; paid: number; credited: number; taskId: string | null; issuedAt: string | null; sentAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  decision: { decision: string; name?: string; at: string; via: string; note?: string | null } | null; createdAt: string; updatedAt: string; createdBy: string | null; issuedBy: string | null; project?: string | null;
  /** EST-1248 (when its migration 0506 is in): a quotation drafted by a service key whose price differs from the catalogue. */
  ownerApproval?: "needed" | "approved" | null; salespersonId?: string | null; salespersonName?: string | null; fromServiceKey?: boolean;
};
/** EST-1236: `parentIndex` (on save) / `parentLineId` (as read) make a line an add-on of another line; `open` is an amount
 *  priced per site; `notNeeded` keeps it on the draft and out of the totals, PDF and issued document. */
export type Line = { id?: string; itemId: string | null; description: string; details: string; sac: string | null; unit: string | null; qty: number; rate: number; discount: number; discountPercent: number | null; gstRate: number;
  parentIndex?: number | null; parentLineId?: string | null; open?: boolean; notNeeded?: boolean };
/** An item's usual add-on, as listed with the item. */
export type AddOn = { itemId: string; name: string; price: number };
export type Template = { id: string; name: string; docTypes: DocType[]; design: Record<string, unknown>; logoId: string | null; signatureId: string | null; archived?: boolean; defaultFor?: DocType[]; updatedAt?: string };
export type CatalogItem = { id: string; kind: "service" | "product" | "consumable" | "package"; code: string | null; name: string; description: string; sac: string | null; unit: string; price: number; gstRate: number; cost: number | null;
  trackStock: boolean; reorderLevel: number | null; status: "draft" | "active" | "archived"; version: number; source: Record<string, unknown>; updatedAt: string; parts?: number; onHand?: number | null; sold?: number;
  milestones?: { label: string; percent: number; offsetDays: number }[]; setup?: string };
export type Part = { id?: string; itemId: string | null; itemName?: string | null; itemPrice?: number | null; label: string; quantity: number; unit: string | null; deliverables: string[]; where: string; setup: string; derives: string; price: number | null; cost: number | null };
export type Person = { id: string; name: string };
/** A catalogue item a document line can come from. `status`/`code` arrive with the billing redesign's API (18 Oct). */
export type CatalogPick = { id: string; kind: string; name: string; description: string; sac: string | null; unit: string; price: number; gstRate: number; status?: string; code?: string | null };
export type Milestone = { id: string; position: number; label: string; amount: number; dueOn: string | null; documentId: string | null; documentStatus: DocStatus | null; number: string | null; taskId: string | null; taskStatus: string | null; assignee: string | null };
export type Engagement = { id: string; name: string; packageId: string | null; packageVersion: number | null; price: number; gstRate: number; startsOn: string | null; status: string; milestones: Milestone[] };

export type Overview = {
  canWrite: boolean; accountant: boolean; today: string; fy: string; settings: { company: Company; inventoryEnabled: boolean };
  kpis: { drafts: number; invoiced: number; outstanding: number; overdue: number; overdueCount: number; openQuotes: number; collected: number };
  due: { id: string; label: string; amount: number; dueOn: string; position: number; engagementId: string; engagement: string; projectId: string; project: string | null; client: string | null; documentId: string | null; documentStatus: string | null; taskId: string | null; taskStatus: string | null; assignee: string | null }[];
  recent: Doc[]; overdue: Doc[]; lowStock: { id: string; name: string; unit: string; reorderLevel: number; onHand: number }[];
  catalog: { items: number; packages: number; drafts: number }; assignees: Person[]; mirror: { enabled: boolean; name: string | null; note: string };
};
export type DocumentData = {
  document: Doc; lines: (Line & { taxable: number; cgst: number; sgst: number; igst: number; total: number })[];
  payments: { id: string; receivedOn: string; amount: number; tds: number; method: string; reference: string; bankLineKey: string | null; note: string; voidedAt: string | null; voidReason: string | null; by: string | null }[];
  events: { kind: string; detail: Record<string, unknown>; at: string; actor: string | null }[]; related: Doc[]; file: { sha256: string; createdAt: string; size: number } | null;
  task: { id: string; title: string; status: string; dueOn: string | null; assignee: string | null } | null;
  links: { createdAt: string; expiresAt: string; revokedAt: string | null; openedAt: string | null; decidedAt: string | null; decision: string | null; signer: string | null }[];
  bank: { key: string; date: string; amount: number; payer: string | null; reference: string | null; variant: string; tds: number }[];
  items: CatalogPick[];
  templates: Template[]; template: Template | null; orgLogo: boolean; company: Company; canWrite: boolean; today: string; assignees: Person[]; financeSyncedAt: string | null;
};
export type TemplatesData = { templates: Template[]; company: Company; orgLogo: boolean; sample: DocumentInput; canWrite: boolean };
export type { DocType, DocumentInput };
