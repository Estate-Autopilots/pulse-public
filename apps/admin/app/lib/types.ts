// PULSE-ADMIN (1126): what the platform admin console reads (services/api/src/platform-admin.ts).
export type PlatformConfig = { product: string; company: string | null; supportEmail: string | null; domain: string | null; publicUrl: string | null; bugTriagePath: string };
export type OrgRow = {
  id: string; name: string; slug: string; code: string; handle: string | null; status: string; activation: string; rehearsal: boolean; createdAt: string;
  host: string | null; own: boolean; plan: string; planSet: boolean; seatLimit: number | null; aiTokensMonth: number | null; trialEnds: string | null;
  people: number; clients: number; canSignIn: number; active7d: number; lastActive: string | null; aiTokensThisMonth: number;
};
export type Member = { id: string; name: string; side: string; status: string; email: string | null; username: string | null; roles: string[];
  signIn: string | null; locked: boolean | null; lastLogin: string | null; lastActive: string | null };
export type AuditRow = { id?: string; at: string; actor: string; action: string; orgId?: string | null; org?: string | null; kind?: string | null; targetId?: string | null;
  label: string | null; reason: string | null; detail?: Record<string, unknown> };
export type OrgDetail = {
  id: string; name: string; slug: string; code: string; handle: string | null; status: string; activation: string; rehearsal: boolean; timeZone: string; dataRegion: string;
  createdAt: string; own: boolean; domains: { host: string; primary: boolean; signIn: string }[];
  plan: { plan: string; set: boolean; seatLimit: number | null; aiTokensMonth: number | null; trialEnds: string | null; note: string | null; updatedAt: string | null; updatedBy: string | null };
  licence: { key: string; plan: string; seats: number | null; status: string; renewsOn: string | null; hosting: string } | null;
  companyModules: Record<string, boolean>; modulesDoc: { off: string[]; on: string[] };
  counts: { people: number; clients: number; canSignIn: number; projects: number; tasks: number; chats: number; sessions7d: number };
  ai: { thisMonth: number; last30: number; connections: { name: string; provider: string; state: string; cap: number | null }[] };
  members: Member[]; orgAudit: { at: string; action: string; resource: string; actor: string | null }[]; platformAudit: AuditRow[];
};
export type PersonHit = { id: string; name: string; side: string; status: string; email: string | null; username: string | null; orgId: string; org: string; orgStatus: string;
  signIn: string | null; locked: boolean | null; lastLogin: string | null; roles: string[] };
export type PersonDetail = {
  id: string; name: string; side: string; status: string; activeFrom: string | null; org: { id: string; name: string; status: string };
  email: string | null; username: string | null; title: string | null; pod: string | null; department: string | null; manager: string | null; roles: string[];
  signIn: { status: string; mustChange: boolean; lastLogin: string | null; failed: number; lockedUntil: string | null } | null;
  sessions: { device: string | null; via: string | null; created: string; lastActive: string | null; expires: string }[];
  openTasks: number; modules: Record<string, boolean>; viewAs: boolean;
  account: { handle: string; email: string | null; locked: boolean | null; created: string; orgs: { orgId: string; org: string; kind: string; personId: string; lastUsed: string | null }[] } | null;
};
export type UsageRow = { id: string; name: string; status: string; plan: string | null; seatLimit: number | null; aiTokensMonth: number | null; people: number; activePeople: number;
  aiTokens: number; aiTokensThisMonth: number; aiRuns: number; tasksCreated: number; messages: number };
export type Health = {
  database: { bytes: number; migration: string | null; connections: number; largest: { table: string; bytes: number }[] };
  jobs: { aiRuns: number; groupJobs: number; mapJobs: number; stuck: number };
  orgs: { active: number; suspended: number; setup: number }; sessions24h: number;
  api: { release: string; environment: string | null; node: string; uptimeSeconds: number; rssBytes: number; heapBytes: number; startedAt: string };
};
export type Announcement = { id: string; title: string; body: string | null; tone: "info" | "warning" | "success"; audience: "everyone" | "admins"; link: string | null;
  startsAt: string; endsAt: string | null; endedAt: string | null; createdBy: string; createdAt: string; live: boolean };

export const PLAN_LABELS: Record<string, string> = { trial: "Trial", starter: "Starter", growth: "Growth", scale: "Scale", internal: "Internal", custom: "Custom" };
export const ACTION_LABELS: Record<string, string> = {
  "org.view": "Opened organisation", "org.plan": "Changed plan or limits", "org.suspended": "Suspended", "org.active": "Reactivated",
  "flag.on": "Switched on", "flag.off": "Switched off", "people.search": "Searched people", "person.view": "Opened person", "person.view_as": "Viewed as (read-only)",
  "person.sign_out": "Signed out everywhere", "person.unlock": "Unlocked sign-in", "person.reset": "Reset sign-in", "person.disable": "Disabled sign-in", "person.enable": "Enabled sign-in",
  "bug.view": "Opened bug report", "bug.triage": "Triaged bug report", "accounts.search": "Searched accounts", "announcement.publish": "Published announcement", "announcement.end": "Ended announcement", "admin.grant": "Named platform admin", "admin.revoke": "Removed platform admin",
};
/** Company switches (each company's Settings → Organisation) and the modules a company can switch off. */
export const COMPANY_SWITCHES = ["tasks", "chats", "finance", "attendance"] as const;
export const MODULES = ["designers", "map", "acquisition", "chats", "briefs", "money", "hr", "relationships", "skills", "jobs", "chat_import", "connectors", "creative", "sales_xray"] as const;
export const ORG_ONLY = ["pulse_hq"] as const;
export const words = (key: string) => key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export type AccountHit = { id: string; handle: string; name: string; email: string | null; confirmed: boolean; locked: boolean | null; created: string; lastOrg: string | null;
  orgs: { orgId: string; org: string; orgStatus: string; kind: string; personId: string; lastUsed: string | null }[] };
// The admin site's sections (1390).
export type Release = { env: string; sha: string; firstSeen: string; lastSeen: string; starts: number };
export type Bug = { id: string; number: number; orgId: string; org: string; words: string | null; status: string; severity: string | null; blocksWork: boolean;
  route: string | null; platform: string | null; appVersion: string | null; reporter: string | null; createdAt: string; duplicate: boolean };
export type BugDetail = Bug & { statusAt: string; signedOut: boolean; assignee: string | null; duplicateOf: number | null; taskId: string | null;
  errors: string[]; trail: string[]; files: { kind: string; bytes: number; seconds: number | null }[];
  events: { at: string; kind: string; value: string | null; note: string | null; actor: string }[] };
export type Feedback = { id: string; orgId: string; org: string; body: string | null; page: string | null; platform: string | null; appVersion: string | null; status: string | null;
  person: string | null; screenshot: boolean; createdAt: string };
export type Telemetry = { days: number; orgs: { id: string; name: string; events: number; errors: number; people: number; sessions: number; pageP75: number | null; platforms: string[] }[];
  slowest: { org: string; kind: string; name: string; events: number; errors: number; p75: number | null }[];
  failing: { org: string; kind: string; name: string; events: number; errors: number; p75: number | null }[] };
export type SpendRow = { orgId: string; org: string; source: string; engine: string; runs: number; tokensIn: number; tokensOut: number; failed: number };
export type Integrations = {
  apps: { id: string; clientId: string; name: string; maker: string | null; homeUrl: string | null; scopes: string[] | null; development: boolean; verified: boolean; status: string;
    org: string | null; createdAt: string; lastUsedAt: string | null; redirects: number }[];
  orgs: { id: string; name: string; ai: { name: string; provider: string; kind: string; state: string; cap: number | null; checkedAt: string | null }[];
    connectors: { label: string; key: string; status: string; lastBatchAt: string | null }[] }[];
};
