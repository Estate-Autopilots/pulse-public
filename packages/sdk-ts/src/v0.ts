/** Stable HTTP paths for the first web screens. */
export const LEAD_PHOTO_PATHS = {
  photos: (lead: string) => `/api/v0/acquisition/leads/${encodeURIComponent(lead)}/photos`,
  read: (lead: string, media: string) => `/api/v0/acquisition/leads/${encodeURIComponent(lead)}/photos/${encodeURIComponent(media)}`,
} as const;
/** source and takenAt are caller claims; neither verifies a site visit. */
export type LeadPhotoUpload = { requestKey: string; mime: 'image/jpeg' | 'image/png' | 'image/webp'; data: string; source?: 'upload' | 'camera'; takenAt?: string };
export type LeadPhoto = { id: string; leadId: string; uploader: string; uploadedAt: string; takenAt: string | null; source: 'upload' | 'camera'; mime: 'image/webp'; size: number; width: number; height: number };
export type LeadPhotosResponse = { photos: LeadPhoto[] };

export const WAITING_PATHS = {
  taskWaiting: (id: string) => `/api/v0/tasks/${encodeURIComponent(id)}/waiting`,
  blockedOnMe: '/api/v0/me/blocked-on',
  blockedOnAgent: (id: string) => `/api/v0/agents/${encodeURIComponent(id)}/blocked-on`,
} as const;

export const API_V0_PATHS = {
  me: "/api/v0/me",
  myHr: "/api/v0/me/hr",
  myWeek: "/api/v0/my-week",
  podBoard: "/api/v0/pod-board",
  leadershipWeek: "/api/v0/leadership-week",
  editors: "/api/v0/editors",
  editor: (account: string) => "/api/v0/editors/" + encodeURIComponent(account),
  designDeliveriesSummary: "/api/v0/design-deliveries/summary",
  designers: (week?: string) => "/api/v0/designers" + (week ? "?week=" + encodeURIComponent(week) : ""),
  designerBrandProjects: "/api/v0/designers/brand-projects/open",
  designer: (person: string, week?: string) => "/api/v0/designers/" + encodeURIComponent(person)
    + (week ? "?week=" + encodeURIComponent(week) : ""),
} as const;

export type WaitingPerson = { id: string; name: string; ai: boolean };
export type WaitingTask = { id: string; title: string; status: string };
export type WaitingChain = { task: WaitingTask; steps: {
  linkId: string; depth: number; fromId: string; blocker: { id: string; title: string | null; hidden: boolean; status: string };
  actor: (WaitingPerson & { photoAt: string | null }) | null; company: { name: string; address: string | null };
  since: string; answer: null; answeredAt: null; nudgedAt: null; nextNudgeAt: null; next: 'closed' | 'nudge';
}[]; more: number; declared: { kind: string; since: string }[] };
export type BlockedOn = { rows: { linkId: string; since: string; answer: null;
  waiting: WaitingTask & { owner: WaitingPerson | null }; blocker: { id: string; title: string };
}[] };

/** Read-only quotation; money is integer INR paise. No buyer contact fields. */
export const SALESPERSON_QUOTE_PATH = (id: string) => '/api/v0/quotes/' + encodeURIComponent(id);
export interface SalespersonQuote {
  id: string; name: string; status: string; validUntil: string | null;
  lines: { name: string; qty: number; rate: number; gstRate: number; total: number }[];
  taxable: number; tax: number; total: number; ownerApprovalNeeded: boolean; canOpenErp: boolean;
}

export const AUTH_RECOVERY_PATHS = {
  forgotPassword: '/api/v0/auth/forgot',
  forgotUsername: '/api/v0/auth/forgot-username',
  portalForgotPassword: '/api/v0/portal/auth/forgot',
  portalForgotUsername: '/api/v0/portal/auth/forgot-username',
} as const;

/** Account-neutral recovery replies; configured availability never guarantees delivery. */
export type RecoveryResponse = { ok: true; message: string };
export type MailUnavailableResponse = { code: 'MAIL_UNAVAILABLE'; error: 'Mail is unavailable; ask your admin for a new link.' };

/** ISO week in YYYY-Www form, such as 2026-W41. */
export type IsoWeek = string;

/** Evidence carried by every aggregate number in API v0. */
export interface DeliveryWhy {
  rule: string;
  detail: string;
  source: "deliveries_read_model";
  sampleFileIds: string[];
}

export interface ExplainedCount {
  value: number;
  why: DeliveryWhy;
}

export type Role = "person" | "pod_lead" | "hr" | "leadership" | "admin" | "privacy";

export interface MeResponse {
  email: string;
  roles: Role[];
}

/** Employee-owned HR view. Deliberately excludes compensation, finance, contact secrets, and identity documents. */
export interface MyHrResponse {
  employee: {
    name: string;
    status: "active" | "inactive" | "offboarded";
    role: string | null;
    department: string | null;
    employmentType: "full_time" | "part_time" | "intern" | "contract" | "freelance" | null;
    joinedOn: string | null;
  };
  history: Array<{
    field: "department" | "employmentType" | "joinedOn" | "role";
    from: string | null;
    to: string | null;
    at: string;
    by: string | null;
  }>;
  documents: Array<{
    type: "appointment_letter" | "joining_letter" | "offer_letter" | "relieving_letter";
    seenAt: string;
  }>;
  accessHistory: Array<{
    at: string;
    viewer: string;
    resource: string;
    purpose: string;
  }>;
}

export interface ProjectDeliverySummary {
  projectId: string;
  projectName: string;
  deliveries: ExplainedCount;
}

export type AttributionHow = "account map" | "confirmation" | "fingerprint" | "folder owner" | "shared";

export interface DeliveryCredit {
  credited_to: string;
  how: AttributionHow | null;
}

export interface DeliveryAttributionSummary {
  window_days: 30;
  total_deliveries: number;
  credited_to_person: number;
  credited_to_person_share: number;
  shared_login: number;
  shared_login_share: number;
  unresolved: number;
}

export interface RecentDelivery extends DeliveryCredit {
  fileId: string;
  fileName: string;
  projectId: string;
  projectName: string;
  uploaderAccount: string;
  deliverableType: string;
  deliveredAt: string;
  week: IsoWeek;
  matchedRule: string;
  ruleDetail: string;
}

export interface MyWeekResponse {
  week: IsoWeek;
  uploaderAccount: string;
  deliveries: ExplainedCount;
  byProject: ProjectDeliverySummary[];
  recentDeliveries: RecentDelivery[];
  attribution: DeliveryAttributionSummary;
}

export interface EditorsResponse {
  week: string;
  period: { from: string; to: string; kind: string; week: string | null; today: string; inProgress: boolean };
  accounts: Array<{
    account: string;
    sharedLogin: boolean;
    identityVerified: boolean;
    allTime: number;
    thisWeek: number;
    drafts: number;
    finals: number;
    lastDelivery: string | null;
  }>;
  attribution: DeliveryAttributionSummary;
}

export type DesignDeliveryType = "single_image_ad" | "carousel" | "brochure" | "logo" | "pitch_deck" | "other";
export type DesignTypeCounts = Record<DesignDeliveryType, number>;

export interface DesignerWeeklyCount {
  personId: string | null;
  name: string;
  sharedLogin: boolean;
  types: DesignTypeCounts;
  claimed: DesignTypeCounts;
  singleImage: SingleImageProgress;
}

export interface SingleImageProgress {
  perDay: number | null;
  expected: number | null;
  delivered: number;
  gap: number | null;
  placeholder: boolean;
}

export interface DesignersResponse {
  week: IsoWeek;
  designers: DesignerWeeklyCount[];
}

export interface BrandAssetWindow {
  days: { min: number | null; max: number | null };
  placeholder: boolean;
}

export interface DesignerBrandProject {
  personId: string;
  projectId: string;
  brandAsset: "logo" | "colour_palette" | "brochure" | "pitch_deck" | "brand_identity";
  openedOn: string | null;
  daysOpen: number | null;
  window: BrandAssetWindow;
}

export interface DesignerBrandProjectsResponse {
  brandProjects: DesignerBrandProject[];
}

export interface DesignerDailyResponse {
  week: IsoWeek;
  singleImage: SingleImageProgress;
  days: Array<{ day: string; types: DesignTypeCounts; claimed: DesignTypeCounts; singleImage: SingleImageProgress }>;
}

export interface DesignDeliveryAttributionSummary {
  total_deliveries: number;
  credited_to_person: number;
  shared_login: number;
  unresolved: number;
  by_method: {
    account_map: number;
    confirmation: number;
    fingerprint: number;
    folder_owner: number;
    shared: number;
    unresolved: number;
  };
}

export interface DesignDeliveriesSummary {
  window_days: 30;
  total: number;
  unmatched_count: number;
  types: DesignTypeCounts;
  attribution: DesignDeliveryAttributionSummary;
}

export interface EditorTimelineDelivery extends DeliveryCredit {
  fileId: string;
  fileName: string;
  kind: string;
  deliveredAt: string;
  detail: string | null;
  projectName: string;
}

export interface EditorResponse extends MyWeekResponse {
  account: string;
  sharedLogin: boolean;
  identityVerified: boolean;
  days: Array<{ day: string; deliveries: number; drafts: number; finals: number }>;
  weeks: Array<{ week: string; start: string; deliveries: number }>;
  timeline: EditorTimelineDelivery[];
  turnaround: null;
  turnaroundDetail: string;
}

export interface PodUploaderSummary {
  uploaderAccount: string;
  deliveries: ExplainedCount;
}

export interface PodProjectSummary extends ProjectDeliverySummary {
  byUploaderAccount: PodUploaderSummary[];
}

export interface PodBoardResponse {
  week: IsoWeek;
  projects: PodProjectSummary[];
}

export interface LeadershipWeekResponse {
  week: IsoWeek;
  deliveries: ExplainedCount;
  projects: ProjectDeliverySummary[];
}

/** Company-local runner only; send x-pulse-agent-key alone. Pulse derives org/author/channel/board ref. */
export type HandoffUpdateState = 'started' | 'progress' | 'in_review' | 'blocked' | 'cancelled';
export type HandoffUpdate = { clientId: string; state: HandoffUpdateState; text: string; commentId?: string };
export type HandoffUpdateResult = { id: string; state: HandoffUpdateState; boardRef: string };
export const AGENT_HANDOFF_PATHS = {
  poll: '/api/v0/agent/handoffs/poll',
  updates: (id: string) => `/api/v0/agent/handoffs/${encodeURIComponent(id)}/updates`,
} as const;
export type HandoffPoll = { handoffs: { id: string; boardRef: string; names: string[]; commentIds: string[] }[] };
