import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const PERSON_A = "00000000-0000-0000-0000-000000000001";
const PERSON_B = "00000000-0000-0000-0000-000000000002";
const ACCOUNT = "shared@example.test";
const EMAIL = "admin@example.test";
const HOW_VALUES = ["account map", "confirmation", "fingerprint", "folder owner", "shared"];

const creditCases = [
  { credited_to: PERSON_A, how: "account map" },
  { credited_to: PERSON_A, how: "confirmation" },
  { credited_to: PERSON_B, how: "fingerprint" },
  { credited_to: PERSON_B, how: "folder owner" },
  { credited_to: "shared login", how: "shared" },
  { credited_to: "unresolved", how: null },
];

const recent = creditCases.map((credit, index) => ({
  fileId: "file-synthetic-" + String(index + 1).padStart(3, "0"),
  fileName: "synthetic-delivery-" + String(index + 1) + ".mp4",
  projectId: "project-synthetic-01",
  projectName: "Synthetic Project",
  uploaderAccount: ACCOUNT,
  deliverableType: "final",
  deliveredAt: "2026-10-05T09:15:00Z",
  week: "2026-W41",
  matchedRule: "configured_deliverable_folder",
  ruleDetail: "Synthetic file in the configured deliverables folder.",
  sharedLogin: credit.credited_to === "shared login",
  identityVerified: credit.credited_to !== "unresolved",
  ...credit,
}));

const timeline = creditCases.map((credit, index) => ({
  fileId: "file-synthetic-" + String(index + 1).padStart(3, "0"),
  fileName: "synthetic-delivery-" + String(index + 1) + ".mp4",
  kind: "final",
  deliveredAt: "2026-10-05T09:15:00Z",
  detail: "Synthetic decisive evidence for " + (credit.how ?? "unresolved"),
  projectName: "Synthetic Project",
  ...credit,
}));

function makePool({ role = "admin", email = EMAIL, accountIdentity = { is_shared: true, holder_person_id: null } } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if(sql.includes("pulse.auth_enforcement"))return {rows:[{blocked:false}]};
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      const normalized = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalized)) return { rows: [] };
      if (sql.includes("set_config")) return { rows: [] };
      if (sql.includes("select p.id person,p.display_name name")) {
        return { rows: [{
          person: PERSON_A,
          name: "Synthetic Editor",
          status: "active",
          pod: "Synthetic Pod",
          username: "synthetic-editor",
          accounts: [email],
          roles: [role],
        }] };
      }
      if (sql.includes("(now() at time zone (select pulse.org_time_zone()))::date::text today")) {
        return { rows: [{ today: "2026-10-05", monday: "2026-10-05", zone: "Asia/Kolkata" }] };
      }
      if (sql.includes("select to_char($1::date")) {
        return { rows: [{ week: "2026-W41", dow: 1 }] };
      }
      if (sql.includes('select p.id "projectId"')) return { rows: [] };
      if (sql.includes('d.rule_detail "ruleDetail"')) return { rows: recent };
      if (sql.includes("::numeric/8 usual")) return { rows: [{ usual: "0" }] };
      if (sql.includes("count(*)::int files,max(observed_at)")) {
        return { rows: [{ files: 6, lastIndexedAt: "2026-10-05T09:15:00Z", indexedProjects: 1 }] };
      }
      if (sql.includes("credited_to_person") && sql.includes("total_deliveries")) {
        return { rows: [{
          credited_to_person: 4,
          shared_login: 1,
          unresolved: 1,
          total_deliveries: 6,
        }] };
      }
      if (sql.includes("select (delivered_at at time zone")) return { rows: [] };
      if (sql.includes("generate_series")) return { rows: [] };
      if (sql.includes("d.rule_detail detail")) return { rows: timeline };
      if (sql.includes("select is_shared,holder_person_id")) {
        return { rows: [accountIdentity] };
      }
      throw new Error("Unexpected synthetic API query: " + sql);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, calls };
}

function testApp(options) {
  const { pool, calls } = makePool(options);
  return {
    app: createApp({ query: async () => ({ rows: [{ org_id: process.env.PULSE_ORG_ID ?? "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75" }] }) }, pool),
    calls,
  };
}

test("Editors API returns 30-day credit counts, shares, and each decisive how value", async () => {
  const { app, calls } = testApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v0/editors/" + encodeURIComponent(ACCOUNT),
      headers: { "cf-access-authenticated-user-email": EMAIL },
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.holder_person_id, null, "a shared-login profile has no personal target identity");

    assert.deepEqual(data.attribution, {
      window_days: 30,
      total_deliveries: 6,
      credited_to_person: 4,
      credited_to_person_share: 4 / 6,
      shared_login: 1,
      shared_login_share: 1 / 6,
      unresolved: 1,
    });
    assert.deepEqual(data.timeline.map(({ credited_to, how }) => [credited_to, how]), creditCases.map(
      ({ credited_to, how }) => [credited_to, how],
    ));
    assert.deepEqual(
      [...new Set(data.timeline.map((delivery) => delivery.how).filter(Boolean))].sort(),
      [...HOW_VALUES].sort(),
    );
    assert.deepEqual(
      data.recentDeliveries.map(({ credited_to, how }) => [credited_to, how]),
      creditCases.map(({ credited_to, how }) => [credited_to, how]),
    );

    const detailQuery = calls.find(({ sql }) => sql.includes("d.rule_detail detail"));
    assert.ok(detailQuery, "the editor timeline query ran");
    assert.match(detailQuery.sql, /order by evidence\.position desc limit 1/);
    assert.deepEqual(detailQuery.params, [ACCOUNT]);

    const attributionQuery = calls.find(({ sql }) => sql.includes("credited_to_person") && sql.includes("total_deliveries"));
    assert.deepEqual(attributionQuery.params, [ACCOUNT]);
  } finally {
    await app.close();
  }
});

test("an individual editor profile includes its nullable holder person ID", async () => {
  const { app } = testApp({ accountIdentity: { is_shared: false, holder_person_id: PERSON_A } });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v0/editors/" + encodeURIComponent(ACCOUNT),
      headers: { "cf-access-authenticated-user-email": EMAIL },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().holder_person_id, PERSON_A);
  } finally {
    await app.close();
  }
});

test("a person cannot inspect another account's delivery attribution", async () => {
  const { app } = testApp({ role: "person", email: "editor-one@example.test" });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v0/editors/" + encodeURIComponent("editor-two@example.test"),
      headers: { "cf-access-authenticated-user-email": "editor-one@example.test" },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "You can view your own account" });
  } finally {
    await app.close();
  }
});
