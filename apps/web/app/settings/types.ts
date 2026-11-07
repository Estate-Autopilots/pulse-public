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
export type RoleKey = "admin" | "hr" | "leadership" | "finance" | "manager" | "pgs" | "head_pgs" | "sales" | "sales_head";
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
  // UX-SETTINGS-CHAT (owner, 5 Nov 2026): each person's own settings are sections too, so the Settings home links them
  // instead of stacking every card on one page.
  { key: "account", label: "Your account" },
  { key: "notifications", label: "Notifications" },
  { key: "appearance", label: "Appearance" },
  { key: "privacy", label: "Privacy" },
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
  // SERVERS-AI: the organisation's own servers (Pulse Runner) that run AI employees with its Claude / Codex sign-in. Admins only.
  { key: "servers", label: "Servers & AI" },
  // MAILBOX: the company's own Google Workspace mailbox, which sends its sign-in, invitation and HR mail.
  { key: "mail", label: "Mail" },
  // CONNECTORS-CONTRACTS: apps connected for the company's people and AI employees (remote MCP servers). Admins only.
  { key: "connectors", label: "Connectors" },
  // GROUP-ACCESS: who reads the company's client group conversations (admins; leadership through ?tab=chats).
  { key: "chats", label: "Chats" },
  // PULSE-ID: apps signed in to and linked with Pulse; registered apps for the install's own admins.
  { key: "connected-apps", label: "Connected apps" },
  { key: "connected", label: "Connected accounts" },
  // AGENT-API: personal tokens for scripts and the CLI, and bot keys for AI members (Bhrata).
  { key: "api-keys", label: "API keys" },
  { key: "desktop-app", label: "Desktop build" },
] as const;
export type TabKey = (typeof TABS)[number]["key"];
/** UI-POLISH-3 (owner, 25 Oct 2026: "every settings tab tidy and usable"): eleven tabs no longer fit one row (they ran off
 *  both ends at 1440 px), so they sit in three areas, as the HR desk's groups do (owner workbench, 21 Oct): the area row
 *  on top, the area's sections below. Old ?tab= links open their section inside its area. */
/** UX-SETTINGS-CHAT (owner, 5 Nov 2026: "ugly, confusing"): five areas, as cards on the Settings home (each with its own
 *  colour and one plain line per section); inside a section one row of chips names the area's other sections, instead
 *  of the three stacked tab rows. `hue` is the area's stripe; `text` is what each section is for. */
export const AREAS = [
  { key: "you", label: "You", short: "You", hue: 222, tabs: ["account", "notifications", "appearance", "connected-apps", "api-keys", "devices", "privacy"] },
  { key: "organisation", label: "Company", short: "Company", hue: 172, tabs: ["organisation", "industry"] },
  { key: "access", label: "People & access", short: "Access", hue: 265, tabs: ["sign-in", "work-rules", "team", "chats"] },
  { key: "connections", label: "Connections", short: "Connections", hue: 28, tabs: ["apps", "connectors", "ai", "servers", "mail", "connected"] },
  { key: "data", label: "Data & builds", short: "Data", hue: 340, tabs: ["data-health", "desktop-app"] },
] as const satisfies readonly { key: string; label: string; short: string; hue: number; tabs: readonly TabKey[] }[];
export type AreaKey = (typeof AREAS)[number]["key"];
/** One plain line per section: what it is for, as the Settings home and the section's header say it. */
export const TAB_TEXT: Record<TabKey, string> = {
  account: "Your name, username, how you sign in and your password",
  notifications: "What may ping you, and on this device",
  appearance: "Light, dark, or your device's setting",
  privacy: "What Pulse measures to get faster, and what it never records",
  devices: "Get the Pulse apps and see the devices signed in as you",
  "connected-apps": "Apps you signed in to with Pulse, and what each can see",
  "api-keys": "Tokens for your scripts and the pulse command line; admins also make bot keys",
  organisation: "Name and logo, modules, working rules and {client} types",
  industry: "Your industry, the words Pulse uses and the roles you hire",
  "sign-in": "Invitations, passwords, two-step and reset requests",
  "work-rules": "Who may create, assign, finish and review work",
  roles: "Who holds admin, HR, leadership and finance",
  team: "{Teams}, who is in each and who reports to whom",
  chats: "Who may read the company's {client} group conversations",
  apps: "Every app a process can use, connected or not",
  ai: "The AI your AI employees use, and their workspaces",
  servers: "Your own servers that run AI work with your Claude or Codex sign-in",
  mail: "The company mailbox that sends sign-in and HR e-mail",
  connectors: "Apps your people and AI employees can use: featured apps and any remote MCP server",
  connected: "Google Drive and Gmail sync, and its last runs",
  "data-health": "What Pulse could not read or match, to fix at the source",
  "desktop-app": "The desktop app's build for this install",
};
/** The area a section belongs to (a section in none: You). */
export const areaOf = (tab: TabKey) => AREAS.find((a) => (a.tabs as readonly string[]).includes(tab)) ?? AREAS[0];
