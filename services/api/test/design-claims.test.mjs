import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
const MANAGER = "00000000-0000-0000-0000-000000000003";
const FILE = "synthetic-design-export-001";
const CLAIM = "00000000-0000-0000-0000-000000000010";
const targets = { designers: { roles: ["graphic designer"] } };
const rules = { design_type_rules: { folder_path: [{ match: "single image", type: "single_image_ad" }] } };

function appFor({ person = A, role = "person", profileRole = "Graphic Designer", manages = true, state = {} } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const q = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(q) || sql.includes("set_config")) return { rows: [] };
      if (sql.includes("select p.id person,p.display_name name")) return { rows: [{
        person, name: "Synthetic Viewer", status: "active", pod: "Synthetic Pod", username: "viewer",
        accounts: ["viewer@example.test"], roles: [role],
      }] };
      if (sql.includes("pulse.auth_enforcement")) return { rows: [{ blocked: false }] };
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      if (sql.includes("doc_key='designers'")) return { rows: [{ body: targets }] };
      if (sql.includes("doc_kind='folder_rules'")) return { rows: [{ body: rules }] };
      if (sql.includes("join pulse.people_profile profile")) return {
        rows: profileRole.toLowerCase() === "graphic designer" ? [{ one: 1 }] : [],
      };
      if (sql.includes("to_date($1")) {
        return { rows: [{ valid: true, monday: "2026-10-05" }] };
      }
      if (sql.includes("from pulse.delivery_claim claim join pulse.index_file file")) {
        return { rows: state.claim ? [{ id: CLAIM, designId: FILE, personId: A, personName: "Designer A",
          projectName: "Synthetic Project", fileName: "single-image.png", path: "Creative/single image",
          mime: "image/png", uploadedAt: "2026-10-06T09:00:00.000Z", status: "pending", creditedVia: "claim",
          createdAt: "2026-10-06T10:00:00.000Z", hasDelivery: false }] : [] };
      }
      if (sql.includes('select f.name "fileName"') && sql.includes("pulse.design_claim_allowed")) {
        const file = state.claimFile ?? { fileName: "single-image.png", path: "Creative/single image", mime: "image/png", hasDelivery: false };
        return { rows: state.claim ? [] : [file] };
      }
      if (q.includes("from pulse.index_file f") && q.includes("hasdelivery")) {
        const pendingForViewer = state.claim?.personId === person;
        return { rows: [
          { id: FILE, projectName: "Synthetic Project", fileName: "single-image.png", path: "Creative/single image",
            mime: "image/png", uploadedAt: "2026-10-06T09:00:00.000Z", hasDelivery: false,
            status: pendingForViewer ? "pending" : "claimable" },
          { id: "synthetic-classified-by-delivery", projectName: "Synthetic Project", fileName: "unknown.png",
            path: "Archive", mime: "image/png", uploadedAt: "2026-10-06T08:00:00.000Z", hasDelivery: true,
            status: "claimable" },
          { id: "synthetic-uncounted", projectName: "Synthetic Project", fileName: "unknown.png", path: "Archive",
            mime: "image/png", uploadedAt: "2026-10-06T07:00:00.000Z", hasDelivery: false, status: "claimable" },
        ].filter(file => file.id !== FILE || !state.claim || pendingForViewer) };
      }
      if (sql.includes("insert into pulse.delivery_claim(org_id,file_id,person_id,claim_scope)")) {
        if (state.claim) return { rows: [] };
        state.claim = { personId: params[2] };
        return { rows: [{ id: CLAIM, designId: FILE, personId: params[2], status: "pending", creditedVia: "claim",
          createdAt: "2026-10-06T10:00:00.000Z" }] };
      }
      if (sql.includes('select id "id",person_id "personId" from pulse.delivery_claim')) {
        return { rows: [{ id: CLAIM, personId: B }] };
      }
      if (sql.includes("select pulse.manages($1) ok")) return { rows: [{ ok: manages }] };
      if (sql.includes("update pulse.delivery_claim set status=$3")) return { rows: [{ id: CLAIM, designId: FILE,
        personId: B, status: params[2], creditedVia: "claim", createdAt: "2026-10-06T10:00:00.000Z" }] };
      if (sql.includes("pulse.audit_write") || sql.includes("insert into privacy.access_log")) return { rows: [] };
      if (sql.includes("doc_key='modules'")) return { rows: [] }; // no modules document: every module on
      throw new Error(`Unexpected synthetic API query: ${sql}`);
    },
    release() {},
  };
  return { app: createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, { connect: async () => client }), calls };
}

const headers = email => ({ "cf-access-authenticated-user-email": email, "content-type": "application/json" });

test("designer A claims a shared-login export and designer B cannot see or claim it", async () => {
  const state = {};
  const a = appFor({ person: A, state });
  const b = appFor({ person: B, state });
  try {
    const claim = await a.app.inject({ method: "POST", url: `/v1/designs/${FILE}/claim`, headers: headers("a@example.test"), payload: {} });
    assert.equal(claim.statusCode, 200);
    assert.deepEqual(claim.json(), { id: CLAIM, designId: FILE, personId: A, status: "pending", creditedVia: "claim",
      createdAt: "2026-10-06T10:00:00.000Z" });
    const insert = a.calls.find(({ sql }) => sql.includes("insert into pulse.delivery_claim(org_id,file_id,person_id,claim_scope)"));
    assert.deepEqual(insert.params, [ORG, FILE, A]);
    assert.match(insert.sql, /pulse\.design_claim_allowed/);
    const ownReload = await a.app.inject({ method: "GET", url: "/v1/designs/claimable?week=2026-W41", headers: headers("a@example.test") });
    assert.equal(ownReload.statusCode, 200);
    const ownClaim = ownReload.json().designs.find(design => design.id === FILE);
    assert.equal(ownClaim.status, "pending");
    assert.equal(ownReload.json().designs.filter(design => design.status === "claimable").length, 1);
    const visible = await b.app.inject({ method: "GET", url: "/v1/designs/claimable?week=2026-W41", headers: headers("b@example.test") });
    assert.equal(visible.statusCode, 200);
    assert.equal(visible.json().designs.some(design => design.id === FILE), false);
    assert.equal(visible.json().designs.every(design => design.status === "claimable"), true);
    const second = await b.app.inject({ method: "POST", url: `/v1/designs/${FILE}/claim`, headers: headers("b@example.test"), payload: {} });
    assert.equal(second.statusCode, 409);
  } finally { await a.app.close(); await b.app.close(); }
});

test("claim rejects design files that the designer counts do not surface", async () => {
  const misc = appFor({ state: { claimFile: { fileName: "x.png", path: "Misc", mime: "image/png", hasDelivery: false } } });
  try {
    const response = await misc.app.inject({ method: "POST", url: "/v1/designs/synthetic-misc-x.png/claim",
      headers: headers("designer@example.test"), payload: {} });
    assert.equal(response.statusCode, 409);
    assert.equal(misc.calls.some(({ sql }) => sql.includes("insert into pulse.delivery_claim(org_id,file_id,person_id,claim_scope)")), false);
  } finally { await misc.app.close(); }
});

test("claimable queue follows designer target roles and excludes uncounted types", async () => {
  const designer = appFor();
  try {
    const response = await designer.app.inject({ method: "GET", url: "/v1/designs/claimable?week=2026-W41",
      headers: headers("designer@example.test") });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { week: "2026-W41", designs: [{ id: FILE, projectName: "Synthetic Project",
      fileName: "single-image.png", type: "single_image_ad", uploadedAt: "2026-10-06T09:00:00.000Z", status: "claimable" },
    { id: "synthetic-classified-by-delivery", projectName: "Synthetic Project", fileName: "unknown.png", type: "other",
      uploadedAt: "2026-10-06T08:00:00.000Z", status: "claimable" }] });
    const query = designer.calls.find(({ sql }) => sql.includes("from pulse.index_file f") && sql.includes("hasDelivery"));
    assert.match(query.sql, /account\.is_shared/);
    assert.match(query.sql, /account_basis='last modifying account'/);
    assert.match(query.sql, /delivery-attribution\/v1/);
    assert.match(query.sql, /pulse\.delivery_claim_taken/);
    const access = designer.calls.find(({ sql, params }) => sql.includes("privacy.access_log") && params[4] === "design_delivery_claim");
    assert.ok(access);
    assert.equal(Object.hasOwn(response.json().designs[0], "uploader"), false);
  } finally { await designer.app.close(); }

  const nonDesigner = appFor({ profileRole: "Video editor" });
  try {
    const response = await nonDesigner.app.inject({ method: "GET", url: "/v1/designs/claimable?week=2026-W41",
      headers: headers("editor@example.test") });
    assert.equal(response.statusCode, 403);
  } finally { await nonDesigner.app.close(); }
});

test("manager design claims are access logged per claimant and retain design metadata", async () => {
  const manager = appFor({ person: MANAGER, role: "manager", state: { claim: true } });
  try {
    const response = await manager.app.inject({ method: "GET", url: "/v1/designs/claims?week=2026-W41&status=pending",
      headers: headers("manager@example.test") });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().claims[0].designId, FILE);
    assert.equal(response.json().claims[0].type, "single_image_ad");
    assert.ok(manager.calls.some(({ sql, params }) => sql.includes("privacy.access_log") && params[2] === A
      && params[4] === "design_delivery_claim_review"));
  } finally { await manager.app.close(); }
});

test("a manager can decide a design file claim by file id, but another team's manager is refused", async () => {
  const manager = appFor({ person: MANAGER, role: "manager" });
  try {
    const response = await manager.app.inject({ method: "POST", url: `/v1/deliveries/${FILE}/claim/decide`,
      headers: headers("manager@example.test"), payload: { decision: "confirmed" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "confirmed");
  } finally { await manager.app.close(); }

  const other = appFor({ person: MANAGER, role: "manager", manages: false });
  try {
    const response = await other.app.inject({ method: "POST", url: `/v1/deliveries/${FILE}/claim/decide`,
      headers: headers("other-manager@example.test"), payload: { decision: "confirmed" } });
    assert.equal(response.statusCode, 403);
    assert.equal(other.calls.some(({ sql }) => sql.includes("update pulse.delivery_claim set status=$3")), false);
  } finally { await other.app.close(); }
});
