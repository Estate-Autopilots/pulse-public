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
  const manager = process.env.TEST_MANAGER_EMAIL;
  const account = process.env.TEST_ACCOUNT_AMBIGUOUS;
  const phase = process.argv[2];
  if (phase === "claim") {
    const created = await call("POST", `/v1/accounts/${account}/claim`, claimant, {});
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.status, "pending");
  } else if (phase === "decide") {
    const self = await call("POST", `/v1/accounts/${account}/claim/decide`, claimant,
      { decision: "rejected" });
    assert.equal(self.status, 403, JSON.stringify(self.body));
    const confirm = await call("POST", `/v1/accounts/${account}/claim/decide`, manager,
      { decision: "confirmed" });
    assert.equal(confirm.status, 409, JSON.stringify(confirm.body));
    const reject = await call("POST", `/v1/accounts/${account}/claim/decide`, manager,
      { decision: "rejected", reason: "Conflicting active identity link" });
    assert.equal(reject.status, 200, JSON.stringify(reject.body));
    assert.equal(reject.body.status, "rejected");
  } else if (phase === "retry") {
    const retry = await call("POST", `/v1/accounts/${account}/claim`, claimant, {});
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.status, "pending");
  } else {
    assert.fail(`Unknown account claim ambiguity test phase: ${phase}`);
  }
} finally {
  await app.close();
  await pool.end();
}
