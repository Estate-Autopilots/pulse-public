import { createHash, timingSafeEqual } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { Installation } from "./installation.js";
import { registerCatalogOperator } from './catalog.js';
import { registerServiceKeyOperator } from './service-key.js';
import { registerAgentOperator } from './agent-operator.js';

/**
 * The operator API (ADR-0031 §2): first run and break-glass setup for the person who runs the install, from the
 * server itself (`pulse-admin`, http://127.0.0.1:8081). The routes exist only when PULSE_OPERATOR_TOKEN is set and
 * accept only `Authorization: Bearer <token>`. The web proxies never forward them, and a request that carries the
 * web tier's headers is refused here as well. Every call is written to the audit log as actor `operator`.
 */
export const OPERATOR_PREFIX = "/api/v1/operator/";
const ACTOR = "operator";
const MIN_TOKEN = 32;

const text = (minLength: number, maxLength: number, pattern?: string) =>
  ({ type: "string", minLength, maxLength, ...(pattern ? { pattern } : {}) });
const initBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "slug", "code", "timeZone", "adminEmail", "adminName"],
  properties: {
    name: text(2, 80),
    slug: text(2, 40, "^[a-z0-9][a-z0-9-]{1,39}$"),
    code: text(2, 4, "^[A-Z]{2,4}$"),
    timeZone: text(1, 64),
    adminEmail: text(3, 120),
    adminName: text(2, 120),
  },
};
const orgBody = { type: "object", additionalProperties: false, required: ["name"], properties: { name: text(2, 80) } };
// Roles come only from the database (ADR-0031 §3); these are the four the operator may grant or revoke.
export const OPERATOR_ROLES = ["admin", "hr", "leadership", "privacy"] as const;
const roleBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "role", "action"],
  properties: { email: text(3, 120), role: { type: "string", enum: OPERATOR_ROLES }, action: { type: "string", enum: ["grant", "revoke"] } },
};

// PULSE-ADMIN (1140): who uses the platform admin console: named here, from the server, by e-mail in the install's company.
const platformAdminBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "action"],
  properties: { email: text(3, 120), action: { type: "string", enum: ["grant", "revoke"] } },
};

type InitBody = { name: string; slug: string; code: string; timeZone: string; adminEmail: string; adminName: string };
type RoleBody = { email: string; role: (typeof OPERATOR_ROLES)[number]; action: "grant" | "revoke" };

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Compares the bearer value with the token in constant time (both sides are hashed to the same length first). */
export function operatorAuthorized(header: unknown, token: string): boolean {
  const match = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
  return timingSafeEqual(digest(match?.[1] ?? ""), digest(token)) && !!match;
}

export function registerOperatorRoutes(app: FastifyInstance, pool: Pool, installation: Installation,
                                       token: string | undefined = process.env.PULSE_OPERATOR_TOKEN): void {
  if (!token) return;
  if (token.length < MIN_TOKEN) {
    app.log.warn(`PULSE_OPERATOR_TOKEN is shorter than ${MIN_TOKEN} characters; the operator API stays off`);
    return;
  }
  const run = async <T>(work: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const result = await work(c);
      await c.query("commit");
      return result;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const audit = async (c: PoolClient, org: string, action: string) => {
    await c.query("select set_config('pulse.org_id',$1,true), set_config('pulse.actor_account',$2,true)", [org, ACTOR]);
    await c.query("select pulse.audit_write($1,'install',$2)", [action, org]);
  };

  void app.register(async scope => {
    // Unknown or mistyped fields are refused (400), not stripped or coerced as Fastify's default validator does.
    const ajv = new Ajv2020({ allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
    scope.setValidatorCompiler(({ schema }) => ajv.compile(schema));
    scope.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      // Anything relayed by the web tier is not the operator, whatever it carries.
      if (request.headers["x-pulse-device-agent"] !== undefined || request.headers["x-pulse-client-ip"] !== undefined) {
        return reply.code(404).send({ error: "Not found" });
      }
      if (!operatorAuthorized(request.headers.authorization, token)) {
        request.log.warn({ actor: ACTOR, url: request.url.split("?")[0] }, "Operator call refused");
        return reply.code(401).send({ error: "Operator token required" });
      }
    });
    scope.addHook("onResponse", async (request, reply) => {
      request.log.info({ actor: ACTOR, method: request.method, url: request.url.split("?")[0], status: reply.statusCode },
        "Operator call");
    });

    scope.get(OPERATOR_PREFIX + "status", () => run(async c => {
      const org = await installation.readOrg();
      const version = process.env.PULSE_RELEASE ?? "dev";
      if (!org) return { initialised: false, org: null, version };
      await audit(c, org, "operator_status");
      const row = (await c.query(`select name,slug,code,time_zone from pulse.org where id=$1`, [org])).rows[0];
      return { initialised: true, org: row ?? null, version };
    }));
    registerCatalogOperator(scope, run);
    registerServiceKeyOperator(scope, run);
    registerAgentOperator(scope, run);

    scope.post<{ Body: InitBody }>(OPERATOR_PREFIX + "init", { schema: { body: initBody } }, async (request, reply) => {
      const b = request.body;
      const row = await run(async c => (await c.query(
        `select org_id "orgId",person_id "personId",username,temporary_password "temporaryPassword"
           from pulse.install_init($1,$2,$3,$4,$5,$6,$7)`,
        [b.name, b.slug, b.code, b.timeZone, b.adminEmail, b.adminName, ACTOR])).rows[0]);
      return reply.code(201).send(row);
    });

    scope.post<{ Body: { name: string } }>(OPERATOR_PREFIX + "org", { schema: { body: orgBody } }, request =>
      run(async c => {
        await c.query("select pulse.operator_org_set($1,$2)", [request.body.name, ACTOR]);
        return { ok: true };
      }));

    // Break-glass roles: the same role_assignment rows as Settings → Roles; revoking the last admin answers 409.
    scope.get(OPERATOR_PREFIX + "roles", () => run(async c => ({
      roles: (await c.query(`select role,email,name,active,since::text since from pulse.operator_roles($1)`, [ACTOR])).rows,
    })));

    scope.get(OPERATOR_PREFIX + "platform-admins", () => run(async c => ({
      admins: (await c.query("select pulse.platform_admin_list() l")).rows[0].l,
    })));
    scope.post<{ Body: { email: string; action: "grant" | "revoke" } }>(OPERATOR_PREFIX + "platform-admins", { schema: { body: platformAdminBody } }, request =>
      run(async c => (await c.query("select pulse.platform_admin_set($1,$2,$3) r", [request.body.email, request.body.action === "grant", ACTOR])).rows[0].r));

    scope.post<{ Body: RoleBody }>(OPERATOR_PREFIX + "roles", { schema: { body: roleBody } }, request => run(async c => {
      const b = request.body;
      const row = (await c.query(`select person_id "personId",name from pulse.operator_role_set($1,$2,$3,$4)`,
        [b.email, b.role, b.action === "grant", ACTOR])).rows[0];
      return { ok: true, ...row };
    }));
  });
}
