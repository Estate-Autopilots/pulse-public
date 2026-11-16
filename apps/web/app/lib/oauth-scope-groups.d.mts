export type ScopeGroup = { key: string; label: string; short: string; scopes: readonly string[] };
export const SCOPE_GROUPS: readonly ScopeGroup[];
export function groupsOf(scopes: readonly string[]): ScopeGroup[];
export function scopeSummary(scopes: readonly string[]): string;
export function narrowScopes(asked: readonly string[], tickedGroups: readonly string[]): string[];
