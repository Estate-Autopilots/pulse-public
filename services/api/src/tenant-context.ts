import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { Pool } from "pg";
import { hostFamilies, hostFamily, hostOrigin } from "./host-families.js";
import { publicOrigin } from "./tenant-model.js";

/**
 * UX-TENANT (ADR-0032): which company a request belongs to. The web forwards the address the person opened as
 * `x-pulse-host`; `pulse.host_org()` maps it to a company and says how people sign in there. An address no company
 * claims belongs to the install's own company, with today's behaviour (Cloudflare Access on EA's addresses).
 *
 * The answer rides with the request through AsyncLocalStorage, so every transaction the request opens (`tx`, and the
 * signed-out `open` used by sign-in, sign-in links, the logo and device pairing) runs inside that company.
 */
export type HostCompany = { org: string; signIn: "password" | "access"; status: string; rehearsal: boolean };
/** hostOrg (ORG): the organisation the address itself belongs to, before a session from another organisation of the
 *  same Pulse account picked the request's company. */
export type RequestCompany = { host: string | null; raw?: string; company: HostCompany | null; installOrg?: string | null; hostOrg?: string | null;
  /** FIX-SHELL: the @handle of the company this request works in, once a transaction has read it (noteLinkHandle). */ linkHandle?: string | null };

const store = new AsyncLocalStorage<RequestCompany>();
export const requestCompany = () => store.getStore();
export const runWithCompany = (value: RequestCompany, next: () => void) => store.run(value, next);
/** WL-CALLS-STREAM (17 Nov 2026): a live stream's wake-up, run in the company of the request that subscribed. A hub's
 *  NOTIFY handler runs in whatever context its one LISTEN connection was opened in (the first request that ever
 *  subscribed), so a stream woken by it opened its transaction in that company, not its own: its own session was not
 *  found ("Your session has ended"), the stream ended, and a call's offer and candidates never reached the other side. */
export const keepRequest = <A extends unknown[]>(f: (...a: A) => void): ((...a: A) => void) => AsyncResource.bind(f);

/** A company as pulse.session_org, native_credential_org and the like name it. */
export type CompanyRow = { org_id: string; status: string; rehearsal: boolean };
/** FIX-LIVE-2 (BC-137): runs `next` in the company that a phone app's own credential or pairing request belongs to.
 *  The app calls the shared address without a company of its own, so its requests used to run in the install's
 *  company. A company's own address keeps its company. An unknown credential runs where it did before, and fails
 *  there as before. */
export function inOwnCompany<T>(row: CompanyRow | undefined, next: () => Promise<T>): Promise<T> {
  const r = requestCompany();
  if (!row || !r || r.company || row.org_id === r.hostOrg) return next();
  return store.run({ ...r, installOrg: r.installOrg ?? r.hostOrg, company: { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal } }, next);
}

/** A host name only: lower case, no port, no trailing dot; anything that is not a plain host name is ignored. */
export function normaliseHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) && host.length <= 253 ? host : null;
}

/** Host → company, kept for 30 seconds per API process (setup writes clear it). */
export class HostDirectory {
  private cache = new Map<string, { at: number; value: HostCompany | null }>();
  constructor(private readonly database: Pick<Pool, "query">, private readonly ttlMs = 30_000) {}

  async lookup(host: string | null): Promise<HostCompany | null> {
    if (!host) return null;
    const hit = this.cache.get(host);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const row = (await this.database.query<{ org_id: string; sign_in: "password" | "access"; status: string; rehearsal: boolean }>(
      "select * from pulse.host_org($1)", [host])).rows[0];
    const value = row ? { org: row.org_id, signIn: row.sign_in, status: row.status, rehearsal: row.rehearsal } : null;
    this.cache.set(host, { at: Date.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  clear() { this.cache.clear(); }
}

const directories = new WeakMap<object, HostDirectory>();
export function hostDirectoryFor(database: Pick<Pool, "query">): HostDirectory {
  let directory = directories.get(database as object);
  if (!directory) { directory = new HostDirectory(database); directories.set(database as object, directory); }
  return directory;
}

/** Whether the Cloudflare Access identity header may be read on this request: only on the install's own addresses
 *  (unclaimed hosts, or a host claimed with sign-in "access"), and never in public sign-in mode. */
export function accessHeaderAllowed(company: HostCompany | null | undefined, publicLogin: boolean): boolean {
  return !publicLogin && (!company || company.signIn === "access");
}

/** The company of the current request, if its address names one; else null (the install's own company). */
export const hostCompany = () => requestCompany()?.company ?? null;

/** Where links in this request's e-mails and answers point: the company's own address, else the install's.
 *  VITALS-HOSTS: on a platform family's host, the family's sign-in origin (that host on app and id, else the family's
 *  app host), so a Google callback, a passkey and a link stay where the person signed in. */
/** An address of this machine itself (an IP or localhost): nobody opens a link to it. */
const MACHINE = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i;

export function companyOrigin(): string {
  const r = requestCompany();
  const family = hostFamily(r?.raw ?? r?.host);
  if (family?.listed) return family.signIn;
  // AGENT-LINK (7 Nov 2026): an AI employee's runtime calls this server on 127.0.0.1, so the request has no address a
  // person can open. Willow Lane's quotation agent posted https://127.0.0.1/erp/documents/... in its chat and on Telegram.
  // Links then point at the shared family's app address (another company on the shared install, e.g. app.vitalsos.ai),
  // else the install's own address.
  if (r?.host && MACHINE.test(r.host)) {
    const shared = hostFamilies().find((f) => f.listed)?.app;
    return r.company && shared ? hostOrigin(shared) : publicOrigin(null, process.env.PULSE_PUBLIC_URL, r.raw);
  }
  return publicOrigin(r?.company ? r.host : null, process.env.PULSE_PUBLIC_URL, r?.raw);
}

/** FIX-SHELL (owner walkthrough, 10 Nov 2026: "links inside the app and the AI's answers say pulse.estateautopilots.com;
 *  they must use app.vitalsos.ai, with company paths such as app.vitalsos.ai/@estateautopilots/…"). Where a link that
 *  someone opens later points (an AI employee's answer, an API answer's `url`, a task's proof link): the platform's
 *  shared app address (the first listed family's app host) whenever the request has no address of a company's own (the
 *  install's old address, this machine, as an AI employee's runtime calls it, or none), followed by the company's
 *  @handle once the request's transaction has read it (noteLinkHandle), so the link opens in that company whichever
 *  one the person is in (apps/web proxy.ts, app/at). A company's own address and a family host keep their own app
 *  host, without a handle. Sign-in, callbacks, passkeys and set-password links keep companyOrigin(): they must stay
 *  on the host the person signs in on. Without a listed family (a self-hosted install) this is companyOrigin(). */
export function linkOrigin(): string {
  const r = requestCompany();
  const handle = r?.linkHandle && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.linkHandle) ? `/@${r.linkHandle}` : "";
  const family = hostFamily(r?.raw ?? r?.host);
  if (family?.listed) return `${family.app}${handle}`;
  const shared = hostFamilies().find((f) => f.listed)?.app;
  const own = !!r?.company && !!r.host && !MACHINE.test(r.host) && family?.name !== "install";
  if (!shared || own) return companyOrigin();
  return `${hostOrigin(shared)}${handle}`;
}
/** FIX-SHELL: the request's company @handle, for linkOrigin(); read in the same query that reads the company. */
export function noteLinkHandle(handle: unknown) {
  const r = requestCompany();
  if (r && typeof handle === "string") r.linkHandle = handle.toLowerCase();
}
/** The SQL that reads the current company's @handle (for noteLinkHandle). */
export const LINK_HANDLE_SQL = "(select o.handle from pulse.org o where o.id = pulse.current_org())";

/** WL-BHARATA-E2E: the address a signed-out link of this company works on (an acceptance link): the company's primary
 *  address when it has one (pulse.org_public_host(), read inside the company's transaction), else companyOrigin(). */
export function companyLinkOrigin(primaryHost: string | null | undefined): string {
  const r = requestCompany();
  return primaryHost ? publicOrigin(primaryHost, process.env.PULSE_PUBLIC_URL, r?.raw) : companyOrigin();
}

/** The OAuth issuer for this request (`iss`, RFC 9207): the family's one issuer (id.vitalsos.ai when configured), else
 *  companyOrigin() as before. It must equal the issuer the web's discovery names (apps/web/app/lib/oauth-web.mjs). */
export function oauthIssuer(): string {
  const r = requestCompany();
  const family = hostFamily(r?.raw ?? r?.host);
  return family?.listed ? family.issuer : companyOrigin();
}
