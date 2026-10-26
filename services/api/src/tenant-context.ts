import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
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
export type RequestCompany = { host: string | null; raw?: string; company: HostCompany | null; installOrg?: string | null; hostOrg?: string | null };

const store = new AsyncLocalStorage<RequestCompany>();
export const requestCompany = () => store.getStore();
export const runWithCompany = (value: RequestCompany, next: () => void) => store.run(value, next);

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

/** Where links in this request's e-mails and answers point: the company's own address, else the install's. */
export function companyOrigin(): string {
  const r = requestCompany();
  return publicOrigin(r?.company ? r.host : null, process.env.PULSE_PUBLIC_URL, r?.raw);
}
