// R52: per-company connectors (contract connector.v1, migration 0470, docs/ops/CONNECTORS.md). A company's admin
// previews what a connector asks for, installs it for their company only, selects the company's own roots, grants
// scopes and entities with a recorded approval, and can revoke it; Settings → Connected sources shows each connector's
// grants, what is missing, its credential's reference (never the secret) and each root's rights and cursor health.
// EA Connect is Pulse's own Drive reader (R44's worker) and uses the company's own Google credential, which the platform
// operator installs into that company's secret store (pulse-connect secret); a company's own plugin pushes signed
// batches to the ingest service with a key only it holds. Nothing is read unless the server sets PULSE_CONNECTORS=1;
// the company is always the session's, never a field of a request.
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, type Tx, type Viewer } from "./routes.js";
import { driveChangesOn } from "./drive-changes.js";

type Body = Record<string, unknown>;
type Manifest = { contract: string; key: string; name: string; version: string; publisher: string; transport: "pull" | "push";
  auth: string; scopes: { scope: string; why: string }[]; sources: string[]; entities: { type: string; schema: number }[] };

export const CONNECTOR_CONTRACT = "connector.v1";
const repositoryRoot = process.env.PULSE_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const read = (name: string) => JSON.parse(readFileSync(resolve(repositoryRoot, "packages/schemas/connector", name), "utf8"));
export const manifestSchema = read("manifest.v1.json");
export const batchSchema = read("batch.v1.json");
/** Pulse's own EA Connect manifest: product code, the same for every company; a company holds its granted copy. */
export const EA_CONNECT: Manifest = read("ea-connect.json");
const ENTITY_SCOPES: Record<string, string> = manifestSchema["x-entity-scopes"];
const validManifest = new Ajv2020({ allErrors: true, strict: false }).compile(manifestSchema);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROOT = /^[A-Za-z0-9_-]{1,160}$/;
const ACCOUNT = /^[^@\s]{1,64}@[^@\s]{1,190}$/;
const ED25519 = /^[A-Za-z0-9+/]{43}=$/;
const body = { type: "object", maxProperties: 12 } as const;
const text = (x: unknown, max: number) => typeof x === "string" ? x.trim().slice(0, max) : "";
const id = (raw: unknown) => UUID.test(String(raw ?? "")) ? String(raw) : fail(404, "No such connector in this company");

export const connectorsOn = () => process.env.PULSE_CONNECTORS === "1";

const ENTITY_WORDS: Record<string, string> = {
  "drive.file.created": "New files", "drive.file.updated": "Changed files", "drive.file.moved": "Moved files",
  "drive.file.renamed": "Renamed files", "drive.file.trashed": "Files moved to the bin", "drive.folder.created": "New folders",
};
const SCOPE_WORDS: Record<string, string> = {
  "https://www.googleapis.com/auth/drive.metadata.readonly": "See file names, folders, sizes and change times (read-only, no contents)",
};
/** What Pulse never takes through a connector, whatever a manifest says. */
export const NEVER = ["file contents or document text", "comments, sharing settings or who a file is shared with",
  "e-mail, calendar, chats or WhatsApp", "another company's files, credentials or settings", "your Google password or the key itself"];
/** What keeps real ingestion closed (owner errands and the server switch). */
export const GATES = [
  { id: "E13", what: "Google: the company's own service account, the selected shared drives or folders, and a Workspace admin's delegation only if a folder in someone's Drive is chosen" },
  { id: "E18", what: "The company's admin, which data belongs to which company, and a separate connector account for each company" },
  { id: "server", what: "The server switch PULSE_CONNECTORS=1 (and PULSE_DRIVE_CHANGES=1 for EA Connect), set by the platform operator after both" },
];

/** Why a manifest is not a valid connector.v1 manifest (empty when it is): the JSON Schema, then each scope and entity
 *  once and every entity's scope requested. The database checks the same lists again (pulse.connector_manifest_ok). */
export function manifestProblems(m: unknown): string[] {
  if (!validManifest(m)) return (validManifest.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || "manifest"} ${e.message ?? "is not valid"}`);
  const man = m as Manifest, scopes = man.scopes.map((s) => s.scope), types = man.entities.map((e) => e.type);
  const out: string[] = [];
  if (new Set(scopes).size !== scopes.length) out.push("scopes: name each scope once");
  if (new Set(types).size !== types.length) out.push("entities: name each entity once");
  for (const t of types) if (!scopes.includes(ENTITY_SCOPES[t])) out.push(`entities: ${t} needs the scope ${ENTITY_SCOPES[t]}`);
  return out;
}

export const ed25519Fingerprint = (key: string) => createHash("sha256").update(`ed25519:${key}`).digest("hex");
const isKey = (key: string) => ED25519.test(key) && Buffer.from(key, "base64").length === 32;

/** The install preview: what the connector asks for and why, what the company admin grants at Google, where its
 *  credential lives, what Pulse never takes, and any problem. Nothing is written. */
export function connectorPreview(input: { implementation: string; manifest?: unknown; publicKey?: string; secretRef?: string; subject?: string }) {
  const plugin = input.implementation === "plugin";
  const problems: string[] = [];
  if (!["ea_connect", "plugin"].includes(input.implementation)) problems.push("Choose EA Connect or your company's own plugin");
  const manifest = (plugin ? input.manifest : EA_CONNECT) as Manifest | undefined;
  const found = manifestProblems(manifest);
  problems.push(...found);
  if (plugin && !found.length && manifest!.transport !== "push") problems.push("Pulse runs only its own readers: a company plugin pushes signed batches (transport push)");
  if (plugin && !isKey(input.publicKey ?? "")) problems.push("Give the plugin's Ed25519 public key (32 bytes, base64)");
  const secretRef = input.secretRef || "ea-connect";
  if (!plugin && !REF.test(secretRef)) problems.push("A credential reference is 1 to 40 lower-case letters, digits or hyphens");
  if (!plugin && input.subject && !ACCOUNT.test(input.subject)) problems.push("The Workspace account to read as is an address like name@company");
  if (found.length || !manifest) return { ok: false, problems };
  const scopes = manifest.scopes.map((s) => ({ scope: s.scope, label: SCOPE_WORDS[s.scope] ?? s.scope, why: s.why }));
  const delegated = !plugin && !!input.subject;
  const grant = plugin ? [
    "Your plugin signs each batch with its own Ed25519 key. Pulse keeps only the public key above, never a secret.",
    "Select the shared drives or folders it may deliver, then approve the entities. Anything else it sends is refused.",
    `It sends batches to POST /v1/connectors/batches on Pulse's ingest service with its install id (contract ${CONNECTOR_CONTRACT}).`,
  ] : [
    "In your company's own Google Cloud project, create a service account for Pulse and one key for it. Hand the key file to your platform operator in person or through your secret store: never by e-mail or chat.",
    "For a shared drive: add the service account's address to it as a Viewer. No Workspace admin is needed.",
    delegated ? `For a folder in someone's Drive: your Workspace admin grants the service account's client ID domain-wide delegation for exactly ${scopes.map((s) => s.scope).join(", ")}. Pulse reads as the Workspace account you named.`
      : "A folder in someone's own Drive also needs your Workspace admin's domain-wide delegation and a Workspace account to read as. Leave it out to use shared drives only.",
    "Select the roots below, then approve with the reference where your approval is recorded. You can revoke at any time; files already read stay.",
  ];
  return {
    ok: problems.length === 0, problems,
    connector: { implementation: plugin ? "plugin" : "ea_connect", key: manifest.key, name: manifest.name, version: manifest.version,
      publisher: manifest.publisher, transport: manifest.transport, auth: manifest.auth },
    scopes, sources: manifest.sources,
    entities: manifest.entities.map((e) => ({ type: e.type, schema: e.schema, label: ENTITY_WORDS[e.type] ?? e.type })),
    credential: plugin ? { kind: "ed25519", id: isKey(input.publicKey ?? "") ? ed25519Fingerprint(input.publicKey!).slice(0, 12) : null }
      : { kind: "google_service_account", ref: secretRef, delegated, where: `your company's own folder of the secret store, as ${secretRef}`,
          installedBy: "the platform operator (pulse-connect secret); only its fingerprint reaches Pulse's database" },
    grant, never: NEVER,
  };
}

/** SQL refusals as plain answers: the database names the reason before a colon ("secret_missing: …"). */
async function sql<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    const words = (err.message ?? "").replace(/^[a-z_]+: /, "");
    const say = (status: number, fallback: string) => fail(status, words || fallback);
    if (err.code === "42501") say(403, "Not allowed");
    if (err.code === "P0002") say(404, "No such connector in this company");
    if (["22023", "22P02", "23514", "23502"].includes(err.code ?? "")) say(400, "Check the details");
    if (["23505", "55000", "40001"].includes(err.code ?? "")) say(409, "Changed meanwhile: look again");
    throw e;
  }
}

type InstallStatus = { id: string; implementation: "ea_connect" | "plugin"; status: string; version: string; proposed: unknown;
  missingScopes: string[]; missingEntities: string[]; credential: { installed: boolean };
  sources: { status: string; cursor: { reading?: boolean; status?: string; errorCode?: string | null; openGaps?: number; refused?: number } | null }[] };

const newer = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** Each install's health in one word, with what a person should do next. */
export function connectorHealth(i: InstallStatus, server: boolean): { health: string; next: string | null } {
  if (i.status === "revoked") return { health: "revoked", next: null };
  if (i.implementation === "ea_connect" && !i.credential.installed) return { health: "needs_secret", next: "The platform operator installs the company's Google key (pulse-connect secret)" };
  if (!i.sources.some((s) => s.status !== "stopped")) return { health: "needs_root", next: "Select a shared drive or folder" };
  if (i.status === "preview") return { health: "needs_grant", next: "Approve the scopes and entities" };
  if (i.proposed || i.sources.some((s) => s.status === "selected")) return { health: "needs_grant", next: i.proposed ? "Approve the new version" : "Approve the new root" };
  if (i.missingEntities.length || i.missingScopes.length) return { health: "partial", next: null };
  if (!server) return { health: "off", next: "Off on this server until the platform operator sets PULSE_CONNECTORS=1" };
  if (i.sources.some((s) => ["access_lost", "error", "cursor_invalid"].includes(s.cursor?.status ?? "") || (s.cursor?.openGaps ?? 0) > 0)) return { health: "attention", next: "A root needs review" };
  return { health: "ok", next: null };
}

export async function connectorsStatus(c: PoolClient) {
  const installs = (await sql(() => c.query("select pulse.connector_status() s"))).rows[0].s as InstallStatus[];
  const server = connectorsOn();
  return installs.map((i) => ({ ...i, ...connectorHealth(i, server),
    upgrade: i.implementation === "ea_connect" && i.status !== "revoked" && !i.proposed && newer(EA_CONNECT.version, i.version) ? EA_CONNECT.version : null }));
}

/** The Settings card. */
export function connectorsCard(installs: { status: string; health: string }[]) {
  const live = installs.filter((i) => i.status !== "revoked");
  const base = { key: "connectors", label: "Company connectors" };
  if (!live.length) return { ...base, state: "planned" as const, lastAt: null,
    detail: "None installed. Your admin can install EA Connect or your company's own plugin, with your company's own Google access." };
  const ok = live.filter((i) => i.health === "ok").length, open = live.length - ok;
  return { ...base, state: open ? "attention" as const : "connected" as const, lastAt: null,
    detail: `${live.length} installed, ${ok} reading${open ? `, ${open} waiting for a step` : ""}.` };
}

export function registerConnectorRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const must = (v: Viewer, write = false) => {
    if (!admin(v)) fail(403, "Company admins manage connectors");
    if (v.nativeDevice) fail(403, "Open Pulse to do this");
    if (write && !v.person) fail(403, "A shared login cannot change connectors");
  };

  /** Every connector of this company with its grants, credential reference and roots; EA Connect's preview. */
  app.get("/api/v0/connectors", req => tx(req, async (c, v) => {
    must(v);
    return { contract: CONNECTOR_CONTRACT, server: connectorsOn(), driveChanges: driveChangesOn(), gates: GATES,
      installs: await connectorsStatus(c), eaConnect: connectorPreview({ implementation: "ea_connect" }) };
  }));

  /** What installing would ask for and grant; nothing is written. */
  app.post<{ Body: Body }>("/api/v0/connectors/preview", { schema: { body } }, req => tx(req, async (_c, v) => {
    must(v);
    const b = req.body;
    return connectorPreview({ implementation: text(b.implementation, 20), manifest: b.manifest, publicKey: text(b.publicKey, 60),
      secretRef: text(b.secretRef, 40), subject: text(b.subject, 260).toLowerCase() });
  }));

  /** Install for this company (status preview: nothing is read until the admin approves). */
  app.post<{ Body: Body }>("/api/v0/connectors", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v, true);
    const b = req.body, implementation = text(b.implementation, 20);
    const input = { implementation, manifest: b.manifest, publicKey: text(b.publicKey, 60), secretRef: text(b.secretRef, 40), subject: text(b.subject, 260).toLowerCase() };
    const preview = connectorPreview(input);
    if (!preview.ok || !("connector" in preview)) fail(400, preview.problems[0] ?? "Check the details");
    const plugin = implementation === "plugin";
    const label = text(b.label, 80) || (plugin ? (b.manifest as Manifest).name : EA_CONNECT.name);
    const created = (await sql(() => c.query("select pulse.connector_create($1) id", [JSON.stringify({
      implementation, label, manifest: plugin ? b.manifest : EA_CONNECT, secretRef: plugin ? null : input.secretRef || "ea-connect",
      subject: plugin ? null : input.subject || null, publicKey: plugin ? input.publicKey : null })]))).rows[0].id as string;
    return { id: created, preview };
  }));

  /** Select a root of the company's own Drive and the entities it may carry. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/connectors/:id/sources", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v, true);
    const kind = text(req.body.kind, 20), ref = text(req.body.ref, 160), label = text(req.body.label, 80);
    if (!["shared_drive", "folder"].includes(kind)) fail(400, "Choose a shared drive or a folder");
    if (!ROOT.test(ref)) fail(400, "Give the shared drive's or folder's id from its Google Drive address");
    if (label.length < 2) fail(400, "Give the root a name of 2 to 80 characters");
    const entities = Array.isArray(req.body.entities) ? req.body.entities.map((e) => text(e, 80)) : undefined;
    const sid = (await sql(() => c.query("select pulse.connector_source_add($1,$2) id", [id(req.params.id), JSON.stringify({ kind, ref, label, entities })]))).rows[0].id;
    return { id: sid };
  }));

  /** The company admin's grant, with where it is recorded. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/connectors/:id/approve", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v, true);
    const list = (x: unknown) => Array.isArray(x) ? x.map((e) => text(e, 120)) : [];
    return (await sql(() => c.query("select pulse.connector_approve($1,$2) r", [id(req.params.id),
      JSON.stringify({ scopes: list(req.body.scopes), entities: list(req.body.entities), approvalRef: text(req.body.approvalRef, 200) })]))).rows[0].r;
  }));

  /** A new manifest version waits for the admin's grant (EA Connect: Pulse's current one; a plugin: its new manifest). */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/connectors/:id/upgrade", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v, true);
    const install = id(req.params.id);
    const kind = (await sql(() => c.query("select pulse.connector_status() s"))).rows[0].s.find((i: { id: string }) => i.id === install)?.implementation;
    if (!kind) fail(404, "No such connector in this company");
    const manifest = kind === "ea_connect" ? EA_CONNECT : req.body.manifest;
    const problems = manifestProblems(manifest);
    if (problems.length) fail(400, problems[0]);
    return (await sql(() => c.query("select pulse.connector_propose($1,$2) r", [install, JSON.stringify(manifest)]))).rows[0].r;
  }));

  /** Stop the connector for good: nothing more is read or accepted; what was read stays. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/connectors/:id/revoke", { schema: { body } }, req => tx(req, async (c, v) => {
    must(v, true);
    return (await sql(() => c.query("select pulse.connector_revoke($1,$2) r", [id(req.params.id), text(req.body.reason, 300)]))).rows[0].r;
  }));
}
