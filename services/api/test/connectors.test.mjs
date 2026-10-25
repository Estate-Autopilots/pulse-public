// R52: the connector.v1 contract's pure parts: manifests checked like the database does, EA Connect's install preview
// (what it asks for, what the company grants at Google, where its credential lives, what Pulse never takes) and each
// install's health in one word. No database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EA_CONNECT, NEVER, batchSchema, connectorHealth, connectorPreview, connectorsCard, ed25519Fingerprint, manifestProblems, manifestSchema } from "../dist/connectors.js";

const META = "https://www.googleapis.com/auth/drive.metadata.readonly";
const KEY = Buffer.alloc(32, 7).toString("base64");
const plugin = (over = {}) => ({ contract: "connector.v1", key: "acme-sync", name: "Synthetic plugin", version: "1.0.0", publisher: "Synthetic Co",
  transport: "push", auth: "signed_push", scopes: [{ scope: META, why: "Synthetic: read file metadata of approved folders" }],
  sources: ["folder"], entities: [{ type: "drive.file.created", schema: 1 }], ...over });

test("EA Connect's manifest is a valid connector.v1 manifest asking for metadata only", () => {
  assert.deepEqual(manifestProblems(EA_CONNECT), []);
  assert.deepEqual([EA_CONNECT.key, EA_CONNECT.transport, EA_CONNECT.auth], ["ea-connect", "pull", "google_service_account"]);
  assert.deepEqual(EA_CONNECT.scopes.map((s) => s.scope), [META]);
  assert.equal(manifestSchema.additionalProperties, false);
  assert.equal(batchSchema.additionalProperties, false);
  assert.ok(!("org" in batchSchema.properties) && !("orgId" in batchSchema.properties) && !("tenant" in batchSchema.properties));
});

test("bad manifests are refused with a reason", () => {
  const cases = {
    unknownEntity: plugin({ entities: [{ type: "mail.message.sent", schema: 1 }] }),
    schemaTwo: plugin({ entities: [{ type: "drive.file.created", schema: 2 }] }),
    broaderScope: plugin({ scopes: [{ scope: "https://www.googleapis.com/auth/drive", why: "Synthetic: everything please" }] }),
    pushWithGoogle: plugin({ auth: "google_service_account" }),
    namesCompany: plugin({ orgId: "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75" }),
    twice: plugin({ entities: [{ type: "drive.file.created", schema: 1 }, { type: "drive.file.created", schema: 1 }] }),
    scopeTwice: plugin({ scopes: [{ scope: META, why: "Synthetic: read metadata one" }, { scope: META, why: "Synthetic: read metadata two" }] }),
  };
  for (const [name, m] of Object.entries(cases)) assert.ok(manifestProblems(m).length, name);
  assert.deepEqual(manifestProblems(plugin()), []);
});

test("the EA Connect preview says what is granted at Google and where the credential lives, without secrets", () => {
  const p = connectorPreview({ implementation: "ea_connect" });
  assert.equal(p.ok, true);
  assert.deepEqual(p.credential, { kind: "google_service_account", ref: "ea-connect", delegated: false,
    where: "your company's own folder of the secret store, as ea-connect", installedBy: "the platform operator (pulse-connect secret); only its fingerprint reaches Pulse's database" });
  assert.match(p.grant.join(" "), /add the service account's address to it as a Viewer/);
  assert.match(p.grant.join(" "), /never by e-mail or chat/);
  assert.deepEqual(p.never, NEVER);
  assert.equal(p.entities.length, 6);
  const delegated = connectorPreview({ implementation: "ea_connect", subject: "reader@company.example", secretRef: "acme-drive" });
  assert.equal(delegated.credential.delegated, true);
  assert.match(delegated.grant.join(" "), /domain-wide delegation for exactly https:\/\/www.googleapis.com\/auth\/drive.metadata.readonly/);
  assert.equal(JSON.stringify(delegated).includes("reader@company.example"), false, "the account is not echoed");
  assert.deepEqual(connectorPreview({ implementation: "ea_connect", secretRef: "Bad Ref" }).problems, ["A credential reference is 1 to 40 lower-case letters, digits or hyphens"]);
});

test("a plugin preview needs a push manifest and a real Ed25519 public key", () => {
  const ok = connectorPreview({ implementation: "plugin", manifest: plugin(), publicKey: KEY });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.credential, { kind: "ed25519", id: ed25519Fingerprint(KEY).slice(0, 12) });
  assert.match(ok.grant.join(" "), /POST \/v1\/connectors\/batches/);
  assert.equal(connectorPreview({ implementation: "plugin", manifest: plugin(), publicKey: "short" }).ok, false);
  assert.equal(connectorPreview({ implementation: "plugin", manifest: { ...EA_CONNECT }, publicKey: KEY }).ok, false, "a plugin cannot be a puller");
  assert.equal(connectorPreview({ implementation: "plugin", manifest: plugin({ version: "one" }), publicKey: KEY }).ok, false);
  assert.equal(connectorPreview({ implementation: "something" }).ok, false);
});

test("each install's health says what to do next", () => {
  const base = { id: "i", implementation: "ea_connect", status: "active", version: "1.0.0", proposed: null, missingScopes: [], missingEntities: [],
    credential: { installed: true }, sources: [{ status: "approved", cursor: { reading: true, status: "ok", openGaps: 0 } }] };
  assert.equal(connectorHealth(base, true).health, "ok");
  assert.equal(connectorHealth(base, false).health, "off");
  assert.equal(connectorHealth({ ...base, credential: { installed: false } }, true).health, "needs_secret");
  assert.equal(connectorHealth({ ...base, sources: [] }, true).health, "needs_root");
  assert.equal(connectorHealth({ ...base, status: "preview" }, true).health, "needs_grant");
  assert.equal(connectorHealth({ ...base, proposed: { version: "1.1.0" } }, true).next, "Approve the new version");
  assert.equal(connectorHealth({ ...base, missingEntities: ["drive.file.trashed"] }, true).health, "partial");
  assert.equal(connectorHealth({ ...base, sources: [{ status: "approved", cursor: { status: "access_lost" } }] }, true).health, "attention");
  assert.equal(connectorHealth({ ...base, status: "revoked" }, true).health, "revoked");
  assert.equal(connectorHealth({ ...base, implementation: "plugin", credential: { installed: true } }, true).health, "ok");
  assert.equal(connectorsCard([]).state, "planned");
  assert.equal(connectorsCard([{ status: "revoked", health: "revoked" }]).state, "planned");
  assert.deepEqual([connectorsCard([{ status: "active", health: "ok" }, { status: "preview", health: "needs_grant" }]).state, connectorsCard([{ status: "active", health: "ok" }]).state], ["attention", "connected"]);
});
