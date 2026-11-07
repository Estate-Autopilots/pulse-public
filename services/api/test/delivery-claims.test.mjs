import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const PERSON = "00000000-0000-0000-0000-000000000001";
const REPORT = "00000000-0000-0000-0000-000000000002";
const DELIVERY = "synthetic-drive-file-001";
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const CLAIM = "00000000-0000-0000-0000-000000000010";
const baseClaim = { id: CLAIM, deliveryId: DELIVERY, personId: REPORT, status: "pending", creditedVia: "claim",
  createdAt: "2026-10-06T09:00:00.000Z" };

function appFor({ role = "person", person = PERSON, manages = true, claimPersonId = REPORT, claimRows = [baseClaim] } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const normalized = sql.trim().toLowerCase();
      if (normalized === "begin" || normalized === "commit" || normalized === "rollback" || sql.includes("set_config")) return { rows: [] };
      if (sql.includes("pulse.auth_enforcement")) return { rows: [{ blocked: false }] };
      if (sql.includes("select p.id person,p.display_name name")) {
        return { rows: [{ person, name: "Synthetic Viewer", status: "active", pod: "Synthetic Pod", username: "viewer",
          accounts: ["viewer@example.test"], roles: [role] }] };
      }
      if (sql.includes("to_date($1,'IYYY-\"W\"IW')")) return { rows: [{ valid: true, monday: "2026-10-05" }] };
      if (sql.includes("from pulse.delivery d join pulse.index_file f")) return { rows: [
        { id: DELIVERY, projectName: "Synthetic Project", fileName: "walkthrough-final.mp4", kind: "final",
          deliveredAt: "2026-10-06T09:00:00.000Z" },
      ] };
      if (sql.includes("from pulse.delivery_claim claim join pulse.delivery delivery")) return { rows: claimRows.map(row => ({
        ...row, personName: "Synthetic Editor", projectName: "Synthetic Project", fileName: "walkthrough-final.mp4",
        kind: "final", deliveredAt: "2026-10-06T09:00:00.000Z",
      })) };
      if (sql.includes("insert into pulse.delivery_claim(org_id,file_id,person_id)")) {
        return { rows: [{ ...baseClaim, personId: params[2] }] };
      }
      if (sql.includes("select id \"id\",person_id \"personId\" from pulse.delivery_claim")) {
        return { rows: [{ id: CLAIM, personId: claimPersonId }] };
      }
      if (sql.includes("select pulse.manages($1) ok")) return { rows: [{ ok: manages }] };
      if (sql.includes("update pulse.delivery_claim set status=$3")) return { rows: [{ ...baseClaim, status: params[2],
        decidedBy: params[3], decidedAt: "2026-10-07T09:00:00.000Z" }] };
      if (sql.includes("pulse.audit_write")) return { rows: [] };
      if (sql.includes("insert into privacy.access_log")) return { rows: [] };
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      throw new Error(`Unexpected synthetic API query: ${sql}`);
    },
    release() {},
  };
  return { app: createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, { connect: async () => client }), calls };
}

test("claimable deliveries are scoped to the editor's work projects and shared accounts", async () => {
  const { app, calls } = appFor();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/deliveries/claimable?week=2026-W41",
      headers: { "cf-access-authenticated-user-email": "editor@example.test" } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { week: "2026-W41", deliveries: [{ id: DELIVERY, projectName: "Synthetic Project",
      fileName: "walkthrough-final.mp4", kind: "final", deliveredAt: "2026-10-06T09:00:00.000Z" }] });
    const query = calls.find(({ sql }) => sql.includes("from pulse.delivery d join pulse.index_file f"));
    assert.match(query.sql, /a\.is_shared/);
    assert.match(query.sql, /pulse\.work_projects\(\)/);
    assert.match(query.sql, /pulse\.delivery_claim_taken\(d\.file_id\)/);
    assert.ok(calls.some(({ sql }) => sql.includes("insert into privacy.access_log")));
  } finally { await app.close(); }
});

test("claim identity comes from the signed-in person, never from a submitted person ID", async () => {
  const { app, calls } = appFor();
  try {
    const response = await app.inject({ method: "POST", url: `/v1/deliveries/${DELIVERY}/claim`,
      headers: { "cf-access-authenticated-user-email": "editor@example.test", "content-type": "application/json" },
      payload: { personId: REPORT } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "pending");
    assert.equal(response.json().personId, PERSON);
    const insert = calls.find(({ sql }) => sql.includes("insert into pulse.delivery_claim(org_id,file_id,person_id)"));
    assert.deepEqual(insert.params, [ORG, DELIVERY, PERSON]);
    assert.match(insert.sql, /a\.is_shared/);
  } finally { await app.close(); }
});

test("only managers and admins can read the pending report-claim queue", async () => {
  const member = appFor();
  try {
    const response = await member.app.inject({ method: "GET", url: "/v1/deliveries/claims?week=2026-W41&status=pending",
      headers: { "cf-access-authenticated-user-email": "editor@example.test" } });
    assert.equal(response.statusCode, 403);
  } finally { await member.app.close(); }

  const manager = appFor({ role: "manager", person: REPORT });
  try {
    const response = await manager.app.inject({ method: "GET", url: "/v1/deliveries/claims?week=2026-W41&status=pending",
      headers: { "cf-access-authenticated-user-email": "manager@example.test" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().claims[0].personName, "Synthetic Editor");
    const query = manager.calls.find(({ sql }) => sql.includes("from pulse.delivery_claim claim join pulse.delivery delivery"));
    assert.match(query.sql, /claim\.claim_scope='delivery'/);
    assert.ok(manager.calls.some(({ sql, params }) => sql.includes("insert into privacy.access_log") && params[2] === REPORT));
  } finally { await manager.app.close(); }
});

test("a report manager can confirm a claim and the decision is audited", async () => {
  const { app, calls } = appFor({ role: "manager", person: PERSON });
  try {
    const response = await app.inject({ method: "POST", url: `/v1/deliveries/${DELIVERY}/claim/decide`,
      headers: { "cf-access-authenticated-user-email": "manager@example.test", "content-type": "application/json" },
      payload: { decision: "confirmed" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "confirmed");
    const audit = calls.find(({ sql }) => sql.includes("pulse.audit_write"));
    assert.deepEqual(audit.params, ["delivery_claim.confirmed", CLAIM, ["status", "credited_via"]]);
  } finally { await app.close(); }
});

test("nobody can decide their own claim", async () => {
  const { app, calls } = appFor({ role: "manager", person: REPORT, claimPersonId: REPORT });
  try {
    const response = await app.inject({ method: "POST", url: `/v1/deliveries/${DELIVERY}/claim/decide`,
      headers: { "cf-access-authenticated-user-email": "manager@example.test", "content-type": "application/json" },
      payload: { decision: "rejected", reason: "Synthetic self-decision attempt" } });
    assert.equal(response.statusCode, 403);
    assert.equal(calls.some(({ sql }) => sql.includes("pulse.audit_write")), false);
  } finally { await app.close(); }
});
