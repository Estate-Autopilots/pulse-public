// ERP-INVOICE: what services/api/src/erp.ts answers. Money is integer paise.
import type { DocType, DocumentInput } from "@pulse/invoice-doc";

export type Company = { legalName?: string; tradeName?: string; gstin?: string | null; stateCode?: string; pan?: string | null; address?: string[]; email?: string; phone?: string; website?: string };
export type Buyer = { name?: string; gstin?: string | null; stateCode?: string | null; address?: string[]; contactName?: string | null; email?: string | null; phone?: string | null };
export type DocStatus = "draft" | "issued" | "sent" | "part_paid" | "paid" | "cancelled" | "accepted" | "declined" | "converted";
export type Doc = {
  id: string; docType: DocType; status: DocStatus; number: string | null; fy: string | null; issueDate: string; dueDate: string | null; validUntil: string | null;
  clientId: string | null; projectId: string | null;
  /** BILLING (4 Nov 2026, 1470): the point of contact (a Contacts person) and the project location (the site), apart from the billing address. */
  contactPersonId?: string | null; siteLocation?: string | null;
  /** BILLING (1471): 0 for the first approved copy, +1 per Revise; the cancelled document this one re-issues. */
  revision?: number; reissueOf?: string | null; engagementId: string | null; milestoneId: string | null; againstId: string | null; sourceId: string | null; templateId: string | null;
  seller: Company; buyer: Buyer; placeOfSupply: string | null; reference: { project?: string; milestone?: string; po?: string }; notes: string; terms: string | null;
  reverseCharge: boolean; zeroRated: boolean; roundTotal: boolean; taxMode: "intra" | "inter" | null; taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number;
  amountWords: string | null; paid: number; credited: number; taskId: string | null; issuedAt: string | null; sentAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  decision: { decision: string; name?: string; at: string; via: string; note?: string | null } | null; createdAt: string; updatedAt: string; createdBy: string | null; issuedBy: string | null; project?: string | null;
  /** EST-1248 (when its migration 0506 is in): a quotation drafted by a service key whose price differs from the catalogue. */
  ownerApproval?: "needed" | "approved" | null; salespersonId?: string | null; salespersonName?: string | null; fromServiceKey?: boolean;
  /** BILLING-WL (1500): the Sales X-Ray lead it was started for, and who it was sent to for approval, by whom and when. */
  sxLeadId?: string | null; approvalTo?: string | null; approvalToName?: string | null; approvalAskedBy?: string | null; approvalAskedByName?: string | null;
  approvalAskedAt?: string | null; approvalNote?: string | null;
  /** KAZUK-FLOW G7/G8 (1672): why a deal was lost, when the customer's reply started a negotiation, the source quotation's
   *  version this document was made from, and the deal's one status. */
  lostReason?: string | null; lostNote?: string | null; negotiatingAt?: string | null; sourceRevision?: number | null; dealStatus?: DealStatus | null;
};
/** EST-1236: `parentIndex` (on save) / `parentLineId` (as read) make a line an add-on of another line; `open` is an amount
 *  priced per site; `notNeeded` keeps it on the draft and out of the totals, PDF and issued document. */
export type Line = { id?: string; itemId: string | null; description: string; details: string; sac: string | null; unit: string | null; qty: number; rate: number; discount: number; discountPercent: number | null; gstRate: number;
  parentIndex?: number | null; parentLineId?: string | null; open?: boolean; notNeeded?: boolean;
  /** BILLING-WL (1500): an extended-warranty line's months (an add-on of the line it extends); the serials a tax invoice line sells. */
  warrantyMonths?: number | null; serials?: string[] };
/** BILLING-WL: a warranty extension an item sells: the months it adds and its price before GST (paise). */
export type WarrantyOption = { months: number; price: number };
/** An item's usual add-on, as listed with the item. */
export type AddOn = { itemId: string; name: string; price: number };
export type Template = { id: string; name: string; docTypes: DocType[]; design: Record<string, unknown>; logoId: string | null; signatureId: string | null; archived?: boolean; defaultFor?: DocType[]; updatedAt?: string };
export type CatalogItem = { /** KAZUK-FLOW (G1): added by this person (a salesperson changes only those). */ mine?: boolean; id: string; kind: "service" | "product" | "consumable" | "package"; code: string | null; name: string; description: string; sac: string | null; unit: string; price: number; gstRate: number; cost: number | null;
  trackStock: boolean; reorderLevel: number | null; status: "draft" | "active" | "archived"; version: number; source: Record<string, unknown>; updatedAt: string; parts?: number; onHand?: number | null; sold?: number;
  milestones?: { label: string; percent: number; offsetDays: number }[]; setup?: string;
  warrantyMonths?: number | null; warrantyOptions?: WarrantyOption[]; serialised?: boolean };
export type Part = { id?: string; itemId: string | null; itemName?: string | null; itemPrice?: number | null; label: string; quantity: number; unit: string | null; deliverables: string[]; where: string; setup: string; derives: string; price: number | null; cost: number | null };
export type Person = { id: string; name: string };
/** A catalogue item a document line can come from. `status`/`code` arrive with the billing redesign's API (18 Oct). */
export type CatalogPick = { id: string; kind: string; name: string; description: string; sac: string | null; unit: string; price: number; gstRate: number; status?: string; code?: string | null;
  warrantyMonths?: number | null; warrantyOptions?: WarrantyOption[]; serialised?: boolean; onHand?: number | null };
/** BILLING-WL: who approves a draft, whether this person may, and the request made (if any). */
export type Approval = { required: boolean; canApprove: boolean; approvers: { id: string; name: string; lead: boolean }[];
  asked: { by: string | null; to: string | null; toId: string | null; at: string | null; note: string | null; mine: boolean; forMe: boolean } | null };
export type Milestone = { id: string; position: number; label: string; amount: number; dueOn: string | null; documentId: string | null; documentStatus: DocStatus | null; number: string | null; taskId: string | null; taskStatus: string | null; assignee: string | null };
export type Engagement = { id: string; name: string; packageId: string | null; packageVersion: number | null; price: number; gstRate: number; startsOn: string | null; status: string; milestones: Milestone[] };

export type Overview = {
  canWrite: boolean; accountant: boolean; today: string; fy: string; settings: { company: Company; inventoryEnabled: boolean };
  kpis: { drafts: number; invoiced: number; outstanding: number; overdue: number; overdueCount: number; openQuotes: number; collected: number };
  due: { id: string; label: string; amount: number; dueOn: string; position: number; engagementId: string; engagement: string; projectId: string; project: string | null; client: string | null; documentId: string | null; documentStatus: string | null; taskId: string | null; taskStatus: string | null; assignee: string | null }[];
  recent: Doc[]; overdue: Doc[]; lowStock: { id: string; name: string; unit: string; reorderLevel: number; onHand: number }[];
  catalog: { items: number; packages: number; drafts: number }; assignees: Person[]; mirror: { enabled: boolean; name: string | null; note: string };
  /** BILLING-WL: drafts sent to this person for approval, approved documents not yet sent, drafts this person waits on. */
  forMe?: Doc[]; toSend?: Doc[]; waiting?: Doc[];
  /** KAZUK-FLOW (1670): a salesperson's seat (their own deals only), whether cost shows, and the company's approval mode. */
  ownOnly?: boolean; seesCost?: boolean; approvalMode?: ApprovalMode;
};
/** KAZUK-FLOW (G2): "none" (no approve step anywhere: the main button sends) or "approver" (BILLING-WL's approval). */
export type ApprovalMode = "none" | "approver";
export type DealStatus = "draft" | "to_send" | "sent" | "negotiating" | "accepted" | "lost" | "cancelled" | "invoiced" | "part_paid" | "paid";
export const DEAL_LABEL: Record<DealStatus, string> = { draft: "Draft", to_send: "To send", sent: "Sent", negotiating: "Negotiating", accepted: "Accepted", lost: "Lost", cancelled: "Cancelled",
  invoiced: "Invoiced", part_paid: "Part-paid", paid: "Paid" };
export const LOST_REASONS: [string, string][] = [["price", "Price"], ["competitor", "Competitor"], ["no_response", "No response"], ["timing", "Timing"], ["scope", "Scope"], ["other", "Other"]];
export const VERSION_REASONS: [string, string][] = [["price", "Price"], ["scope", "Scope"], ["timeline", "Timeline"], ["other", "Other"]];
export type DocumentData = {
  document: Doc; lines: (Line & { taxable: number; cgst: number; sgst: number; igst: number; total: number })[];
  payments: { id: string; receivedOn: string; amount: number; tds: number; method: string; reference: string; bankLineKey: string | null; note: string; voidedAt: string | null; voidReason: string | null; by: string | null; account?: string | null;
    /** KAZUK-FLOW G10: the proof's type when one was uploaded (opened at /api/v0/erp/payments/<id>/proof). */ proofMime?: string | null }[];
  events: { kind: string; detail: Record<string, unknown>; at: string; actor: string | null }[]; related: Doc[]; file: { sha256: string; createdAt: string; size: number } | null;
  task: { id: string; title: string; status: string; dueOn: string | null; assignee: string | null } | null;
  links: { createdAt: string; expiresAt: string; revokedAt: string | null; openedAt: string | null; decidedAt: string | null; decision: string | null; signer: string | null }[];
  bank: { key: string; date: string; amount: number; payer: string | null; reference: string | null; variant: string; tds: number }[];
  items: CatalogPick[];
  templates: Template[]; template: Template | null; orgLogo: boolean; company: Company; canWrite: boolean; today: string; assignees: Person[]; financeSyncedAt: string | null;
  /** FINANCE-TRUTH: the Cash book's accounts (the GST account named) and an issued invoice's base and GST still due. */
  paymentAccounts?: { accounts: string[]; gstAccount: string | null } | null; due?: { baseDue: number; gstDue: number } | null;
  /** BILLING (1471): the approved copies a revised quotation keeps; the project its paid invoice started; its re-issue. */
  versions?: { revision: number; filedAt: string; reason: string | null; reasonKind?: string | null; sentAt?: string | null; total: number; approvedOn: string | null; status: string; pdf: boolean; by: string | null }[];
  startedProject?: { id: string; title: string; assigned: boolean; owner: string | null } | null;
  reissue?: { id: string; number: string | null; status: DocStatus } | null;
  /** BILLING (review): why a paid invoice started no project by itself (blank, the client's live project, or a failure). */
  projectOffer?: { reason: "blank" | "live" | "failed"; project: string | null } | null;
  /** BILLING-WL (1500): serials in stock per serialised item (a draft tax invoice), the approval, WhatsApp Business. */
  stockSerials?: Record<string, string[]>; approval?: Approval | null; whatsapp?: { connected: boolean; next: string }; inventoryEnabled?: boolean;
  /** KAZUK-FLOW (1670). */
  approvalMode?: ApprovalMode; ownOnly?: boolean;
  /** KAZUK-FLOW config (1671): the steps of the company's sales flow that stop this person: why, and who unlocks them. */
  blocks?: Record<string, { step: string; why: string; unlock: string[]; unlockBy: string[] }>;
  /** KAZUK-FLOW config (G3): what a quotation must carry before it is sent (the company's flow). */
  sendRequired?: string[];
  /** KAZUK-FLOW G9: this draft's lines come from the accepted quotation and are locked for this person. */
  linesLocked?: boolean;
  /** KAZUK-FLOW (1688): the company's flow hides proforma from this person. */
  proformaHidden?: boolean;
};
export type TemplatesData = { templates: Template[]; company: Company; orgLogo: boolean; sample: DocumentInput; canWrite: boolean };
export type { DocType, DocumentInput };
