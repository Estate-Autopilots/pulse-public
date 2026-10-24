/** Stable path and response contract for the editor weekly report. */
export const API_V1_PATHS = {
  catalogItems: () => '/api/v1/catalog/items',
  quoteReadyNotice: (id: string) => `/api/v1/service/quotes/${encodeURIComponent(id)}/ready-notice`,
  editorWeek: (person: string, week: string) => `/v1/editors/${encodeURIComponent(person)}/week?week=${encodeURIComponent(week)}`,
  claimableDeliveries: (week: string) => `/v1/deliveries/claimable?week=${encodeURIComponent(week)}`,
  deliveryClaims: (week: string, status = "pending") => `/v1/deliveries/claims?week=${encodeURIComponent(week)}&status=${encodeURIComponent(status)}`,
  claimDelivery: (deliveryId: string) => `/v1/deliveries/${encodeURIComponent(deliveryId)}/claim`,
  decideDeliveryClaim: (deliveryId: string) => `/v1/deliveries/${encodeURIComponent(deliveryId)}/claim/decide`,
  claimableDesigns: (week: string) => `/v1/designs/claimable?week=${encodeURIComponent(week)}`,
  designClaims: (week: string, status = "pending") => `/v1/designs/claims?week=${encodeURIComponent(week)}&status=${encodeURIComponent(status)}`,
  claimDesign: (designId: string) => `/v1/designs/${encodeURIComponent(designId)}/claim`,
  claimableUploaderAccounts: () => "/v1/accounts/claimable",
  uploaderAccountClaims: (status?: AccountClaimStatus) => status
    ? "/v1/accounts/claims?status=" + encodeURIComponent(status) : "/v1/accounts/claims",
  claimUploaderAccount: (accountId: string) => "/v1/accounts/" + encodeURIComponent(accountId) + "/claim",
  decideUploaderAccountClaim: (accountId: string) => "/v1/accounts/" + encodeURIComponent(accountId) + "/claim/decide",
  revertUploaderAccountClaim: (accountId: string) => "/v1/accounts/" + encodeURIComponent(accountId) + "/claim/revert",
} as const;

/** Install-local operator endpoint; requires the server operator token, never a staff session. */
export const operatorAgentChatPath = '/api/v1/operator/agent-chat';
export interface OperatorAgentChatRequest { name: string; username: string; chat: string; members: string[] }
export interface OperatorAgentChatResult { agentId: string; chatId: string }
export interface QuoteReadyNotice { id: string; notifiedAt: string; repeat: boolean }

/** Install-local catalog.read: price is integer INR paise before GST; taxRate is a percentage. */
export interface CatalogItem {
  id: string; kind: 'service' | 'product' | 'consumable' | 'package'; name: string; description: string;
  price: number; currency: 'INR'; taxRate: number; publicLink: string | null;
}
export interface CatalogResponse { items: CatalogItem[] }

export type EditorCreativeType = "model_video" | "vov" | "founder_video" | "testimonial" | "walkthrough" | "other";

export interface EditorWeeklyTarget {
  target: number | null;
  delivered: { drafts: number; finals: number };
  /** Confirmed shared-login claims, already counted in delivered. */
  claimed: { drafts: number; finals: number };
  gap: number | null;
  placeholder: boolean;
}

export type DeliveryClaimStatus = "pending" | "confirmed" | "rejected";
export type AccountClaimStatus = "pending" | "confirmed" | "rejected" | "reverted";
export interface ClaimableUploaderAccount {
  id: string;
  handle: string;
  deliveryCount: number;
  lastDelivery: string;
}
export interface UploaderAccountClaim {
  id: string;
  accountId: string;
  handle: string;
  personId: string;
  personName?: string;
  status: AccountClaimStatus;
  createdAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  reason?: string | null;
}
export interface ClaimableUploaderAccountsResponse { accounts: ClaimableUploaderAccount[] }
export interface UploaderAccountClaimsResponse { claims: UploaderAccountClaim[] }
export interface ClaimableDelivery {
  id: string;
  projectName: string;
  fileName: string;
  kind: "draft" | "final";
  deliveredAt: string;
}
export interface DeliveryClaim {
  id: string;
  deliveryId: string;
  personId: string;
  status: DeliveryClaimStatus;
  creditedVia: "claim";
  createdAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
}
export interface DeliveryClaimReview extends DeliveryClaim {
  personName: string;
  projectName: string;
  fileName: string;
  kind: "draft" | "final";
  deliveredAt: string;
}
export interface ClaimableDeliveriesResponse { week: string; deliveries: ClaimableDelivery[] }
export interface DeliveryClaimsResponse { week: string; claims: DeliveryClaimReview[] }

export type DesignDeliveryType = "single_image_ad" | "carousel" | "brochure" | "logo" | "pitch_deck" | "other";
export interface ClaimableDesign {
  id: string;
  projectName: string;
  fileName: string;
  type: DesignDeliveryType;
  uploadedAt: string;
  status: "claimable" | "pending";
}
export interface DesignClaim {
  id: string;
  designId: string;
  personId: string;
  status: DeliveryClaimStatus;
  creditedVia: "claim";
  createdAt: string;
}
export interface DesignClaimReview extends DesignClaim {
  personName: string;
  projectName: string;
  fileName: string;
  type: DesignDeliveryType;
  uploadedAt: string;
}
export interface ClaimableDesignsResponse { week: string; designs: ClaimableDesign[] }
export interface DesignClaimsResponse { week: string; claims: DesignClaimReview[] }

export type EditorTaskStatus = "open" | "in_progress" | "blocked" | "in_review";

export interface LinkedTaskAsset {
  id: string;
  /** Google Drive viewer URL for the latest non-trashed file, or null when no safe link exists. */
  url: string | null;
}

export interface EditorOpenTask {
  id: string;
  title: string;
  status: EditorTaskStatus;
  dueAt: string | null;
  assets: LinkedTaskAsset[];
}

export interface EditorWeekResponse {
  week: string;
  types: Record<EditorCreativeType, EditorWeeklyTarget>;
  /** Included only for the authenticated person's own report. */
  openTasks?: EditorOpenTask[];
}
