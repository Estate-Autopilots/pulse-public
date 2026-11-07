// UX-TENANT: what /api/v0/tenants answers (services/api/src/tenants.ts, pulse.tenant_state in 0260; R53: the plan,
// the gates and the guide from pulse.tenant_plan / tenant_gates in 0480).
export type Modules = { tasks: boolean; chats: boolean; finance: boolean; attendance: boolean };
export type CompanyRow = { setupId: string | null; own: boolean; name: string; code?: string; status: string; activation?: "trial" | "live"; rehearsal?: boolean; host?: string | null; people?: number; signedIn?: number; modules?: Modules; createdAt?: string };
export type Person = { id: string; name: string; email: string | null; title: string; pod: string | null; team: string | null; managerId: string | null; username: string; roles: string[] };
export type ChecklistItem = { key: string; label: string; state: "done" | "todo" | "blocked" | "owner" | "info"; detail: string; blocking?: boolean };
export type Setup = {
  id: string; name: string; status: "draft" | "setup" | "open" | "live"; steps: Record<string, { at: string } & Record<string, unknown>>; createdAt: string;
  org: null | { id: string; name: string; slug: string; code: string; timeZone: string; dataRegion: string; status: string; rehearsal: boolean; host: string | null; signIn: string };
  brand?: { version: number; mark: boolean; logo: boolean; logoDark: boolean; logoPng: boolean; accent: string | null };
  admin?: null | { personId: string; name: string; email: string; username: string; title: string; invitation: string | null; linkReady: boolean; sentAt: string | null; expiresAt: string | null; signedIn: boolean };
  counts?: { people: number; withEmail: number; pods: number; teams: number; admins: number; signedIn: number; projects: number; tasks: number };
  modules?: Modules; rules?: { role: string; action: string; scope: string }[]; twoStep?: { required: boolean; graceUntil: string | null } | null;
  pods?: string[]; people?: Person[] | null;
  suggestions: { slug: string; code: string }; accent: null | { ok: boolean; light: number; dark: number; note: string | null };
  mail: { from: string | null; sendEnabled: boolean; reason: string | null }; workspace: { connected: boolean; reason: string };
  invitation: null | { subject: string; guide: string }; checklist: { items: ChecklistItem[]; canOpen: boolean; blocked: string[] };
  activation: null | Activation;
};
export type CompanyCheck = { ok: boolean; problems: string[]; warnings: string[]; creates: string[] };
export type PlanAction = { area: string; key: string; item: string; table: string | null; action: "create" | "update" | "keep" | "none"; before: string | null; after: string | null;
  source?: { key: string; kind: string; label: string; connector: string | null; categories: string[]; grants: string }; needsApproval?: string[] };
export type Plan = { ok: boolean; problems: string[]; warnings: string[]; applied: boolean; orgId: string; new: boolean; actions: PlanAction[];
  summary: { create: number; update: number; keep: number } };
export type Gate = { key: string; ok: boolean; label: string; detail: string };
export type GuideStep = { key: string; title: string; who: string; how: "automatic" | "manual"; state: "done" | "todo" | "blocked" | "waiting" | "later";
  detail: string; gate: boolean; errands: string[]; href: string | null };
export type RegistrySource = { id: string; key: string; kind: string; label: string; connector: string | null; categories: string[]; sensitive: string[]; grants: string;
  decision: "planned" | "approved" | "declined"; decidedAt: string | null; note: string | null; ready: boolean; why: string;
  install: null | { id: string; status: string; keyInstalled: boolean; missingEntities: string[]; approvedRoots: number; health?: { lost: number; lagSeconds: number | null } } };
/** R54 (0490): what the trial's pilot tried, latest per platform, and the feedback totals (shown from five answers). */
export type Evidence = "mock" | "simulator" | "installed_device" | "real_data_read_only";
export type Pilot = {
  devices: { platform: string; evidence: Evidence; result: "passed" | "failed"; on: string }[]; platforms: number; passed: number; installed: number; devicesOk: boolean;
  walkthrough: null | { evidence: Evidence; result: "passed" | "failed"; on: string }; walkthroughOk: boolean;
  feedback: { answers: number; minimum: number; shownAnswers: number | null; shownOn: string | null; questions: { key: string; label: string; average: number | null; agree: number | null }[] };
};
/** R54: the explicit readiness result (services/api/src/tenant-model.ts readiness). A rehearsal is never a launch. */
export type Readiness = { verdict: "live" | "ready" | "not_ready"; rehearsal: boolean; title: string; summary: string;
  open: { key: string; label: string; detail: string; errands: string[] }[]; errands: string[]; evidence: string[] };
export type PilotCheck = { id: string; kind: "device" | "walkthrough"; platform: string | null; evidence: Evidence; result: "passed" | "failed"; covers: string[]; note: string | null; by: string | null; at: string };
/** pulse.setup_gates() (0480) with the guide written from it (services/api/src/tenant-model.ts setupGuide). */
export type Checklist = {
  company: { name: string; status: string; activation: "trial" | "live"; rehearsal: boolean; host: string | null; prefix: string | null };
  facts: Record<string, number | boolean>; sources: RegistrySource[]; gates: Gate[]; ready: boolean; blocked: string[]; guide: GuideStep[];
  pilot?: Pilot; readiness?: Readiness;
  handover: { operatorNamed: boolean; supportRoute: string | null; restore: null | { on: string; minutes: number; result: string; isolated: boolean; ref: string };
    termsRef: string | null; rolloutRef: string | null; isolationAt: string | null; activatedAt: string | null };
};
export type Activation = Checklist & { operator: string | null; operators: { id: string; name: string }[] };
export type CompanySetup = { managed: false } | (Checklist & { managed: true; canEdit: boolean; canSignOff?: boolean; duplicateNames: string[]; sharedEmails: string[]; pilotChecks?: PilotCheck[] });
export type PeoplePreview = { applied: boolean; new: number; update: number; skip: number; newPods: string[]; newTeams: string[]; unresolvedManagers: number; rolesGranted: number; total: number;
  rows: { row: number; name: string; email: string | null; title: string | null; pod: string | null; team: string | null; access: string | null; manager: string | null; status: "new" | "update" | "skip"; problems: string[] }[];
  columns: Record<string, string>; setup?: Setup };
