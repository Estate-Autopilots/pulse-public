export const ORG_ID: RegExp;
export type TabOrg = { org: string | null; from: "header" | "none" | "address" | "nav" | "view" | null; doc: boolean; nav: boolean };
export function tabOrgFor(headers: Headers, search: URLSearchParams, cookies: { get(name: string): { value: string } | undefined }): TabOrg;
export function tabCookies(tab: TabOrg, page: boolean): string[];
export function renderedOrg(orgs: { id: string; current?: boolean }[] | null | undefined): string | null;
export const TAB_SHIM: string;
