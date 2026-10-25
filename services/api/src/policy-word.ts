// R41: Word (.docx) policies, edited in the browser by an approved ONLYOFFICE Docs service. OFF by default: nothing
// here runs until the operator sets PULSE_POLICY_EDITOR=onlyoffice with the service's address and a root-installed
// signing secret, after the owner approved the provider, its licence and capacity (owner errand E11). Even then the
// label says "trial" until a passing Word → browser → Word fidelity receipt (docx-fidelity.ts) is installed.
//  * HR opens a session for one policy state (migration 0215): a random token in the file and callback addresses, the
//    provider's document key, and an editor configuration signed with the shared secret (HS256). No broad token: the
//    secret never leaves the API, and a session opens one document state for one person for at most 12 hours.
//  * The provider's callbacks are trusted only through its signature (in the body or Authorization); unsigned fields
//    are ignored. The saved file is fetched only from the editor service's own origin, without redirects, at most 5 MB,
//    then checked as a Word document before the database decides whether the session may still save.
//  * Uploading a Word file and downloading a version's exact file go through the same model. Downloading stays
//    available to HR when the editor is switched off, so stored files are never locked in.
// Operator steps: docs/ops/POLICY-WORD.md.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { fail, hr, type Open, type Tx } from "./routes.js";
import { checkDocx, docxMarkdown, DocxError, DOCX_MAX_BYTES } from "./policy-docx.js";

export const DEFAULT_SECRET_FILE = "/etc/pulse/policy-editor.secret";
export const SESSION_HOURS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type WordStatus = {
  enabled: boolean; provider: "onlyoffice";
  reason: "off" | "server" | "pulse_url" | "secret_missing" | "secret_exposed" | "secret_weak" | null;
  label: string; fidelitySignedOff: boolean; maxBytes: number;
};
export type WordEditor = { status: WordStatus; server?: URL; pulse?: URL; secret?: string };

const OFF = "Word (.docx) editing is off until an editor service is approved and connected.";
const UNSET = "Word (.docx) editing is off: the editor service is not fully set up. Ask the Pulse administrator.";
const loopback = (u: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
/** An https base address without credentials, query or fragment (plain http only on this machine, for tests). */
export function baseUrl(raw: string | undefined): URL | null {
  try {
    const u = new URL(raw ?? "");
    if (u.username || u.password || u.search || u.hash) return null;
    return u.protocol === "https:" || (u.protocol === "http:" && loopback(u)) ? u : null;
  } catch { return null; }
}

/** Whether the editor may run, read fresh on every use (so switching it off needs no restart). */
export async function wordEditor(env: NodeJS.ProcessEnv = process.env): Promise<WordEditor> {
  const off = (reason: WordStatus["reason"], label: string): WordEditor => ({ status: { enabled: false, provider: "onlyoffice", reason, label, fidelitySignedOff: false, maxBytes: DOCX_MAX_BYTES } });
  if (env.PULSE_POLICY_EDITOR !== "onlyoffice") return off("off", OFF);
  const server = baseUrl(env.PULSE_POLICY_EDITOR_URL), pulse = baseUrl(env.PULSE_POLICY_EDITOR_PULSE_URL || env.PULSE_PUBLIC_URL);
  if (!server) return off("server", UNSET);
  if (!pulse) return off("pulse_url", UNSET);
  let secret: string;
  try {
    const path = env.PULSE_POLICY_EDITOR_SECRET_FILE || DEFAULT_SECRET_FILE, info = await stat(path);
    if (!info.isFile()) return off("secret_missing", UNSET);
    if (info.mode & 0o007) return off("secret_exposed", UNSET);
    secret = (await readFile(path, "utf8")).trim();
  } catch { return off("secret_missing", UNSET); }
  if (secret.length < 32 || /\s/.test(secret)) return off("secret_weak", UNSET);
  let fidelitySignedOff = false;
  if (env.PULSE_POLICY_EDITOR_FIDELITY_RECEIPT) {
    try { const r = JSON.parse(await readFile(env.PULSE_POLICY_EDITOR_FIDELITY_RECEIPT, "utf8")); fidelitySignedOff = r?.tool === "pulse-docx-fidelity/1" && r?.verdict === "pass"; } catch { /* no receipt: trial */ }
  }
  return {
    status: { enabled: true, provider: "onlyoffice", reason: null, fidelitySignedOff, maxBytes: DOCX_MAX_BYTES,
      label: fidelitySignedOff ? "Word editing is on." : "Word editing is a trial: the Word round-trip check is not signed off yet, so check the layout in Word before publishing." },
    server, pulse, secret,
  };
}

// ------------------------------------------------------------------------------------------------------------ JWT
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
export function signJwt(payload: object, secret: string): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })), body = b64(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
/** The claims of an HS256 token signed with this secret and not expired; null for anything else (alg none included). */
export function verifyJwt(token: unknown, secret: string, now = Date.now()): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length > 65536) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (head?.alg !== "HS256") return null;
    const want = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest(), got = Buffer.from(parts[2], "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    if (typeof claims.exp === "number" && claims.exp * 1000 < now - 60_000) return null;
    if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000) return null;
    return claims;
  } catch { return null; }
}

/** The callback the provider signed: its token in the body (claims are the callback) or in Authorization (claims under
 *  "payload"). A body token that does not verify is never replaced by the header. */
export function signedCallback(body: unknown, authorization: unknown, secret: string): Record<string, unknown> | null {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (b.token !== undefined) return verifyJwt(b.token, secret);
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const claims = verifyJwt(authorization.slice(7), secret);
  const inner = claims?.payload;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner as Record<string, unknown> : claims;
}

// ------------------------------------------------------------------------------------------ the saved file (SSRF)
/** The provider's address for a saved file, only on the editor service's own origin (scheme, host and port). */
export function savedFileUrl(raw: unknown, server: URL): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const u = new URL(raw);
    return !u.username && !u.password && u.origin === server.origin ? u : null;
  } catch { return null; }
}
/** Fetches the saved file: no redirects, 30 seconds, at most `max` bytes. */
export async function fetchSaved(url: URL, max = DOCX_MAX_BYTES, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const r = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!r.ok || !r.body) throw new Error(`the editor service answered ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new DocxError("A Word file can be at most 5 MB.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw new DocxError("A Word file can be at most 5 MB.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** The editor configuration for one session, signed whole (the provider refuses a changed one). */
export function editorConfig(o: { key: string; title: string; fileUrl: string; callbackUrl: string; person: string; name: string; expiresAt: string }, secret: string) {
  const config = {
    documentType: "word",
    document: { fileType: "docx", key: o.key, title: o.title, url: o.fileUrl, permissions: { edit: true, download: true, print: true, review: true, comment: true } },
    editorConfig: { mode: "edit", lang: "en", region: "en-IN", callbackUrl: o.callbackUrl, user: { id: o.person, name: o.name }, customization: { forcesave: true } },
  };
  return { ...config, token: signJwt({ ...config, exp: Math.floor(new Date(o.expiresAt).getTime() / 1000) }, secret) };
}

const fileName = (raw: unknown) => {
  const base = String(raw ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, "").trim().slice(0, 160);
  return /\.docx$/i.test(base) && base.length > 5 ? base : fail(400, "Choose a Word document (.docx)");
};
const ascii = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
type Body = Record<string, unknown>;

export function registerPolicyWordRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const body = { type: "object" };
  // HR attaches a Word file to the policy as its draft: in place, or as the next version on top of a published one.
  app.post<{ Body: Body }>("/api/v0/hr/policies/docx", { schema: { body }, bodyLimit: Math.ceil(DOCX_MAX_BYTES * 1.37) + 8192 }, (req) => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, "HR or leadership edits policy documents");
    const w = await wordEditor();
    if (!w.status.enabled) fail(409, w.status.label);
    const b = req.body, data = typeof b.data === "string" ? b.data : "";
    if (!data || data.length > Math.ceil(DOCX_MAX_BYTES * 1.37) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, "Choose a Word document (.docx) of at most 5 MB");
    const name = fileName(b.name), bytes = Buffer.from(data, "base64"), text = docxMarkdown(checkDocx(bytes));
    const version = Number(b.version), revision = Number(b.revision ?? 1);
    if (!Number.isInteger(version) || version < 0 || !Number.isInteger(revision) || revision < 1) fail(400, "Refresh the policy before editing");
    return (await c.query("select pulse.policy_docx_draft_save($1,$2,$3,$4,$5,$6,$7,'upload') r",
      [String(b.kind ?? "") || null, String(b.title ?? "").trim().slice(0, 100), text, version, revision, bytes, name])).rows[0].r;
  }));
  // The exact Word file of a version, with its SHA-256 (also when the editor is switched off).
  app.get<{ Params: { id: string } }>("/api/v0/hr/policies/:id/docx", async (req, reply) => {
    const row = await tx(req, async (c, v) => {
      if (!hr(v) || !v.person) fail(403, "HR or leadership reads policy Word files");
      if (!UUID.test(req.params.id)) fail(400, "Choose a valid record");
      return (await c.query("select * from pulse.policy_docx_read($1)", [req.params.id])).rows[0] ?? fail(404, "This version has no Word file");
    });
    const name = ascii(row.name ?? `policy-v${row.version}.docx`);
    reply.header("cache-control", "private, no-store").header("content-disposition", `attachment; filename="${name}"`).header("x-pulse-sha256", row.sha256);
    return reply.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(row.bytes);
  });
  // HR opens the editor: one session for the policy's latest version, which must have a Word file.
  app.post<{ Body: Body }>("/api/v0/hr/policies/word-session", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, "HR or leadership edits policy documents");
    const w = await wordEditor();
    if (!w.status.enabled) fail(409, w.status.label);
    const documentId = String(req.body.documentId ?? "");
    if (!UUID.test(documentId)) fail(400, "Choose a valid record");
    const token = randomBytes(32).toString("base64url");
    const s = (await c.query("select pulse.policy_editor_open($1,$2,$3) r", [documentId, hash(token), SESSION_HOURS])).rows[0].r;
    const base = `${w.pulse!.origin}${w.pulse!.pathname.replace(/\/$/, "")}/api/policy-editor/${token}`;
    return {
      session: s.session, version: s.version, revision: s.revision, status: s.status, sha256: s.sha256, expiresAt: s.expiresAt, word: w.status,
      script: `${w.server!.origin}${w.server!.pathname.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`,
      config: editorConfig({ key: s.key, title: s.name ?? `${s.title}.docx`, fileUrl: `${base}/file`, callbackUrl: `${base}/callback`, person: v.person!, name: v.name, expiresAt: s.expiresAt }, w.secret!),
    };
  }));

  // -------------------------------------------------------------- the editor service (signed out, signed requests)
  // Both answer 404 while the editor is off, as any unknown address does.
  app.get<{ Params: { token: string } }>("/api/v0/policy-editor/:token/file", async (req, reply) => {
    const w = await wordEditor();
    if (!w.status.enabled || !TOKEN.test(req.params.token)) fail(404, "Not found");
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ") || !verifyJwt(auth.slice(7), w.secret!)) fail(403, "Signed editor request required");
    const bytes = await open(async (c) => (await c.query("select pulse.policy_editor_file($1) b", [hash(req.params.token)])).rows[0].b);
    if (!bytes) fail(404, "Not found");
    reply.header("cache-control", "private, no-store");
    return reply.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(bytes);
  });
  app.post<{ Params: { token: string }; Body: Body }>("/api/v0/policy-editor/:token/callback", { schema: { body } }, async (req, reply) => {
    const w = await wordEditor();
    if (!w.status.enabled || !TOKEN.test(req.params.token)) fail(404, "Not found");
    const refuse = (code: number, why: string) => { req.log.warn({ why }, "policy editor callback refused"); return reply.code(code).send({ error: 1 }); };
    const claims = signedCallback(req.body, req.headers.authorization, w.secret!);
    if (!claims) return refuse(403, "signature");
    const status = Number(claims.status);
    let bytes: Buffer | null = null, text: string | null = null;
    if (status === 2 || status === 6) {
      const url = savedFileUrl(claims.url, w.server!);
      if (!url) return refuse(400, "saved file outside the editor service");
      try { bytes = await fetchSaved(url); text = docxMarkdown(checkDocx(bytes)); }
      catch (e) { return refuse(e instanceof DocxError ? 422 : 502, e instanceof DocxError ? "saved file is not a plain Word document" : "saved file unavailable"); }
    }
    const r = await open(async (c) => (await c.query("select pulse.policy_editor_event($1,$2,$3,$4,$5) r", [hash(req.params.token), String(claims.key ?? ""), Number.isInteger(status) ? status : null, bytes, text])).rows[0].r);
    if (["stale", "denied", "expired"].includes(r.outcome)) return refuse(409, r.outcome);
    return { error: 0 };
  });
}
