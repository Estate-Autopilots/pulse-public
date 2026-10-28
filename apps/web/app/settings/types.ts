import { lower } from "../lib/words.mjs";
/** Shapes returned by GET /api/v0/admin/access and GET /api/v0/settings. */
export type AccessPerson = { id: string; name: string; userNo: number | null; username: string | null; role: string; pod: string | null; accounts: string[]; photoAt: string | null;
  authStatus?:string;delivery?:string;twoStep?:boolean;loginStatus: string | null; mustChange: boolean | null; issuedAt: string | null; lastLoginAt: string | null; locked: boolean | null };
export type ResetRequest = { id: string; username: string; personId: string | null; name: string | null; status: string; requestedAt: string; resolvedAt: string | null; resolvedBy: string | null };
export type AccessData = { people: AccessPerson[]; requests: ResetRequest[] };

export type Member = { id: string; name: string; role: string; photoAt: string | null; managerId: string | null; userNo: number | null };
/** A current member of staff, as the pickers and the reporting tree need them. */
export type StaffPerson = Member & { pod: string | null };
export type Pod = { id: string; name: string; kind: string; projects: number; members: Member[] };
export type RoleKey = "admin" | "hr" | "leadership" | "finance" | "manager" | "pgs" | "head_pgs";
export type PermissionKey = "hr.salary.read" | "hr.salary.write" | "hr.contact.read" | "hr.contact.write" | "hr.documents.read";
/** One restricted HR permission held by one person. `effective` is false when the person no longer has the admin or HR role. */
export type PermissionGrant = { personId: string; name: string; permission: PermissionKey; grantedBy: string; grantedAt: string; effective: boolean };
export type RoleHolder = { personId: string; name: string; role: RoleKey; since: string; accounts: string[] };
/** Salary by named list (1048). Off: HR and leadership see salaries by their role. byRoleOnly: who holds salary by the
 *  HR or leadership role without the named grants, and what they lose while it is on (all salary access, or editing). */
export type SalaryList = { on: boolean; changedAt: string | null; changedBy: string | null; byRoleOnly: { personId: string; name: string; loses: "salary" | "edit" }[] };
export type Source = { key: string; label: string; detail: string; state: "connected" | "planned" | "manual" | "attention"; lastAt: string | null };
export type SyncRun = { id: string; source: string; startedAt: string; finishedAt: string | null; ok: boolean | null; error: string | null; upstreamAt: string | null };
export type SyncStatus = { lastIndexedAt: string | null; upstreamAt: string | null; everyMinutes: number; lastRun: { ok: boolean | null; error: string | null; startedAt: string; finishedAt: string | null } | null };
export type SettingsData = {
  canEdit: boolean;
  org: { name: string; slug: string; code: string };
  pods: Pod[];
  unassigned: Member[];
  roles: RoleHolder[];
  people: StaffPerson[];
  permissions: PermissionGrant[];
  canGrant: boolean;
  salaryList?: SalaryList;
  sources: Source[];
  sync: SyncStatus;
  runs: SyncRun[];
};

export const TABS = [
  { key: "devices", label: "Devices" },
  { key: "data-health", label: "Data health" },
  { key: "sign-in", label: "Who can sign in" },
  { key: "work-rules", label: "Who can do what" },
  { key: "team", label: `Team & pods` },
  { key: "roles", label: "Roles & permissions" },
  { key: "organisation", label: "Organisation" },
  { key: "industry", label: "Industry & roles" },
  { key: "apps", label: "Apps" },
  // CONNECT-AI: the AI the organisation's AI employees use, and their workspaces.
  { key: "ai", label: "AI" },
  // MAILBOX: the company's own Google Workspace mailbox, which sends its sign-in, invitation and HR mail.
  { key: "mail", label: "Mail" },
  // GROUP-ACCESS: who reads the company's client group conversations (admins; leadership through ?tab=chats).
  { key: "chats", label: "Chats" },
  // PULSE-ID: apps signed in to and linked with Pulse; registered apps for the install's own admins.
  { key: "connected-apps", label: "Connected apps" },
  { key: "connected", label: "Connected accounts" },
  { key: "desktop-app", label: "Desktop build" },
] as const;
export type TabKey = (typeof TABS)[number]["key"];
/** UI-POLISH-3 (owner, 25 Oct 2026: "every settings tab tidy and usable"): eleven tabs no longer fit one row (they ran off
 *  both ends at 1440 px), so they sit in three areas, as the HR desk's groups do (owner workbench, 21 Oct): the area row
 *  on top, the area's sections below. Old ?tab= links open their section inside its area. */
export const AREAS = [
  { key: "organisation", label: "Organisation", short: "Organisation", tabs: ["organisation", "industry", "apps", "ai", "mail"] },
  { key: "access", label: "People & access", short: "Access", tabs: ["sign-in", "work-rules", "team", "chats"] },
  { key: "data", label: "Data & devices", short: "Data", tabs: ["connected", "data-health", "desktop-app", "devices"] },
] as const satisfies readonly { key: string; label: string; short: string; tabs: readonly TabKey[] }[];
