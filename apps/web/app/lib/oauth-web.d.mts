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
export type ConsentInfo = { app: { name: string; verified: boolean }; returnsTo: string; person: string; company: string; scopes: { key: string; label: string }[];
  /** PULSE-BUGS: the company the screen is in and the person's staff companies (each opens the screen with ?_o=). */
  orgId?: string | null; orgs?: { id: string; name: string }[] };
export function consentPage(info: ConsentInfo, query: URLSearchParams, options?: { brand?: string; note?: string }): Response;
/** AI-CONNECT: "Vitals" on vitalsos.ai addresses, "Pulse" elsewhere. */
export function brandFor(headers: Headers): string;
/** AI-CONNECT: the consent form → the API's decision body, narrowed to the groups ticked; none ticked with Allow → none. */
export function consentBody(form: FormData | URLSearchParams): { none: boolean; body: Record<string, unknown> };
/** AGENT-API (1511): the page that approves `pulse login --device`; null info asks for the code. */
export type DeviceInfo = { app: { name: string; verified: boolean }; person: string; company: string; scopes: { key: string; label: string }[] };
export function devicePage(info: DeviceInfo | null, code: string): Response;
export function returnPage(target: string): Response;
