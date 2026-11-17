import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const PERSON = "00000000-0000-0000-0000-000000000001";
const REPORT = "00000000-0000-0000-0000-000000000002";
const ACCOUNT = "00000000-0000-0000-0000-000000000003";
const CLAIM = "00000000-0000-0000-0000-000000000004";
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const baseAccount = { id: ACCOUNT, handle: "designer@external.example", isShared: false,
  holderPersonId: null, clientEvidence: false, hasDeliveries: true, hasOtherPersonLink: false };
const baseClaim = { id: CLAIM, accountId: ACCOUNT, personId: REPORT, handle: baseAccount.handle,
  isShared: false, holderPersonId: null, clientEvidence: false, status: "pending",
  hasDeliveries: true, hasOtherPersonLink: false, createdAt: "2026-10-07T09:00:00.000Z" };

function appFor({ role = "person", person = PERSON, manages = true, account = baseAccount,
  claim = baseClaim, claims = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (["begin", "commit", "rollback"].includes(sql.trim().toLowerCase()) || sql.includes("set_config")) return { rows: [] };
      if (sql.includes("select p.id person,p.display_name name")) return { rows: [{
        person, name: "Synthetic Viewer", status: "active", pod: "Synthetic Pod", username: "viewer",
        accounts: ["viewer@example.test"], roles: [role],
      }] };
      if (sql.includes("pulse.auth_enforcement")) return { rows: [{ blocked: false }] };
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      if (sql.includes("select 1 from pulse.person where org_id=$1")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("where org_id=$1 and account_id=$2 and status='pending'"))
        return { rows: [{ personId: claim.personId }] };
      if (sql.includes("from pulse.account a join pulse.delivery d")) return { rows: [{
        id: ACCOUNT, handle: baseAccount.handle, deliveryCount: 3, lastDelivery: "2026-10-07T09:00:00.000Z",
      }] };
      if (sql.includes("for update of claim")) {
        const wantConfirmed = sql.includes("claim.status='confirmed'");
        return { rows: [wantConfirmed ? { ...claim, status: "confirmed", holderPersonId: REPORT } : claim] };
      }
      if (sql.includes("from pulse.account a where a.org_id=$1 and a.id=$2")) return { rows: [account] };
      if (sql.includes("from pulse.account_claim claim") && sql.includes("claimant.display_name")) return { rows: claims };
      if (sql.includes("insert into pulse.account_claim")) return { rows: [{ ...baseClaim, personId: params[2] }] };
      if (sql.includes("update pulse.account_claim set status=$3")) return { rows: [{ ...claim, status: params[2],
        decidedBy: params[3], decidedAt: "2026-10-07T10:00:00.000Z", reason: params[4] }] };
      if (sql.includes("update pulse.account_claim set status='reverted'")) return { rows: [{ ...claim, status: "reverted",
        decidedBy: params[2], decidedAt: "2026-10-07T10:00:00.000Z" }] };
      if (sql.includes("select pulse.manages($1) ok")) return { rows: [{ ok: manages }] };
      if (sql.includes("update pulse.account set holder_person_id=$1")) return { rows: [{ holder_person_id: REPORT }] };
      if (sql.includes("update pulse.account set holder_person_id=null")) return { rows: [{ holder_person_id: null }] };
      if (sql.includes("pulse.audit_write") || sql.includes("privacy.access_log") || sql.includes("pulse.identity_link")) return { rows: [] };
      throw new Error("Unexpected synthetic API query: " + sql);
    },
    release() {},
  };
  return { app: createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, { connect: async () => client }), calls };
}

const headers = email => ({ "cf-access-authenticated-user-email": email, "content-type": "application/json" });

test("claimable accounts are limited to the viewer's work projects and client evidence is filtered", async () => {
  const { app, calls } = appFor();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/accounts/claimable",
      headers: headers("editor@example.test") });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().accounts[0].deliveryCount, 3);
    const query = calls.find(({ sql }) => sql.includes("from pulse.account a join pulse.delivery d"));
    assert.match(query.sql, /pulse\.work_projects\(\)/);
    assert.match(query.sql, /account_claim/);
    assert.match(query.sql, /workspace%/i);
    assert.match(query.sql, /pulse\.contact_profile/);
    assert.match(query.sql, /il\.entity_id<>\$2/);
    assert.ok(calls.some(({ sql, params }) => sql.includes("privacy.access_log") && params[2] === null));
  } finally { await app.close(); }
});

test("staff claim only an unlinked, non-shared, non-client uploader account as themselves", async () => {
  const { app, calls } = appFor();
  try {
    const response = await app.inject({ method: "POST", url: "/v1/accounts/" + ACCOUNT + "/claim",
      headers: headers("editor@example.test"), payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "pending");
    assert.equal(response.json().personId, PERSON);
    const insert = calls.find(({ sql }) => sql.includes("insert into pulse.account_claim"));
    assert.deepEqual(insert.params, [ORG, ACCOUNT, PERSON]);
    const eligibility = calls.find(({ sql }) => sql.includes("from pulse.account a where a.org_id=$1 and a.id=$2"));
    assert.match(eligibility.sql, /pulse\.client/);
    assert.match(eligibility.sql, /pulse\.identity_link/);
    assert.match(eligibility.sql, /workspace%/i);
    assert.match(eligibility.sql, /pulse\.contact_profile/);
    assert.doesNotMatch(eligibility.sql, /for update/i);
  } finally { await app.close(); }
});

test("shared or client-associated accounts remain unclaimable", async () => {
  for (const account of [{ ...baseAccount, isShared: true }, { ...baseAccount, clientEvidence: true }]) {
    const { app, calls } = appFor({ account });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/accounts/" + ACCOUNT + "/claim",
        headers: headers("editor@example.test"), payload: {} });
      assert.equal(response.statusCode, 409);
      assert.equal(calls.some(({ sql }) => sql.includes("insert into pulse.account_claim")), false);
    } finally { await app.close(); }
  }
});

test("an account linked to another person cannot be claimed or confirmed", async () => {
  for (const action of ["claim", "confirm"]) {
    const deciding = action === "confirm";
    const { app, calls } = appFor({ account: { ...baseAccount, hasOtherPersonLink: true },
      claim: { ...baseClaim, hasOtherPersonLink: true }, role: deciding ? "manager" : "person",
      person: deciding ? "00000000-0000-0000-0000-000000000005" : PERSON });
    try {
      const response = await app.inject({ method: "POST", url: `/v1/accounts/${ACCOUNT}/claim${deciding ? "/decide" : ""}`,
        headers: headers(deciding ? "manager@example.test" : "editor@example.test"),
        payload: deciding ? { decision: "confirmed" } : {} });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /linked to another person/i);
      assert.equal(calls.some(({ sql }) => sql.includes("insert into pulse.account_claim")), false);
      assert.equal(calls.some(({ sql }) => sql.includes("update pulse.account_claim set status=$3")), false);
    } finally { await app.close(); }
  }
});

test("an authorized manager may reject an ambiguous claim without changing account identity", async () => {
  const manager = "00000000-0000-0000-0000-000000000005";
  const { app, calls } = appFor({ role: "manager", person: manager,
    claim: { ...baseClaim, hasOtherPersonLink: true } });
  try {
    const response = await app.inject({ method: "POST", url: `/v1/accounts/${ACCOUNT}/claim/decide`,
      headers: headers("manager@example.test"), payload: { decision: "rejected", reason: "Conflicting identity" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "rejected");
    assert.equal(response.json().reason, "Conflicting identity");
    assert.ok(calls.some(({ sql, params }) => sql.includes("update pulse.account_claim set status=$3")
      && params[2] === "rejected"));
    assert.ok(calls.some(({ sql, params }) => sql.includes("pulse.audit_write")
      && params[0] === "account_claim.rejected"));
    assert.equal(calls.some(({ sql }) => sql.includes("insert into pulse.identity_link")
      || sql.includes("update pulse.identity_link")), false);
    assert.equal(calls.some(({ sql }) => sql.includes("update pulse.account set holder_person_id")), false);
  } finally { await app.close(); }
});

test("staff see their own claim list and reads are logged", async () => {
  const { app, calls } = appFor({ claims: [{ ...baseClaim, personId: PERSON, personName: "Synthetic Viewer" }] });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/accounts/claims",
      headers: headers("editor@example.test") });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().claims[0].personId, PERSON);
    const query = calls.find(({ sql }) => sql.includes("claimant.display_name"));
    assert.match(query.sql, /claim\.person_id=\$2/);
    assert.ok(calls.some(({ sql, params }) => sql.includes("privacy.access_log") && params[2] === PERSON));
  } finally { await app.close(); }
});

test("a manager confirms a claim, links the account, and audits the decision", async () => {
  const { app, calls } = appFor({ role: "manager", person: "00000000-0000-0000-0000-000000000005" });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/accounts/" + ACCOUNT + "/claim/decide",
      headers: headers("manager@example.test"), payload: { decision: "confirmed" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "confirmed");
    const link = calls.find(({ sql }) => sql.includes("insert into pulse.identity_link"));
    assert.match(link.sql, /'account_claim'/);
    assert.deepEqual(link.params, [ORG, REPORT, "google:" + baseAccount.handle, baseAccount.handle,
      "00000000-0000-0000-0000-000000000005"]);
    assert.ok(calls.some(({ sql }) => sql.includes("update pulse.account set holder_person_id")));
    const accountUpdate = calls.find(({ sql }) => sql.includes("update pulse.account set holder_person_id=$1"));
    assert.match(accountUpdate.sql, /holder_person_id is null and not is_shared/);
    const decideSelect = calls.find(({ sql }) => sql.includes("claim.status='pending'"));
    assert.match(decideSelect.sql, /for update of claim\b/i);
    assert.doesNotMatch(decideSelect.sql, /for update of claim\s*,/i);
    assert.equal(calls.some(({ sql }) => sql.includes("update pulse.identity_link set valid_to=now()")), false);
    assert.ok(calls.some(({ sql, params }) => sql.includes("pulse.audit_write")
      && params[0] === "account_claim.confirmed"));
  } finally { await app.close(); }
});

test("nobody can decide their own claim and non-managers cannot decide reports", async () => {
  for (const options of [{ role: "manager", person: REPORT }, { role: "person", manages: false }]) {
    const { app, calls } = appFor(options);
    try {
      const response = await app.inject({ method: "POST", url: "/v1/accounts/" + ACCOUNT + "/claim/decide",
        headers: headers("reviewer@example.test"), payload: { decision: "rejected" } });
      assert.equal(response.statusCode, 403);
      assert.equal(calls.some(({ sql }) => sql.includes("update pulse.account_claim set status=$3")), false);
      if (options.person === REPORT)
        assert.equal(calls.some(({ sql }) => sql.includes("for update of claim")), false);
    } finally { await app.close(); }
  }
});

test("reverting a confirmed claim removes its account identity link", async () => {
  const { app, calls } = appFor({ role: "manager", person: "00000000-0000-0000-0000-000000000005",
    claim: { ...baseClaim, status: "confirmed", holderPersonId: REPORT } });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/accounts/" + ACCOUNT + "/claim/revert",
      headers: headers("manager@example.test"), payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "reverted");
    assert.ok(calls.some(({ sql }) => sql.includes("source='account_claim'") && sql.includes("valid_to=now()")));
    assert.ok(calls.some(({ sql, params }) => sql.includes("update pulse.account set holder_person_id=null")
      && params[1] === ACCOUNT));
    const accountUpdate = calls.find(({ sql }) => sql.includes("update pulse.account set holder_person_id=null"));
    assert.match(accountUpdate.sql, /holder_person_id=\$3/);
    const revertSelect = calls.find(({ sql }) => sql.includes("claim.status='confirmed'"));
    assert.match(revertSelect.sql, /for update of claim\b/i);
    assert.doesNotMatch(revertSelect.sql, /for update of claim\s*,/i);
    assert.ok(calls.some(({ sql }) => sql.includes("'account_claim.reverted'")));
  } finally { await app.close(); }
});
