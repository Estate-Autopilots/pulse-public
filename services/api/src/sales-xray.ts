// EST-1363 (owner, 20 Oct 2026): Sales X-Ray as an app inside Pulse. Each staff person connects their own Sales X-Ray
// account and reads their calls and leads here; Pulse's assistant asks Sales X-Ray through its MCP server with that
// person's own token. Design (both sides): docs/architecture/SALES_XRAY_APP.md.
//  * Connect is Sales X-Ray's OAuth 2.0 code + PKCE S256. Pulse registers itself there once per company and return
//    address (RFC 7591), so nobody sets a client secret by hand; the secret and every token are sealed here with the
//    document keyring (document-keys.ts) and stored in pulse_priv (0710), bound to the company and person.
//  * Nothing from Sales X-Ray is stored: each list is read when the page asks, as the person, and Sales X-Ray decides
//    what they see (their own calls and leads, or their team's as an owner or admin there).
//  * The browser never meets a token. Connect answers the consent address; Sales X-Ray sends the person back to the
//    page /apps/sales-xray/callback, which posts the code and state here; the attempt works once, for the same person.
//  * A refresh holds the link row's lock, so two reads at once never spend one refresh token twice.
//  * Lead stages: an editor's workflows (leadership and admins) go to Sales X-Ray as stage suggestions, step names
//    only, on Connect, from "Send workflows" and a few seconds after a workflow or board is saved. Sales X-Ray takes
//    them from its organisation owners and admins and adds nothing until a manager taps a suggestion.
//  * Off unless the server switches it on (PULSE_SALES_XRAY=1, modules.ts) and names the Sales X-Ray address
//    (PULSE_SALES_XRAY_URL). Ask is separately off unless PULSE_SALES_XRAY_ASK=1: it runs Codex the way AI co-workers
//    do (read-only, no shell, no apps, none of the account's own config), with Sales X-Ray's MCP as its only tools and
//    the person's one-hour read token in the process environment, never in the prompt.
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { DocumentKeyError, loadKeyring, open as unseal, seal, type Keyring, type Sealed } from "./document-keys.js";
import { moduleOff, readModules } from "./modules.js";
import { fail, leadership, sessionHash, type Tx, type Viewer } from "./routes.js";
import { companyOrigin, normaliseHost } from "./tenant-context.js";
import { publicOrigin } from "./tenant-model.js";

export const CALLBACK = "/apps/sales-xray/callback";
/** What Pulse asks for: reading; leads:write to add a client as a lead and send workflow step names as lead-stage
 *  suggestions; leads:update so a linked client's company and city, edited in Pulse, reach its lead (PATCH
 *  /v1/api/leads/{id}); calls:write to send a recording for the person to add in Sales X-Ray (POST /v1/api/calls).
 *  Ask never gets a writing tool. */
export const SCOPES = "calls:read reports:read leads:read leads:write leads:update calls:write";
/** The scopes a connection made before Sales X-Ray had them lacks: such a person sees "Reconnect to allow updates". */
export const missingScopes = (scopes: readonly string[] | null | undefined) => SCOPES.split(" ").filter((s) => !(scopes ?? []).includes(s));
/** The MCP tools Ask may use: reading only (add_lead is never offered to the model). */
export const ASK_TOOLS = ["whoami", "list_calls", "get_call", "call_facts", "list_leads", "get_lead"] as const;
/** The routes that save a workflow or a board: a few seconds after one, an editor's workflows go to Sales X-Ray. */
export const WORKFLOW_SAVES = new Set(["/api/v0/workflows", "/api/v0/workflows/from-sop", "/api/v0/workflows/:id", "/api/v0/workflows/:id/publish",
  "/api/v0/workflows/:id/status", "/api/v0/workflows/:id/tab", "/api/v0/workflows/boards", "/api/v0/workflows/boards/:id", "/api/v0/workflows/boards/:id/tabs"]);
export const STAGES = ["open", "new", "not_connected", "follow_up", "interested", "won", "lost"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EARLY = 60_000; // refresh a token that has less than a minute left

type Box = { k: string; w: string; d: string };
export type Link = { base: string; redirectUri: string; access: Box; accessExpiresAt: string; refresh: Box; scopes: string[]; account: Record<string, unknown>; connectedAt: string };
export type Answer = { status: number; body: unknown };
export type SalesXrayFetch = (url: string, init: RequestInit) => Promise<Response>;
export type Asker = (input: { base: string; token: string; question: string }) => Promise<string>;

/** A refusal written for people, shown as it is (the error handler passes `expose` messages on). */
export class SalesXrayError extends Error {
  readonly expose = true;
  constructor(readonly statusCode: number, message: string, readonly reason = "sales_xray") { super(message); }
}
const unreachable = () => new SalesXrayError(502, "Sales X-Ray isn't answering. Try again in a minute.", "unreachable");
const ended = () => new SalesXrayError(409, "Your Sales X-Ray connection ended. Connect it again.", "ended");

/** The Sales X-Ray address this server talks to, or null when none is set (Connect then says so). */
export function salesXrayBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PULSE_SALES_XRAY_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    return (url.protocol === "https:" || local) && url.pathname === "/" && !url.search && !url.hash && !url.username ? url.origin : null;
  } catch { return null; }
}
export const askOn = (env: NodeJS.ProcessEnv = process.env) => env.PULSE_SALES_XRAY_ASK === "1";

const box = (s: Sealed): Box => ({ k: s.keyId, w: s.dataKey.toString("base64"), d: s.data.toString("base64") });
const unbox = (b: Box): Sealed => ({ keyId: b.k, dataKey: Buffer.from(b.w, "base64"), data: Buffer.from(b.d, "base64") });
export const clientContext = (org: string, base: string) => `${org}/sales-xray/client/${base}`;
export const tokenContext = (org: string, person: string, kind: "access" | "refresh") => `${org}/${person}/sales-xray/${kind}`;
async function keyring(): Promise<Keyring> {
  const state = await loadKeyring();
  if (!state.ok) throw new DocumentKeyError("Sales X-Ray can’t be connected yet: this Pulse server’s encryption key isn’t installed. Ask the Pulse administrator.", state.reason);
  return state.ring;
}
const pkce = () => { const verifier = randomBytes(48).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
/** The Pulse address this person opened (the web sends it as x-pulse-host): the person comes back to the same address,
 *  where their session cookie lives. A company's own host and the install's own addresses (pulse, pulse-staging,
 *  pulse-dev) all work, without relying on the install's configured public URL. */
export function returnAddress(req: FastifyRequest) {
  const raw = req.headers["x-pulse-host"], host = normaliseHost(raw);
  return new URL(CALLBACK, host ? publicOrigin(host, undefined, typeof raw === "string" ? raw : undefined) : companyOrigin()).href;
}
/** A short string field from a body, trimmed; anything else (or too long) is null. */
const text = (x: unknown, max: number) => typeof x === "string" && x.trim().length <= max ? x.trim() : null;
export const db = async (c: PoolClient, op: string, b: unknown = {}) => (await c.query("select pulse.sales_xray($1,$2) d", [op, JSON.stringify(b)])).rows[0].d;

/** One call to Sales X-Ray from this server: no redirects, a time limit, JSON both ways. */
export async function call(f: SalesXrayFetch, url: string, init: RequestInit, timeoutMs = 15_000): Promise<Answer> {
  let response: Response;
  try { response = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw unreachable(); }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const message = (body: unknown) => {
  const e = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof e === "object" && e && typeof e.message === "string" ? e.message : null;
};

/** The person this request is for: a staff person (HR-only and accountant accounts have no Sales X-Ray app). */
export function staffPerson(v: Viewer): string {
  if (!v.person || v.role === "accountant") return fail(403, "Sales X-Ray connects a staff person's own account");
  return v.person;
}
function configured(): string {
  const base = salesXrayBase();
  if (!base) throw new SalesXrayError(409, "Sales X-Ray isn't set up on this Pulse server yet. Ask the Pulse administrator.", "not_configured");
  return base;
}

/** Pulse's client at this Sales X-Ray address for this company's return address, registered on first use. */
async function client(c: PoolClient, f: SalesXrayFetch, v: Viewer, base: string, redirectUri: string): Promise<{ clientId: string; secret: string }> {
  let row = await db(c, "client", { base, redirectUri });
  if (!row) {
    const made = await call(f, `${base}/v1/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Pulse", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "client_secret_basic", client_uri: new URL(redirectUri).origin }) });
    const out = made.body as { client_id?: unknown; client_secret?: unknown } | null;
    if (made.status !== 201 || typeof out?.client_id !== "string" || !/^sxc_[A-Za-z0-9]{24}$/.test(out.client_id) || typeof out.client_secret !== "string")
      throw new SalesXrayError(502, "Sales X-Ray didn't accept Pulse. Try again later.", "register");
    row = await db(c, "client_save", { base, redirectUri, clientId: out.client_id, secret: box(seal(await keyring(), Buffer.from(out.client_secret), clientContext(v.org, base))) });
  }
  return { clientId: row.clientId, secret: unseal(await keyring(), unbox(row.secret), clientContext(v.org, base)).toString() };
}

type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope?: string };
const tokens = (body: unknown): Tokens | null => {
  const t = body as Partial<Tokens> | null;
  return t && typeof t.access_token === "string" && /^sxa_/.test(t.access_token) && typeof t.refresh_token === "string" && /^sxr_/.test(t.refresh_token)
    && typeof t.expires_in === "number" ? t as Tokens : null;
};
async function sealTokens(org: string, person: string, t: Tokens) {
  const ring = await keyring();
  return { access: box(seal(ring, Buffer.from(t.access_token), tokenContext(org, person, "access"))), refresh: box(seal(ring, Buffer.from(t.refresh_token), tokenContext(org, person, "refresh"))),
    accessExpiresAt: new Date(Date.now() + Math.max(60, Math.min(t.expires_in, 86_400)) * 1000).toISOString() };
}

/** The person's access token, refreshed under the row's lock when it has less than a minute left. */
export async function accessToken(c: PoolClient, f: SalesXrayFetch, v: Viewer): Promise<{ base: string; token: string }> {
  const person = staffPerson(v);
  let link = (await db(c, "link")) as Link | null;
  if (!link) throw new SalesXrayError(409, "Connect your Sales X-Ray account first.", "not_connected");
  if (Date.parse(link.accessExpiresAt) - Date.now() < EARLY) {
    link = (await db(c, "lock")) as Link | null;
    if (!link) throw ended();
    if (Date.parse(link.accessExpiresAt) - Date.now() < EARLY) {
      const { clientId, secret } = await client(c, f, v, link.base, link.redirectUri);
      const refresh = unseal(await keyring(), unbox(link.refresh), tokenContext(v.org, person, "refresh")).toString();
      const r = await call(f, `${link.base}/v1/oauth/token`, { method: "POST", headers: { authorization: basic(clientId, secret), "content-type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: refresh }) });
      const t = tokens(r.body);
      if (!t) {
        if (r.status === 400 || r.status === 401) { await db(c, "drop"); throw ended(); }
        throw unreachable();
      }
      const sealed = await sealTokens(v.org, person, t);
      await db(c, "refreshed", sealed);
      link = { ...link, ...sealed };
    }
  }
  await db(c, "used");
  return { base: link.base, token: unseal(await keyring(), unbox(link.access), tokenContext(v.org, person, "access")).toString() };
}

/** Read one Sales X-Ray API path as the person. Its refusals come back in its own words. */
export async function read(c: PoolClient, f: SalesXrayFetch, v: Viewer, path: string) {
  const { base, token } = await accessToken(c, f, v);
  const r = await call(f, `${base}/v1/api${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (r.status === 200) return r.body;
  if (r.status === 401) { await db(c, "drop"); throw ended(); }
  if ([403, 404, 422, 429].includes(r.status)) throw new SalesXrayError(r.status, message(r.body) ?? "Sales X-Ray refused that.", "refused");
  throw unreachable();
}

// ----- FLOW-E: Sales X-Ray as an App action --------------------------------------------------------------------------
/** Is Sales X-Ray set up on this server, and is the viewer connected (Settings → Apps, the Flow step). */
export async function xrayStatus(c: PoolClient): Promise<{ configured: boolean; connected: boolean; account: Record<string, unknown> | null }> {
  const base = salesXrayBase(); if (!base) return { configured: false, connected: false, account: null };
  const s = await db(c, "status").catch(() => null) as { connected?: boolean; account?: Record<string, unknown> } | null;
  return { configured: true, connected: !!s?.connected, account: s?.account ?? null };
}
type CallFact = { label?: string; category?: string; value?: unknown; display?: string | null };
/** One analysed call, read as the person: its summary, the items asked for, objections, promises and score, sorted
 *  from the call's facts the way the step's ports carry them. */
export async function callAnalysis(c: PoolClient, v: Viewer, id: string, f: SalesXrayFetch = fetch) {
  const d = await read(c, f, v, `/calls/${id}`) as { title?: string | null; open_url?: string | null; facts?: CallFact[] | null };
  const facts = Array.isArray(d.facts) ? d.facts.slice(0, 200) : [];
  const line = (x: CallFact) => `${x.label ?? x.category ?? ""}${x.display ? `: ${x.display}` : typeof x.value === "string" || typeof x.value === "number" ? `: ${x.value}` : ""}`.trim();
  const of = (re: RegExp) => facts.filter((x) => re.test(`${x.category ?? ""} ${x.label ?? ""}`)).map(line).filter(Boolean).slice(0, 50);
  const score = facts.find((x) => /score/i.test(`${x.label ?? ""} ${x.category ?? ""}`));
  return { summary: [d.title, ...facts.slice(0, 12).map(line)].filter(Boolean).join("\n").slice(0, 8000), url: typeof d.open_url === "string" ? d.open_url : undefined,
    items: of(/item|ask|need|requirement|config/i), objections: of(/objection|concern/i), promises: of(/promise|commit|follow/i),
    score: typeof score?.value === "number" ? score.value : score?.display ?? null, source: "sales-xray" };
}

// ----- lead stages from Pulse workflows ---------------------------------------------------------------------------
const STEP_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
type CatalogueRow = { id: string; name: string; definition: { steps?: { id?: unknown; title?: unknown; module?: unknown; kind?: unknown }[] } | null; updated_at: Date | string };
export type Sent = { sent: boolean; kept?: number; offered?: number; reason?: string; words: string };

/** The company's workflows as Sales X-Ray's catalogue: names and step names only (no people, clients or amounts). A
 *  workflow made for one client is left out, so no customer's name leaves Pulse. 20 workflows, 50 steps each. */
export async function workflowCatalogue(c: PoolClient) {
  const rows = (await c.query(`select w.id,w.name,w.definition,w.updated_at from pulse.workflow w
     where w.status in ('live','draft','paused') and w.client_id is null order by w.status='live' desc,w.updated_at desc limit 20`)).rows as CatalogueRow[];
  const workflows = rows.map((w) => ({
    id: String(w.id), name: String(w.name).trim().slice(0, 60),
    steps: (w.definition?.steps ?? []).filter((s) => STEP_ID.test(String(s.id ?? "")) && typeof s.title === "string" && s.title.trim())
      .slice(0, 50).map((s, i) => ({ id: String(s.id), name: String(s.title).trim().slice(0, 60), block: String(s.module ?? s.kind ?? "task"), position: i + 1 })),
  })).filter((w) => w.steps.length);
  const newest = rows.reduce((at, w) => Math.max(at, Date.parse(String(w.updated_at)) || 0), 0);
  return { source: "pulse" as const, revision: newest ? new Date(newest).toISOString() : "empty", workflows };
}

/** Send this editor's company workflows to Sales X-Ray with their own token. Never throws for Sales X-Ray's refusals. */
export async function sendCatalogue(c: PoolClient, f: SalesXrayFetch, v: Viewer): Promise<Sent> {
  if (!leadership(v)) return { sent: false, reason: "not_editor", words: "Leadership and admins send workflows." };
  const link = (await db(c, "link")) as Link | null;
  if (!link) return { sent: false, reason: "not_connected", words: "Connect your Sales X-Ray account first." };
  if (!link.scopes.includes("leads:write")) return { sent: false, reason: "reconnect", words: "Connect Sales X-Ray again to send your workflows." };
  const catalogue = await workflowCatalogue(c);
  if (!catalogue.workflows.length) return { sent: false, reason: "empty", words: "No workflow with steps to send yet." };
  const { base, token } = await accessToken(c, f, v);
  const r = await call(f, `${base}/v1/api/lead-journey/catalogue`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(catalogue) });
  const out = (r.body ?? {}) as { kept?: unknown; offered?: unknown; error?: { code?: unknown; message?: unknown } };
  if (r.status === 200 || r.status === 201) {
    const kept = Number(out.kept) || 0, offered = Number(out.offered) || 0;
    return { sent: true, kept, offered, words: `Sent ${kept} workflow step${kept === 1 ? "" : "s"} to Sales X-Ray.${offered ? ` ${offered} new stage suggestion${offered === 1 ? " waits" : "s wait"} in Lead stages.` : ""}` };
  }
  if (r.status === 401) { await db(c, "drop"); return { sent: false, reason: "ended", words: "Your Sales X-Ray connection ended. Connect it again." }; }
  const code = typeof out.error?.code === "string" ? out.error.code : "refused";
  const words = code === "owner_only" ? "Sales X-Ray takes workflows from its organisation's owners and admins."
    : code === "organisation_only" ? "Your Sales X-Ray workspace is Personal: lead stages belong to organisations."
    : typeof out.error?.message === "string" ? out.error.message : "Sales X-Ray didn't take the workflows. Try again later.";
  return { sent: false, reason: code, words };
}

const ASK_PROMPT = (question: string) => `You answer one question from a salesperson about their own sales calls and leads in Sales X-Ray.
Use only the sales_xray tools. List calls or leads first, then read the ones that matter by id.
Answer in plain, short sentences (at most 8 lines). Quote facts as Sales X-Ray gives them, with the call's title or date.
If the tools return nothing relevant, say you found nothing. Never invent a call, lead, name or number.

Question: ${question}`;

/** Ask with Codex as the co-worker runner does, plus Sales X-Ray's MCP server; the token rides in the environment. */
export function codexAsker(env: NodeJS.ProcessEnv = process.env): Asker {
  return ({ base, token, question }) => new Promise((resolve, reject) => {
    const script = 'd=$(mktemp -d) && cd "$d" && codex exec --json --ephemeral --ignore-user-config -m "$0" -c model_reasoning_effort="$1" '
      + '--skip-git-repo-check -s read-only --disable shell_tool --disable browser_use --disable browser_use_external '
      + '--disable computer_use --disable apps --disable in_app_browser --disable skill_search '
      + '-c "mcp_servers.sales_xray.url=\\"$2\\"" -c \'mcp_servers.sales_xray.bearer_token_env_var="SX_MCP_TOKEN"\' '
      + `-c 'mcp_servers.sales_xray.enabled_tools=${JSON.stringify(ASK_TOOLS)}'; s=$?; cd /; rm -rf "$d"; exit $s`;
    const child = spawn("bash", ["-lc", script, env.PULSE_SALES_XRAY_ASK_MODEL || "gpt-6-luna", env.PULSE_SALES_XRAY_ASK_EFFORT || "low", `${base}/v1/mcp`],
      { env: { HOME: env.HOME ?? "", PATH: `${env.HOME}/.local/bin:${env.HOME}/.npm-global/bin:${env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`, SX_MCP_TOKEN: token }, stdio: ["pipe", "pipe", "ignore"], timeout: 150_000 });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { if (out.length < 2_000_000) out += chunk.toString(); });
    child.on("error", () => reject(new SalesXrayError(503, "Pulse's assistant isn't available on this server.", "ask_unavailable")));
    child.on("close", () => {
      let text = "";
      for (const line of out.split("\n")) {
        try { const d = JSON.parse(line); if (d.type === "item.completed" && d.item?.type === "agent_message" && typeof d.item.text === "string") text = d.item.text; } catch {}
      }
      text = text.trim();
      if (!text) reject(new SalesXrayError(502, "Pulse's assistant didn't answer. Try again.", "ask_empty"));
      else resolve(text.replace(/\bsx[akrco]s?_[A-Za-z0-9]{8,}\b/g, "[hidden]").slice(0, 4000));
    });
    child.stdin.end(ASK_PROMPT(question));
  });
}

export function registerSalesXrayRoutes(app: FastifyInstance, { tx, fetchImpl, asker, catalogueDelayMs = 8_000 }: { tx: Tx; fetchImpl?: SalesXrayFetch; asker?: Asker; catalogueDelayMs?: number }) {
  const f: SalesXrayFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const ask = asker ?? codexAsker();
  let asking = 0;

  // A few seconds after an editor saves a workflow or a board (the builder saves often: the last save wins), their
  // company's workflows go to Sales X-Ray, when the app is on and they are connected. Nothing in the save waits on it.
  const later = new Map<string, ReturnType<typeof setTimeout>>();
  app.addHook("onResponse", async (req, reply) => {
    if (req.method !== "POST" || reply.statusCode >= 300 || !WORKFLOW_SAVES.has(req.routeOptions?.url ?? "") || !salesXrayBase()) return;
    const who = sessionHash(`${String(req.headers["x-pulse-host"] ?? "")}|${String(req.headers["x-pulse-session"] ?? req.headers["cf-access-authenticated-user-email"] ?? "")}`);
    clearTimeout(later.get(who));
    later.set(who, setTimeout(() => {
      later.delete(who);
      tx(req, async (c, v) => {
        if (!leadership(v) || moduleOff(await readModules(c, v.org), "sales_xray")) return;
        const sent = await sendCatalogue(c, f, v);
        req.log.info({ sent: sent.sent, reason: sent.reason ?? null, kept: sent.kept ?? null }, "Sales X-Ray workflows");
      }).catch((error: { reason?: string }) => req.log.warn({ reason: error?.reason ?? "unknown" }, "Sales X-Ray workflows not sent"));
    }, catalogueDelayMs));
  });

  app.get("/api/v0/sales-xray/status", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const base = salesXrayBase(), status = await db(c, "status");
    // A connection made before Pulse asked for leads:update and calls:write still reads; the page offers Reconnect.
    return { configured: !!base, ask: askOn(), ...status, ...(status.connected ? { missing: missingScopes(status.scopes) } : { base }) };
  }));

  // The consent address for this person; the page goes there itself (no redirect through the web proxy).
  app.post("/api/v0/sales-xray/connect", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const base = configured(), redirectUri = returnAddress(req);
    const { clientId } = await client(c, f, v, base, redirectUri);
    const state = randomBytes(32).toString("base64url"), { verifier, challenge } = pkce();
    await db(c, "begin", { stateHash: sessionHash(state), verifier, base, redirectUri });
    const url = new URL("/connect", base);
    url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return { url: url.href };
  }));

  app.post<{ Body: { code?: unknown; state?: unknown; error?: unknown } | null }>("/api/v0/sales-xray/callback", { bodyLimit: 4096 }, (req) => tx(req, async (c, v) => {
    const person = staffPerson(v);
    const body = { code: text(req.body?.code, 200), state: text(req.body?.state, 200), error: text(req.body?.error, 100) };
    const attempt = await db(c, "take", { stateHash: sessionHash(body.state ?? "") });
    if (attempt.error) fail(400, "This Sales X-Ray sign-in link has expired. Press Connect again.");
    if (body.error) return { connected: false, reason: body.error === "access_denied" ? "cancelled" : "refused" };
    if (!/^sxo_[A-Za-z0-9]{40}$/.test(body.code ?? "")) fail(400, "Sales X-Ray sent back no sign-in code. Press Connect again.");
    const { clientId, secret } = await client(c, f, v, attempt.base, attempt.redirectUri);
    const r = await call(f, `${attempt.base}/v1/oauth/token`, { method: "POST", headers: { authorization: basic(clientId, secret), "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code: String(body.code), redirect_uri: attempt.redirectUri, code_verifier: attempt.verifier }) });
    const t = tokens(r.body);
    if (!t) throw r.status >= 500 ? unreachable() : new SalesXrayError(400, "Sales X-Ray didn't accept that sign-in. Press Connect again.", "exchange");
    const me = await call(f, `${attempt.base}/v1/api/me`, { method: "GET", headers: { authorization: `Bearer ${t.access_token}`, accept: "application/json" } });
    const who = (me.body ?? {}) as { person?: { name?: unknown }; workspace?: { name?: unknown; kind?: unknown; role?: unknown } };
    const account = { person: typeof who.person?.name === "string" ? who.person.name : null, workspace: typeof who.workspace?.name === "string" ? who.workspace.name : null,
      kind: who.workspace?.kind === "personal" ? "personal" : "organisation", role: typeof who.workspace?.role === "string" ? who.workspace.role : null };
    await db(c, "save", { base: attempt.base, redirectUri: attempt.redirectUri, ...(await sealTokens(v.org, person, t)), scopes: String(t.scope ?? SCOPES).split(" ").filter(Boolean), account });
    // An editor's workflows go along at once (lead-stage suggestions); a refusal there never undoes the connection.
    let workflows: Sent | null = null;
    if (leadership(v)) {
      try { workflows = await sendCatalogue(c, f, v); } catch (error) { workflows = { sent: false, reason: (error as { reason?: string }).reason ?? "unreachable", words: "Your workflows will go to Sales X-Ray with the next save." }; }
    }
    return { connected: true, account, workflows };
  }));

  app.post("/api/v0/sales-xray/catalogue", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    if (!leadership(v)) fail(403, "Leadership and admins send workflows");
    return sendCatalogue(c, f, v);
  }));

  app.post("/api/v0/sales-xray/disconnect", (req) => tx(req, async (c, v) => {
    const person = staffPerson(v);
    const link = (await db(c, "link")) as Link | null;
    // XRAY-LINK: whether Sales X-Ray confirmed the end. When it can't be reached (25 Oct: Sales X-Ray dev restarted
    // mid-test), Pulse still forgets the tokens and the page tells the person to remove Pulse under Connected apps.
    let revoked = !link;
    if (link) {
      // Ending it at Sales X-Ray first; if Sales X-Ray can't be reached, Pulse forgets the tokens anyway.
      try {
        const { clientId, secret } = await client(c, f, v, link.base, link.redirectUri);
        const refresh = unseal(await keyring(), unbox(link.refresh), tokenContext(v.org, person, "refresh")).toString();
        const r = await call(f, `${link.base}/v1/oauth/revoke`, { method: "POST", headers: { authorization: basic(clientId, secret), "content-type": "application/x-www-form-urlencoded" },
          body: form({ token: refresh, token_type_hint: "refresh_token" }) }, 8_000);
        revoked = r.status === 200;
        if (!revoked) req.log.warn({ status: r.status }, "Sales X-Ray revoke refused");
      } catch (error) { req.log.warn({ reason: (error as { reason?: string }).reason ?? "unknown" }, "Sales X-Ray revoke skipped"); }
    }
    await db(c, "drop");
    return { connected: false, revoked, ...(revoked ? {} : { words: "Pulse forgot your connection, but Sales X-Ray didn't answer. To be sure, remove Pulse in Sales X-Ray under Settings, Connected apps." }) };
  }));

  app.get<{ Querystring: { before?: string } }>("/api/v0/sales-xray/calls", (req) => tx(req, async (c, v) => {
    const before = req.query.before;
    if (before !== undefined && !UUID.test(before)) fail(400, "Choose a call from the list");
    return read(c, f, v, `/calls${before ? `?before=${before}` : ""}`);
  }));
  app.get<{ Params: { id: string } }>("/api/v0/sales-xray/calls/:id", (req) => tx(req, async (c, v) => {
    if (!UUID.test(req.params.id)) fail(404, "Call not found");
    return read(c, f, v, `/calls/${req.params.id}`);
  }));
  app.get<{ Querystring: { stage?: string; offset?: string } }>("/api/v0/sales-xray/leads", (req) => tx(req, async (c, v) => {
    const { stage, offset } = req.query;
    if (stage !== undefined && !(STAGES as readonly string[]).includes(stage)) fail(400, "Choose a stage from the list");
    if (offset !== undefined && !/^\d{1,6}$/.test(offset)) fail(400, "Choose a page from the list");
    const q = new URLSearchParams({ ...(stage ? { stage } : {}), ...(offset ? { offset } : {}) }).toString();
    return read(c, f, v, `/leads${q ? `?${q}` : ""}`);
  }));
  app.get<{ Params: { id: string } }>("/api/v0/sales-xray/leads/:id", (req) => tx(req, async (c, v) => {
    if (!UUID.test(req.params.id)) fail(404, "Lead not found");
    return read(c, f, v, `/leads/${req.params.id}`);
  }));

  // Pulse's MCP gateway: one JSON-RPC message to Sales X-Ray's MCP server as the signed-in person, so any assistant in
  // Pulse uses Sales X-Ray without ever holding the person's token.
  app.post<{ Body: Record<string, unknown> }>("/api/v0/sales-xray/mcp", { bodyLimit: 65_536 }, async (req, reply) => {
    const { body, status } = await tx(req, async (c, v) => {
      const message = req.body;
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") fail(400, "Send one JSON-RPC 2.0 message");
      const { base, token } = await accessToken(c, f, v);
      const r = await call(f, `${base}/v1/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(message) }, 30_000);
      if (r.status === 401) { await db(c, "drop"); throw ended(); }
      return { body: r.body, status: r.status };
    });
    return status === 202 ? reply.code(202).send() : reply.code(status === 200 ? 200 : 502).send(body ?? { error: "Sales X-Ray isn't answering. Try again in a minute." });
  });

  app.post<{ Body: { question?: unknown } | null }>("/api/v0/sales-xray/ask", { bodyLimit: 4096 }, async (req) => {
    const { base, token, question } = await tx(req, async (c, v) => {
      const person = staffPerson(v);
      if (!askOn()) fail(404, "Pulse's assistant for Sales X-Ray isn't switched on here");
      const question = text(req.body?.question, 500) ?? "";
      if (question.length < 3) fail(400, "Ask a question of 3 to 500 characters");
      if (!(await c.query("select pulse.auth_allow($1,10) ok", [sessionHash(`sales-xray-ask:${person}`)])).rows[0].ok) fail(429, "That's a lot of questions. Try again in 15 minutes.");
      return { ...(await accessToken(c, f, v)), question };
    });
    if (asking >= 2) fail(429, "Pulse's assistant is busy. Try again in a minute.");
    asking += 1;
    try { return { answer: await ask({ base, token, question }) }; }
    finally { asking -= 1; }
  });
}
