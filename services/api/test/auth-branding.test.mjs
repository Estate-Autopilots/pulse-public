import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";

function setup(orgName) {
  const calls = [];
  let brandingRoute;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "select name from pulse.org where id=$1") return { rows: orgName ? [{ name: orgName }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  // An initialised install: API routes answer only once pulse.install names the company.
  const database = { query: async () => ({ rows: [{ org_id: "00000000-0000-0000-0000-0000000000a1" }] }) };
  const app = createApp(database, { connect: async () => client }, route => {
    if (route.url === "/api/v0/auth/branding") brandingRoute = route;
  });
  return { app, calls, get brandingSchema() { return brandingRoute?.schema?.response?.[200]; } };
}

test("the API auth gate permits anonymous branding and exposes only the company name", async () => {
  const { app, calls, brandingSchema } = setup("Northwind Studio");
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/auth/branding" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { name: "Northwind Studio", google: false });
    assert.equal(calls[0].sql, "begin");
    assert.equal(calls[1].sql, "select set_config('pulse.org_id',$1,true)");
    assert.equal(calls[2].sql, "select name from pulse.org where id=$1");
    assert.equal(calls.at(-1).sql, "commit");
    assert.equal(brandingSchema.additionalProperties, false);
  } finally {
    await app.close();
  }
});

test("public branding falls back to the neutral Pulse name when the company row is unreadable", async () => {
  const { app } = setup(null);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/auth/branding" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { name: "Pulse", google: false });
  } finally {
    await app.close();
  }
});

test("the API auth gate uses a company-neutral message for an invalid Access identity", async () => {
  const { app } = setup("Northwind Studio");
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v0/me",
      headers: { "cf-access-authenticated-user-email": "not-an-email" },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Sign in through your company's Access" });
    assert.doesNotMatch(response.body, /Estate Autopilots/i);
  } finally {
    await app.close();
  }
});
