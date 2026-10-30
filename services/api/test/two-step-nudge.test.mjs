// TWO-STEP-NUDGE (owner, 30 Oct 2026): an admin past the organisation's two-step grace period without two-step set
// up still opens their pages; signing in sends them to Account / Security instead (auth_login, test_account_security).
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
      if (sql.includes("pulse.auth_enforcement")) return { rows: [{ blocked: true }] }; // past the grace, no two-step
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

test("an admin without two-step past the grace period still opens their pages", async () => {
  const { app, calls, restore } = fixture();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/me/hr", headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.stringify(response.json()).includes("two-step"), false);
    assert.ok(calls.some(({ sql }) => sql.includes("pulse.auth_enforcement")), "the rule is still read");
  } finally { await restore(); }
});
