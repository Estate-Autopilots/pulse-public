import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { hostHeader, passwordHost, requestHost } from "./host-mode.mjs";
import { apiFailure } from "./load-error.mjs";
import { cache } from "react";
export type AttributionHow = "account map" | "confirmation" | "fingerprint" | "folder owner" | "shared";
export type DeliveryCredit = { credited_to: string; how: AttributionHow | null };
export type DeliveryAttributionSummary = {
  window_days: 30;
  total_deliveries: number;
  credited_to_person: number;
  credited_to_person_share: number;
  shared_login: number;
  shared_login_share: number;
  unresolved: number;
};
export type Delivery = { actorName?: string | null; actorAccount?: string | null; actorBasis?: string | null; editedBy?: string | null; credited_to?: string; how?: AttributionHow | null; fileId: string; fileName: string; projectName?: string; projectId?: string; uploaderAccount: string | null; deliveredAt: string; deliverableType: string; ruleDetail: string; sharedLogin: boolean; identityVerified: boolean; path: string };
export type Period = { from: string; to: string; kind: "this" | "last" | "week" | "custom"; week: string | null; today: string; inProgress: boolean };
export type TrendWeek = { week: string; start: string; deliveries: number; projects?: number };
export type ProjectCount = { projectId: string; projectName: string; count: number; drafts: number; finals: number; lastDeliveredAt?: string };
export type AttendanceEntry = { id: string; personId: string; name: string; checkedInAt: string; checkedOutAt: string | null };
export type LeaveRequest = { id: string; personId: string; name: string; fromDate: string; toDate: string; kind: string; status: string };
export type HrHome = { people?: { headcount: number; ai: number }; attendanceEnabled?: boolean; attendance: { headcount: number; entries: AttendanceEntry[]; ownOpen: boolean; canCheckIn: boolean; checkedInToday: number; present: number } | null; leave: { pending: LeaveRequest[]; onLeaveToday: LeaveRequest[]; upcoming: LeaveRequest[] } };
export type WorkHome = { deliveries: number; deliveriesPrev: number; projects: number; projectsPrev: number; drafts: number; finals: number; today: number; yesterday: number; usual: number; trend: Required<TrendWeek>[]; daily: { day: string; deliveries: number }[]; topProjects: Required<ProjectCount>[]; recent: Delivery[]; attention: { total: number; projects: { projectId: string; projectName: string; lastDeliveredAt: string; recent: number }[] } };
export type HomeBase = { attendanceEnabled?: boolean; role: string; viewer: { name: string; email: string; pod: string | null; person: string | null }; period: Period; freshness: { files: number; lastIndexedAt: string | null; upstreamAt?: string | null; everyMinutes?: number; lastRun?: { ok: boolean | null; error: string | null; startedAt: string; finishedAt: string | null } | null; projects: number; deliveries: number }; generatedAt: string };
export type HomeData = HomeBase & HrHome & (
  | ({ view: "leadership"; accounts: { account: string; sharedLogin: boolean; identityVerified: boolean; person: string | null; count: number; prev: number; lastDelivery: string }[]; pods: { pod: string; people: number }[] } & WorkHome)
  | ({ view: "editor"; account: string } & WorkHome)
  | { view: "hr"; peopleChanges: { id: string; name: string; role: string | null; pod: string | null; status: string; createdAt: string; activeFrom: string | null; activeTo: string | null }[] });
export type Stage = "delivering" | "quiet" | "new" | "dormant" | "paused" | "done" | "cancelled";
export type ProjectRow = { mine?: boolean; projectId: string; title: string; folderName: string; status: string; stage: Stage; kind: string; location: string | null; segment: string | null; deliverableType: string | null; startMonth: string | null; projectKey: string | null; registryNo: number | null; pod: string | null; clientId: string | null; clientName: string | null; total: number; count: number; lastDeliveredAt: string | null; quiet: boolean; videos: number; images: number; latest: { fileId: string; fileName: string; mime: string; kind: string }[] };
export type ProjectDetail = { projectId: string; projectName: string; status: string; pod: string | null; storageRoot: string | null; total: number; drafts: number; finals: number; count: number; prev: number; lastDeliveredAt: string | null; firstDeliveredAt: string | null; files: number; lastFileAt: string | null; period: Period; trend: TrendWeek[]; deliveries: Delivery[]; latest: Delivery[] };
export type WeekData = { people?: { headcount: number; ai: number }; week: string; period: Period; deliveries: { value: number; why: { detail: string } }; drafts: number; finals: number; usual: number; files: number; indexedProjects: number; lastIndexedAt: string | null; scope: string; projects: { projectId: string; projectName: string; count: number; drafts: number; finals: number }[]; recentDeliveries: Delivery[]; pods?: { name: string; projects: number; deliveries: number; detail: string }[] };
export type EditorCreativeType = "model_video" | "vov" | "founder_video" | "testimonial" | "walkthrough" | "other";
export type EditorWeeklyTarget = { target: number | null; delivered: { drafts: number; finals: number }; claimed: { drafts: number; finals: number }; gap: number | null; placeholder: boolean };
export type EditorWeekResponse = { week: string; types: Record<EditorCreativeType, EditorWeeklyTarget> };
export type Editor = { account: string; holder_person_id: string | null; sharedLogin: boolean; identityVerified: boolean; thisWeek: number; allTime: number; drafts: number; finals: number; lastDelivery: string };
export type EditorList = { week: string; period: Period; accounts: Editor[]; attribution: DeliveryAttributionSummary };
export type ClaimableDelivery = { id: string; projectName: string; fileName: string; kind: "draft" | "final"; deliveredAt: string };
export type ClaimableDesign = { id: string; projectName: string; fileName: string; type: string; uploadedAt: string };
export type DeliveryClaimReview = { id: string; deliveryId: string; personId: string; personName: string; projectName: string; fileName: string; kind: "draft" | "final"; deliveredAt: string; status: "pending" | "confirmed" | "rejected"; creditedVia: "claim"; createdAt: string };
export type DesignClaimReview = { id: string; designId: string; personId: string; personName: string; projectName: string; fileName: string; type: string; uploadedAt: string; status: "pending" | "confirmed" | "rejected"; creditedVia: "claim"; createdAt: string };
export type ClaimableDeliveriesResponse = { week: string; deliveries: ClaimableDelivery[] };
export type ClaimableDesignsResponse = { week: string; designs: ClaimableDesign[] };
export type DeliveryClaimsResponse = { week: string; claims: DeliveryClaimReview[] };
export type DesignClaimsResponse = { week: string; claims: DesignClaimReview[] };
export type EditorData = WeekData & { account: string; holder_person_id: string | null; sharedLogin: boolean; identityVerified: boolean; turnaroundDetail: string; days: { day: string; deliveries: number; drafts: number; finals: number }[]; weeks: TrendWeek[]; timeline: (DeliveryCredit & { fileId: string; fileName: string; projectName: string; deliveredAt: string; kind: string; detail: string | null })[] };
export type Change = { field: string; from: string | null; to: string | null; at: string; by: string | null };
export type PersonRow = { stage?: string; leftOn?: string | null; possiblyLeft?: boolean; id: string; name: string; status: string; userNo: number | null; pulseId?: string | null; username: string | null; role: string; pod: string | null; department: string | null; accounts: string[]; evidence: string; joinedOn: string | null; managerId: string | null; managerName: string | null; photoAt: string | null; email: string | null; skills: string[]; workLocation: string | null; deliveries8w: number; checkedIn: boolean; sources: number; flags: string[] };
/** A person in a reporting line: the managers above (nearest first) or the direct reports below. */
export type PersonLink = { id: string; name: string; role: string | null; userNo: number | null; photoAt: string | null };
export type PersonProject = { projectId: string; title: string; clientName: string | null; deliveries: number; lastDeliveredAt: string };
export type PersonSource = { source: string; label: string; writtenName: string; role: string | null; group: string | null; lastSeen: string | null; restricted: boolean };
export type PersonFlag = { id: string; field: string; summary: string; options: { value: string; source: string }[]; status: "open" | "resolved"; resolution: string | null; resolvedAt: string | null; resolvedBy: string | null };
export type FieldSource = { source: string; detail?: string | null; confirm?: boolean };
export type PersonDetail = { attendanceEnabled?: boolean; editedBy?:string|null} & Omit<PersonRow, "accounts" | "deliveries8w" | "checkedIn" | "sources" | "flags"> & { locked: string[]; createdAt: string; phone: string | null; notes: string | null; employmentType: string | null;
  fieldSources: Record<string, FieldSource>; sources: PersonSource[]; flags: PersonFlag[];
  accounts: { handle: string; purpose: string; shared: boolean; deliveries: number }[]; reports: PersonLink[]; managers: PersonLink[]; activity: WeekData | null;
  projects: PersonProject[]; deliveries: Delivery[]; attendance: { id: string; checkedInAt: string; checkedOutAt: string | null }[];
  leave: { id: string; fromDate: string; toDate: string; kind: string; status: string }[];
  login?: { status: string; mustChange: boolean; issuedAt: string; lastLoginAt: string | null } | null; history: Change[];
  can: { edit: boolean; photo: boolean; self: boolean; me?: boolean; login: boolean; link: boolean; work: boolean; hr: boolean; record: boolean; salary: boolean; contact: boolean; contactWrite: boolean; documents: boolean; workMode?: boolean; skills?: boolean }; workDetail: string;
  about?: string | null; pronouns?: string | null; languages?: string[];
  workTerms?: { workMode: "shift" | "outcome"; roleTitle: string | null; roleStatus: string | null; hoursMin: number | null; hoursMax: number | null; officeMin: number | null; officeMax: number | null; otherRoles: string[]; note: string | null } | null };
export type HrRecord = { contact?: { personalEmail: string | null; personalPhone: string | null; emergency: string | null; source: string; updatedAt: string } | null;
  compensation?: { id: string; month: string; kind: "monthly" | "current" | "increment" | "total" | "invoice"; amount: number; currency: string; sourceName: string; sourceSheet: string; basis: string; components?: Record<string, number>; effectiveFrom?: string; effectiveTo?: string | null; termsStatus?: "proposed" | "conditional" | "settled" | "active" | null; termsNote?: string | null }[];
  documents?: { type: string; fileId: string | null; fileName: string | null; location: string | null }[];
  accessLog: { at: string; viewer: string | null; resource: string; purpose: string }[] };
/** ORG: one Pulse account across organisations (the org switcher). */
export type AccountOrg = { id: string; name: string; handle: string | null; code: string; kind: "staff" | "freelancer" | "client" | "partner" | "agent"; current: boolean; lastUsedAt?: string | null; install?: boolean };
export type AccountInvite = { id: string; org: string; orgHandle: string | null; kind: string; title: string | null; at: string };
export type AccountState = { account: null | { id: string; handle: string; name: string; email: string | null; hasPassword: boolean }; suggestion?: string; orgs: AccountOrg[]; invites: AccountInvite[] };
export type Me = { account?: AccountState | null; orgHandle?: string | null; side?: string; mustChange?:boolean;via?:string;email: string; orgName?:string; person: string | null; role: string; name: string; pod: string | null; username: string | null; photoAt: string | null; hrAccess: boolean;
  /** VISIBLE: someone in HR who also holds leadership (their role reads "hr"; they get leadership's pages too). */
  lead?: boolean;
  /** PULSE-ADMIN (1140): this person uses the platform admin console (/admin). */
  platformAdmin?: boolean;
  /** ONBOARD-GATE: while blocked, only /welcome opens (the API answers profile_incomplete elsewhere). */
  profileGate?: { enabled: boolean; blocked: boolean; missing?: string[]; canSkip?: boolean; skippedUntil?: string | null } | null;
  /** EST-647: the organisation's switched-off modules (tenant config); their pages show the neutral page. */
  modules?: { off: string[] };
  /** EST-1419: the screens this person's role does not see and the page bases they cover. */
  hiddenScreens?: { keys: string[]; paths: string[] };
  /** EST-1240/1241: the home this person's role lands on (the organisation's choice; the Dashboard by default). */
  home?: "dashboard" | "sales";
  /** UX-TASKS-2: the business model's words for clients and what is sold. */
  workLabels?: { model: string; section: string | null; clients: string | null; clientProjects: string | null; team?: string; teams?: string } | null;
  /** FLOW-E: the work roles this person holds and the company's words (Settings → Industry & roles). */
  workRoles?: string[]; words?: Record<string, string> | null;
  /** UX-TENANT: the company's own module switches (its setup and Settings → Organisation), and whether this admin runs
   *  the platform (sets up companies). */
  companyModules?: { tasks: boolean; chats: boolean; finance: boolean; attendance: boolean }; operator?: boolean };
export type ApiResult<T> = { data: T; error?: never; status?: number } | { error: string; data?: never; status?: number };
async function apiRequest<T>(path: string, options?: { method: "POST"; body?: string }): Promise<ApiResult<T>> {
  const h = await headers(); const email = await passwordHost(requestHost(h)) ? null : h.get("cf-access-authenticated-user-email");
  const jar=await cookies();
  if(jar.has("pulse_client_session"))return {error:"Client accounts can open only their released portal work."};
  const token = jar.get("pulse_session")?.value;
  if (!email && !token) return { error: "Sign in to Pulse to see your workspace." };
  const identityHeaders: Record<string,string> = { ...hostHeader(h), ...(!token && email ? {"cf-access-authenticated-user-email":email} : {"x-pulse-session":token!}) };
  if(!token&&email&&h.get('cf-access-jwt-assertion'))identityHeaders['x-pulse-access-id']=createHash('sha256').update(h.get('cf-access-jwt-assertion')!).digest('hex');
  // PERF: the page's request id (proxy.ts), so the API's timing of this call joins the page load in telemetry.
  const render = h.get('x-pulse-request-id'); if (render && /^[A-Za-z0-9_-]{8,64}$/.test(render)) identityHeaders['x-pulse-request-id'] = render;
  try {
    // A JSON POST (apiPost) may be rate-limited by the person's own address: pass it on, as the browser's calls do.
    if (options?.body !== undefined) { identityHeaders['content-type'] = 'application/json'; const ip = h.get('cf-connecting-ip'); if (ip) identityHeaders['x-pulse-client-ip'] = ip; }
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${path}`, { ...options, headers: identityHeaders, cache: "no-store", signal: AbortSignal.timeout(15000) });
    // EST-1197: only Pulse's own 4xx refusal sentences reach a page; 5xx, gateway and other text become a fixed line.
    if (!r.ok) return { error: apiFailure(r.status, await r.json().catch(() => null)), status: r.status };
    return { data: await r.json() };
  } catch { return { error: "The data service is reconnecting. Refresh to try again." }; }
}
export const api = <T>(path: string) => apiRequest<T>(`/api/v0/${path}`);
export const apiV1 = <T>(path: string, options?: { method: "POST" }) => apiRequest<T>(path, options);
export const getMe = cache(() => api<Me>("me"));
/** PULSE-ID: a JSON POST to /api/v0 as the signed-in person, from a server page (the authorize page). */
export const apiPost = <T>(path: string, body: unknown) => apiRequest<T>(`/api/v0/${path}`, { method: "POST", body: JSON.stringify(body) });
export type InsightWeek = Required<TrendWeek> & { finals: number; drafts: number; clients: number; videos: number; images: number; revised: number };
export type InsightPod = { pod: string; people: number; inToday: number; onLeave: number; canSignIn: number; projects: number; deliveries: number; teams: string[] | null };
export type InsightAccount = { account: string; shared: boolean; purpose: string | null; personId: string | null; person: string | null; total: number; recent: number; inPeriod: number; lastDelivery: string };
/** Company-wide counts behind the dashboard and the leadership page (admins only). "recent" always means the eight weeks up to the end of the period. */
export type Insights = { attendanceEnabled?: boolean; period: Period; generatedAt: string; weeks: InsightWeek[];
  mix: { type: string; count: number; inPeriod: number }[]; segments: { segment: string; count: number; projects: number }[];
  clients: { clientId: string | null; name: string; type: string | null; count: number; inPeriod: number; projects: number; lastDeliveredAt: string }[]; clientCount: number;
  locations: { location: string; count: number; projects: number }[];
  portfolio: { clients: number; developers: number; partners: number; untyped: number; projects: number; projectsNoClient: number; activeClients: number; activeClientsBefore: number };
  stages: { delivering: number; quiet: number; dormant: number; noDeliveries: number };
  quiet: { projectId: string; projectName: string; title: string; clientName: string | null; lastDeliveredAt: string; recent: number }[]; quietTotal: number;
  pods: InsightPod[]; teams: { team: string; people: number; inToday: number; onLeave: number; pods: string[] | null }[];
  people: { ai?: number; headcount: number; canSignIn: number; withManager: number; noPod: number; noTeam: number; inToday: number; onLeave: number; credited: number };
  attendance: { day: string; dow: number; in: number; home: number; late: number; leave: number; holiday: boolean }[] | null; hrQueue: { leave: number; corrections: number };
  accounts: InsightAccount[];
  identity: { recent: number; total: number; shared: number; sharedTotal: number; credited: number; unlinked: number; sharedLogins: number; unlinkedAccounts: number } };

/** TASKS-4A: what the company calls a team (EA: Pod). Pods are the team type; the word is a company setting. */
export async function teamWords() {
  const w = (await getMe()).data?.workLabels;
  return { team: w?.team ?? "Pod", teams: w?.teams ?? "Pods" };
}

/** UX-TASKS-2: the company's words for clients and what it sells (Clients / Client projects for an agency, Customers /
 *  Releases for a product company). Agency words when unknown. */
export async function workWords() {
  const w = (await getMe()).data?.workLabels;
  return { clients: w?.clients ?? "Clients", clientProjects: w?.clientProjects ?? "Client projects", section: w?.section ?? "Clients", model: w?.model ?? "agency" };
}
