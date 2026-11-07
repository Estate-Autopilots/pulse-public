export const OAUTH_SCOPES: string[];
export function publicOrigin(headers: Headers): string;
/** VITALS-HOSTS: the issuer, MCP address and docs that discovery names for the host asked (host-families.mjs). */
export function oauthAddresses(headers: Headers, env?: Record<string, string | undefined>): { issuer: string; mcp: string; docs: string };
export function protectedResource(origin: string, issuer?: string, docs?: string): Record<string, unknown>;
export function authorizationServer(origin: string, docs?: string): Record<string, unknown>;
export function discovery(body: unknown): Response;
export function preflight(): Response;
export function challenge(origin: string, invalid?: boolean): string;
export function forwardOAuth(request: Request, action: string, fetchImpl?: typeof fetch): Promise<Response>;
export function html(title: string, inner: string, status?: number): Response;
export type ConsentInfo = { app: { name: string; verified: boolean }; returnsTo: string; person: string; company: string; scopes: { key: string; label: string }[] };
export function consentPage(info: ConsentInfo, query: URLSearchParams): Response;
/** AGENT-API (1511): the page that approves `pulse login --device`; null info asks for the code. */
export type DeviceInfo = { app: { name: string; verified: boolean }; person: string; company: string; scopes: { key: string; label: string }[] };
export function devicePage(info: DeviceInfo | null, code: string): Response;
export function returnPage(target: string): Response;
