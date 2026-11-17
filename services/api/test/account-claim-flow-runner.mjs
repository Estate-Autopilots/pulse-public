import assert from "node:assert/strict";
import { Pool } from "pg";
import { createApp } from "../dist/app.js";

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (method, url, email, payload) => {
  const response = await app.inject({ method, url,
    headers: { "cf-access-authenticated-user-email": email }, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.json() };
};

try {
  const claimant = process.env.TEST_CLAIMANT_EMAIL;
  const hr = process.env.TEST_HR_EMAIL;
  const manager = process.env.TEST_MANAGER_EMAIL;
  const first = process.env.TEST_ACCOUNT_FIRST;
  const second = process.env.TEST_ACCOUNT_SECOND;
  const visible = await call("GET", "/v1/accounts/claimable", claimant);
  assert.equal(visible.status, 200, JSON.stringify(visible.body));
  const listed = new Set(visible.body.accounts.map(account => account.id));
  assert.ok(listed.has(first), "non-lead staff sees the account backed by their project task");
  assert.ok(listed.has(second), "same scoped project includes the second account");

  const claimOne = await call("POST", `/v1/accounts/${first}/claim`, claimant, {});
  assert.equal(claimOne.status, 200, JSON.stringify(claimOne.body));
  assert.equal(claimOne.body.status, "pending");
  const claimTwo = await call("POST", `/v1/accounts/${second}/claim`, claimant, {});
  assert.equal(claimTwo.status, 200, JSON.stringify(claimTwo.body));
  assert.equal(claimTwo.body.status, "pending");

  const selfDecision = await call("POST", `/v1/accounts/${second}/claim/decide`, claimant, { decision: "confirmed" });
  assert.equal(selfDecision.status, 403, JSON.stringify(selfDecision.body));
  const hrConfirmation = await call("POST", `/v1/accounts/${first}/claim/decide`, hr, { decision: "confirmed" });
  assert.equal(hrConfirmation.status, 200, JSON.stringify(hrConfirmation.body));
  const managerConfirmation = await call("POST", `/v1/accounts/${second}/claim/decide`, manager, { decision: "confirmed" });
  assert.equal(managerConfirmation.status, 200, JSON.stringify(managerConfirmation.body));

  const otherReviewerRevert = await call("POST", `/v1/accounts/${first}/claim/revert`, manager, {});
  assert.equal(otherReviewerRevert.status, 200, JSON.stringify(otherReviewerRevert.body));
  assert.equal(otherReviewerRevert.body.status, "reverted");

  const ownClaims = await call("GET", "/v1/accounts/claims", claimant);
  assert.equal(ownClaims.status, 200, JSON.stringify(ownClaims.body));
  assert.deepEqual(new Set(ownClaims.body.claims.map(claim => claim.status)), new Set(["reverted", "confirmed"]));
  console.log("Account claim flow passed for non-lead staff, HR, and a manager reviewer.");
} finally {
  await app.close();
  await pool.end();
}
