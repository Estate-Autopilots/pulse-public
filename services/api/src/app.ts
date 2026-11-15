import type { Pool } from "pg";
import { registerRoutes, sessionHash } from "./routes.js";
import { registerIntegrationKeys } from "./integration-keys.js";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { installationFor, type Installation } from "./installation.js";
import { accessHeaderAllowed, hostDirectoryFor, normaliseHost, runWithCompany } from "./tenant-context.js";
import { OPERATOR_PREFIX, registerOperatorRoutes } from "./operator.js";
import { catalogScope, registerCatalog } from './catalog.js';
import { serviceScope, registerServiceKeys } from './service-key.js';
import { registerServiceChats } from './service-chats.js';
import { registerServiceQuotes } from './service-quotes.js';
import { registerServiceReads } from './service-reads.js';
import { isV1Call, v1Refusal, v1Scope } from './v1.js';
import type { GoogleConfiguration } from './google-sign-in-flow.js';
import { registerServiceTasksPeople, type PersonTokenVerifier } from './service-tasks-people.js';
import { registerServiceFilesVisits } from './service-files-visits.js';
import { googlePersonToken } from './google-person-token.js';
import { agentKeyFrom } from './agents.js';
import { createHash } from 'node:crypto';
import { poolCounts } from './pool-watch.js';
import { markTab, SESSION_TOKEN, tabOrgHeader, tabRefused, tabToken } from './tab-session.js';

/** AGENT-API (1510): a personal token or bot key as API v1's bearer. */
const API_TOKEN = /^Bearer ((?:ppt|pbk)_[A-Za-z0-9_-]{43})$/;

const RUNNER_MCP_BEARER = /^Bearer pmt_[A-Za-z0-9_-]{43}$/;

export interface HealthDatabase {
  query(sql: string): Promise<unknown>;
}

export function createApp(database: HealthDatabase, pool?: Pool, observeRoute?: (route: RouteOptions) => void,
                          installation: Installation = installationFor(database as Pick<Pool, "query">), google?: GoogleConfiguration, personTokenVerifier: PersonTokenVerifier = googlePersonToken): FastifyInstance {
  const app = Fastify({ logger: true, disableRequestLogging: true });
  v1Scope(app, pool);
  catalogScope(app);
  serviceScope(app);

  // UX-TENANT: the address the person opened picks the company (x-pulse-host, set by the web from its own Host); the
  // rest of the request runs inside it. Cloudflare Access identity is only read on the install's own addresses.
  const hosts = hostDirectoryFor(database as Pick<Pool, "query">);
  app.addHook("onRequest", (request, _reply, done) => {
    // /healthz answers for the process and its database alone: a database that is down is its 503, not a 500 from
    // resolving the company first.
    if (request.url === "/healthz" || request.url.startsWith("/healthz?")) { done(); return; }
    const host = normaliseHost(request.headers["x-pulse-host"]);
    hosts.lookup(host).then(async (hostCompanyRow) => {
      // ORG (0920): on the install's own addresses (the shared Pulse), a session picks its own organisation: a person
      // who switched organisation carries a session of the other one. A company's own address keeps its company.
      let company = hostCompanyRow;
      const token = request.headers["x-pulse-session"];
      let sessionOrg: string | null = null;
      // AUTH-UNIFY (1291): on a company's own password address too, a session the person moved to another of their
      // organisations (the switch) opens that one: the session row exists only there, so its row security still holds.
      if ((!company || company.signIn === "password") && typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token)) {
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean }>("select * from pulse.session_org($1)", [sessionHash(token)])).rows[0];
        sessionOrg = row?.org_id ?? null;
        if (row && row.org_id !== (company?.org ?? await installation.readOrg())) company = { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal };
      }
      // ORG-PER-TAB (tab-session.ts): the tab's company (x-pulse-org, from the web) opens with that company's session of
      // the same account, derived from this browser's session; a company the account is not in (or signed out of
      // here) is refused below with "Not found" and no data. Without a session, an Access identity opens its own
      // company only. The header never reaches a route.
      const wanted = tabOrgHeader(request.headers);
      delete request.headers["x-pulse-org"];
      // The tab is in the company the sign-in itself opens (the usual case): nothing more to ask.
      if (wanted && wanted === sessionOrg && typeof token === "string") markTab(request, { parent: token, org: wanted, child: false });
      else if (wanted && (!hostCompanyRow || hostCompanyRow.signIn === "password") && typeof token === "string" && SESSION_TOKEN.test(token)) {
        const child = tabToken(token, wanted);
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean; state: string }>("select * from pulse.account_tab_session($1,$2,$3,false)", [sessionHash(token), sessionHash(child), wanted])).rows[0];
        // 'closed': signed out of that company here; 'personal': a company's own sign-in stays in its company (2125, 2142).
        if (!row || row.state === "closed" || row.state === "personal") markTab(request, { refused: true, org: wanted });
        else {
          markTab(request, { parent: token, org: wanted, child: row.state === "open" });
          if (row.state === "open") request.headers["x-pulse-session"] = child;
          company = { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal };
        }
      } else if (wanted && typeof request.headers["cf-access-authenticated-user-email"] === "string" && wanted !== (company?.org ?? await installation.readOrg())) {
        markTab(request, { refused: true, org: wanted });
      }
      // E2E-4P: an AI employee's key runs in the organisation it belongs to (agent_key_org checks the key), so the AI
      // employees of every organisation on the shared install work, not only the install's own. TG-VOICE: the same for
      // the key as API v1's bearer (its Pulse tools); before, another company's AI employee got 401 on every tool.
      const agentKey = agentKeyFrom(request.headers);
      if (!company && agentKey) {
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean }>("select * from pulse.agent_key_org($1)", [agentKey])).rows[0];
        if (row && row.org_id !== await installation.readOrg()) company = { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal };
      }
      // SERVERS-AI (1560): a Pulse Runner job's MCP token (pmt_) runs in the organisation of its job, like an AI key.
      const bearer = request.headers.authorization;
      if (!company && typeof bearer === "string" && RUNNER_MCP_BEARER.test(bearer)) {
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean }>("select * from pulse.runner_mcp_token_org($1)", [sessionHash(bearer.slice(7))])).rows[0];
        if (row && row.org_id !== await installation.readOrg()) company = { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal };
      }
      // AGENT-API (1510): a personal token or bot key likewise runs in the organisation it was made in.
      const apiToken = API_TOKEN.exec(String(request.headers.authorization ?? ''))?.[1];
      if (!company && apiToken) {
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean }>("select * from pulse.v1_token_org($1)", [createHash('sha256').update(apiToken).digest('hex')])).rows[0];
        if (row && row.org_id !== await installation.readOrg()) company = { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal };
      }
      const installOrg = company ? await installation.readOrg() : null;
      if (!accessHeaderAllowed(company, process.env.PULSE_PUBLIC_LOGIN_ENABLED === '1')) {
        for (const key of Object.keys(request.headers)) if (key.startsWith('cf-access-') || key.startsWith('x-dev-')) delete request.headers[key];
      }
      runWithCompany({ host, raw: typeof request.headers["x-pulse-host"] === "string" ? request.headers["x-pulse-host"] : undefined, company, installOrg,
        hostOrg: hostCompanyRow?.org ?? await installation.readOrg() }, done);
    }).catch((error: Error) => done(error));
  });
  app.addHook("onRequest", async (request, reply) => {
    const v1 = isV1Call(request);
    // The operator API is how an install gets its company, so it answers before (and without) one.
    if ((v1 || /^\/api\/v[01](?:\/|$)/.test(request.url)) && !request.url.startsWith(OPERATOR_PREFIX) && !await installation.readOrg()) {
      return v1Refusal(request, reply, 503, "not_initialised");
    }
    // ORG-PER-TAB: a tab's company that does not open for this sign-in answers like a record that does not exist.
    // Signing out (and the signed-out pages) still answers, so a tab is never stuck.
    if (tabRefused(request) && !/^\/api\/v0\/(auth|brand|host)(\/|\?|$)/.test(request.url)) {
      return reply.code(404).header("cache-control", "private, no-store").header("x-pulse-tab", "closed").send({ error: "Not found", code: "tab_org_unavailable" });
    }
    const company = await hosts.lookup(normaliseHost(request.headers["x-pulse-host"]));
    // A company being set up shows its name and logo on the sign-in page, and nothing else yet.
    if (company && company.status !== "active" && (v1 || /^\/api\/(v[01]|native)(?:\/|$)/.test(request.url)) && !/^\/api\/v0\/(brand|host)(?:\/|\?|$)/.test(request.url)) {
      return v1Refusal(request, reply, company.status === "setup" ? 503 : 403, company.status === "setup" ? "This company is being set up in Pulse. Its admin will tell you when to sign in." : "This company's Pulse is not available.");
    }
  });
  if(observeRoute)app.addHook("onRoute",observeRoute);
  app.addHook("onSend",async(req,reply,payload)=>{if(req.url.startsWith("/api/"))reply.header("cache-control","private, no-store");return payload;});
  app.get("/healthz", async (_request, reply) => {
    try {
      // LAND-CAPTAIN-10: SELECT 1 has PULSE_HEALTH_DB_MS (3 s) to answer, inside the web's 4 s. When it waits longer
      // (every client held: production's 43 h hang), health says so with the pool's counts instead of not answering.
      const budget = Number(process.env.PULSE_HEALTH_DB_MS) > 0 ? Number(process.env.PULSE_HEALTH_DB_MS) : 3000;
      const probe = database.query("SELECT 1");
      let timer: NodeJS.Timeout | undefined;
      const waited = await Promise.race([probe.then(() => false),
        new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), budget); })]).finally(() => clearTimeout(timer));
      if (waited) {
        probe.catch(() => {});
        const pool = poolCounts(database);
        app.log.error({ pool, waitedMs: budget }, "PostgreSQL health check is waiting for a database client");
        return reply.code(503).send({ status: "unavailable", part: "pool", ...(pool ?? {}) });
      }
      const setup = await installation.readOrg() ? "ready" : "pending";
      return reply.code(200).send({ status: "ok", setup });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
      app.log.error({ code }, "PostgreSQL health check failed");
      return reply.code(503).send({ status: "unavailable", part: "database" });
    }
  });

  if (pool) {
    registerServiceKeys(app, pool, installation);
    registerIntegrationKeys(app, registerRoutes(app, pool, installation, google), installation);
    registerOperatorRoutes(app, pool, installation);
    registerCatalog(app, pool, installation);
    registerServiceQuotes(app);
    registerServiceChats(app);
    registerServiceReads(app, pool, installation);
    registerServiceTasksPeople(app, personTokenVerifier);
    registerServiceFilesVisits(app);
  }
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string; code?: string; where?: string; expose?: boolean; reason?: string; publicCode?: string };
    const status = err.statusCode ?? (err.code === '42501' ? 403 : err.code === '22023' || err.code === '22P02' || err.code === '22007' || err.code === '23514' ? 400 : err.code === 'P0002' ? 404 : err.code === '23505' || err.code === '23503' || err.code === '40001' || err.code === '54000' ? 409 : 500);
    // A message Pulse's own database functions raise on purpose (RAISE in PL/pgSQL) is written for people; pass it on.
    if (status < 500 && err.code && /PL\/pgSQL function /.test(err.where ?? '') && err.message && /\s/.test(err.message) && !/[{}()"]/.test(err.message)) { reply.code(status).send({ error: err.message }); return; }
    // A refusal written for people (e.g. "the document key isn't installed on this server") keeps its sentence.
    if (status >= 500 && err.expose === true && err.message) { app.log.warn({ status, reason: err.reason ?? null }, "Request refused"); reply.code(status).send({ error: err.message }); return; }
    if (status >= 500) app.log.error({ code: err.code ?? "unknown" }, "Request failed");
    reply.code(status).send({ error: status < 500 ? (err.code ? ({'42501':'Access denied for this account','22023':'Please check the selected record and entered values','22P02':'Please check the entered values','23505':'This record already exists','23503':'The linked record is unavailable','40001':'This document changed. Refresh before saving your revision.'}[err.code] ?? 'Please check your request') : err.message) : "Pulse data is temporarily unavailable", ...(status < 500 && err.publicCode ? { code: err.publicCode } : {}) });
  });
  return app;
}
