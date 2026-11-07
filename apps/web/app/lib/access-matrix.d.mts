export type RoleKey = "admin" | "hr" | "leadership" | "finance" | "manager" | "pgs" | "head_pgs" | "sales" | "sales_head";
export type PermissionKey = "hr.salary.read" | "hr.salary.write" | "hr.contact.read" | "hr.contact.write" | "hr.documents.read";
export type Template = { key: RoleKey; title: string; short: string; one: string; hue: number; pod?: boolean; sees: string };
export type Named = { key: PermissionKey; label: string; what: string };
export type Level = "yes" | "part" | "grant" | "no";
export type Capability = { key: string; group: string; label: string; short: string; cells: Record<string, string>; note?: string };
export type CapabilityValue = { level: Level; text: string; from: RoleKey | null };
export type GrantLike = { personId?: string; permission: string; effective?: boolean; grantedBy?: string; grantedAt?: string };
export type NamedValue = { level: "yes" | "idle" | "no"; text: string; grant: GrantLike | null; byRole: boolean };
export type Profile = { roles: RoleKey[]; caps: (Capability & CapabilityValue)[]; perms: (Named & NamedValue)[]; can: number; idle: (Named & NamedValue)[] };
export type Change = { personId: string; name: string; role: RoleKey; action: "grant" | "revoke" };

export const TEMPLATES: Template[];
export const TEMPLATE: Record<RoleKey, Template>;
export const NAMED: Named[];
export const CAPABILITIES: Capability[];
export const EVERYONE: string[];
export function capability(cap: Capability, roles: RoleKey[]): CapabilityValue;
export function named(key: PermissionKey, roles: RoleKey[], grants: GrantLike[], salaryListOn: boolean): NamedValue;
export function workRole(roles: RoleKey[], leadsSomeone: boolean): "leadership" | "hr" | "pod_head" | "member";
export function profile(person: { id: string }, holders: { personId: string; role: RoleKey }[], grants: (GrantLike & { personId: string })[], salaryListOn: boolean): Profile;
export function planBulk<P extends { id: string; name: string; pod: string | null }>(people: P[], holders: { personId: string; role: RoleKey }[], action: "grant" | "revoke", role: RoleKey, viewer: string | null): { plan: Change[]; skipped: { person: P; why: string }[] };
export type AccessWords = { TEMPLATES: Template[]; TEMPLATE: Record<RoleKey, Template>; CAPABILITIES: Capability[]; teamWord: string;
  profile: (person: { id: string }, holders: { personId: string; role: RoleKey }[], grants: (GrantLike & { personId: string })[], salaryListOn: boolean) => Profile;
  planBulk: <P extends { id: string; name: string; pod: string | null }>(people: P[], holders: { personId: string; role: RoleKey }[], action: "grant" | "revoke", role: RoleKey, viewer: string | null) => { plan: Change[]; skipped: { person: P; why: string }[] } };
/** The templates and capabilities in a company's words (useWords()). */
export function accessWords(words: Record<string, string> | null | undefined): AccessWords;
