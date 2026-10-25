import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

const PERSON = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const EMAIL = "employee@example.test";

function fixture() {
  const calls = [];
  const routes = [];
  const previousPublicLogin = process.env.PULSE_PUBLIC_LOGIN_ENABLED;
  process.env.PULSE_PUBLIC_LOGIN_ENABLED = "0";
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalized) || sql.includes("set_config")) return { rows: [] };
      calls.push({ sql, params });
      if (sql.includes("select p.id person,p.display_name name")) return { rows: [{ person: PERSON, name: "Synthetic Employee",
        status: "active", pod: null, username: "synthetic.employee", accounts: [EMAIL], roles: ["person"] }] };
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      if (sql.includes("pulse.audit_write")) return { rows: [] };
      if (sql.includes("pulse.auth_enforcement")) return { rows: [{ blocked: false }] };
      if (sql.includes("select coalesce((select attendance_enabled")) return { rows: [{ enabled: false }] };
      if (sql.includes("pulse.hr_self_profile()")) return { rows: [{ data: {
        employee: { name: "Synthetic Employee", status: "active", role: "Video editor", department: "Creative",
          employmentType: "full_time", joinedOn: "2024-03-11", governmentId: "must-not-leak" },
        history: [{ field: "department", from: "Studio", to: "Creative", at: "2026-10-01T08:00:00.000Z", by: "Synthetic HR",
          salaryAmount: 50000 }],
        documents: [{ type: "appointment_letter", seenAt: "2026-10-01T08:00:00.000Z", fileId: "synthetic-file", fileName: "Synthetic Offer.pdf" }],
        accessHistory: [{ at: "2026-10-01T08:00:00.000Z", viewer: "Synthetic HR", resource: "hr.profile", purpose: "hr_profile_view" }],
        compensation: { amount: 50000 }, finance: { bankAccount: "must-not-leak" }, identity: { passport: "must-not-leak" },
      } }] };
      if (sql.includes("doc_key='modules'")) return { rows: [] }; // no modules document: every module on
      throw new Error(`Unexpected synthetic query: ${sql}`);
    },
    release() {},
  };
  const app = createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, { connect: async () => client }, route => routes.push(route));
  const restore = async () => {
    await app.close();
    if (previousPublicLogin === undefined) delete process.env.PULSE_PUBLIC_LOGIN_ENABLED;
    else process.env.PULSE_PUBLIC_LOGIN_ENABLED = previousPublicLogin;
  };
  return { app, calls, routes, restore };
}

test("employee HR self view is self scoped, audited, and serialized through a safe allowlist", async () => {
  const { app, calls, restore } = fixture();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/me/hr", headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.attendanceEnabled, false);
    assert.deepEqual(body.employee, { name: "Synthetic Employee", status: "active", role: "Video editor", department: "Creative",
      employmentType: "full_time", joinedOn: "2024-03-11" });
    assert.deepEqual(body.history, [{ field: "department", from: "Studio", to: "Creative", at: "2026-10-01T08:00:00.000Z", by: "Synthetic HR" }]);
    assert.deepEqual(body.documents, [{ type: "appointment_letter", seenAt: "2026-10-01T08:00:00.000Z" }]);
    assert.ok(Array.isArray(body.accessHistory));
    assert.deepEqual(Object.keys(body).sort(), ["accessHistory", "attendanceEnabled", "documents", "employee", "history"]);
    const serialized = JSON.stringify(body).toLowerCase();
    for (const field of ["salary", "finance", "governmentid", "passport", "bank", "kyc", "identity", "fileid", "filename"])
      assert.equal(serialized.includes(field), false, `${field} must not be present in the response`);
    assert.ok(calls.some(({ sql, params }) => sql.includes("pulse.hr_self_profile()") && params.length === 0),
      "the SQL read derives its person from the authenticated viewer and takes no subject argument");
    assert.ok(calls.some(({ sql, params }) => sql.includes("pulse.audit_write('restricted_read',$1)") && params[0] === "/api/v0/me/hr"),
      "the API records a restricted-read audit event");
  } finally { await restore(); }
});

test("employee cannot read another person's HR record", async () => {
  const { app, calls, restore } = fixture();
  try {
    const response = await app.inject({ method: "GET", url: `/api/v0/people/${OTHER}/hr`,
      headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 403);
    assert.equal(calls.some(({ sql }) => sql.includes("pulse.hr_self_profile()")), false);
    assert.ok(calls.some(({ sql, params }) => sql.includes("pulse.audit_write('restricted_read',$1)") && params[0] === `/api/v0/people/${OTHER}/hr`),
      "the denied cross-person attempt is still captured by the restricted-read audit event");
  } finally { await restore(); }
});

test("HR self response schema names no excluded data fields", async () => {
  let hrRoute;
  const { app, routes, restore } = fixture();
  try {
    await app.ready();
    hrRoute = routes.find(route => route.url === "/api/v0/me/hr");
    const schema = JSON.stringify(hrRoute?.schema?.response?.[200]).toLowerCase();
    assert.ok(schema.length > 0);
    for (const field of ["salary", "finance", "governmentid", "passport", "bank", "kyc", "identity"])
      assert.equal(schema.includes(field), false, `${field} must be absent from the response schema`);
  } finally { await restore(); }
});
