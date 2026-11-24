export const PERSONAL: readonly string[];
export const EVERYONE: readonly string[];
export const BY_ROLE: Readonly<Record<string, readonly string[]>>;
export const ADMIN_ONLY: readonly string[];
export function canOpenSection(role: string, key: string, options?: { hrSetup?: boolean }): boolean;
export function seesDeveloperApps(role: string): boolean;
