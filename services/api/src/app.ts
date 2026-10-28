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
import { googlePersonToken } from './google-person-token.js';
import { AGENT_KEY } from './agents.js';

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
      // AUTH-UNIFY (1291): on a company's own password address too, a session the person moved to another of their
      // organisations (the switch) opens that one: the session row exists only there, so its row security still holds.
      if ((!company || company.signIn === "password") && typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token)) {
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean }>("select * from pulse.session_org($1)", [sessionHash(token)])).rows[0];
        if (row && row.org_id !== (company?.org ?? await installation.readOrg())) company = { org: row.org_id, signIn: "password", status: row.status, rehearsal: row.rehearsal };
      }
      // E2E-4P: an AI employee's key runs in the organisation it belongs to (agent_key_org checks the key), so the AI
      // employees of every organisation on the shared install work, not only the install's own.
      const agentKey = request.headers["x-pulse-agent-key"];
      if (!company && typeof agentKey === "string" && AGENT_KEY.test(agentKey)) {
        const row = (await (database as Pick<Pool, "query">).query<{ org_id: string; status: string; rehearsal: boolean }>("select * from pulse.agent_key_org($1)", [agentKey])).rows[0];
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
      await database.query("SELECT 1");
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
