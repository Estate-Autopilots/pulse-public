export type HostMode = { signIn: "password" | "access"; name: string | null; own: boolean; status: string; rehearsal: boolean };
type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined> | null | undefined;
export function requestHost(headers: HeaderSource): string | null;
export function hostMode(host: string | null, fetchImpl?: typeof fetch): Promise<HostMode>;
export function passwordHost(host: string | null, fetchImpl?: typeof fetch): Promise<boolean>;
export function hostHeader(headers: HeaderSource): Record<string, string>;
export function hasV1CredentialConflict(headers: Headers): boolean;
export function inboundHeaders(source: HeadersInit, path: string, password: boolean, method?: string): Headers;
