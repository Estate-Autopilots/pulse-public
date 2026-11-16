// ORG-PER-TAB (owner, 14 Nov 2026): a different company in each browser tab from one sign-in. The web sends the tab's
// company as x-pulse-org beside the browser's session (the "parent"). The front door (app.ts) asks the database for
// that company's session of the same account (2141 pulse.account_tab_session: members only, the parent must be live)
// and, when it is a child, the rest of the request runs with the child's token as x-pulse-session: an ordinary session
// of that company, so row security, roles and every route stay exactly as they were. The child's token is derived from
// the parent's here (HMAC); it is never stored and never reaches the browser.
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{40,64}$/;

/** The token of company `org`'s child session for the browser session `parent` (43 url-safe characters). */
export const tabToken = (parent: string, org: string) => createHmac('sha256', parent).update(`pulse-tab-org:${org}`).digest('base64url');

type TabState = { parent: string; org: string; child: boolean } | { refused: true; org: string };
const tabs = new WeakMap<FastifyRequest['raw'], TabState>();

/** The company a request's tab asked for, validated (a UUID), or null. */
export function tabOrgHeader(headers: FastifyRequest['headers']): string | null {
  const raw = headers['x-pulse-org'];
  return typeof raw === 'string' && ORG_ID.test(raw) ? raw : null;
}

export const markTab = (req: FastifyRequest, state: TabState) => { tabs.set(req.raw, state); };
/** The tab's company could not open (not a member, signed out of it there, or the sign-in ended). */
export const tabRefused = (req: FastifyRequest) => { const s = tabs.get(req.raw); return !!s && 'refused' in s; };
/** This request runs as a tab's child session (its x-pulse-session is the derived token). */
export const tabChild = (req: FastifyRequest) => { const s = tabs.get(req.raw); return !!s && !('refused' in s) && s.child; };
/** The browser's own session token (the parent), when this request came from a tab; else its x-pulse-session. */
export function parentToken(req: FastifyRequest): string | null {
  const s = tabs.get(req.raw);
  if (s && !('refused' in s)) return s.parent;
  const t = req.headers['x-pulse-session'];
  return typeof t === 'string' && SESSION_TOKEN.test(t) ? t : null;
}
/** The company a tab asked for (also when refused), or null. */
export const tabOrg = (req: FastifyRequest) => tabs.get(req.raw)?.org ?? null;
