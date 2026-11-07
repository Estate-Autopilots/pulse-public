import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { classifyDesignType } from "../dist/editor-targets.js";

const FIXTURES = JSON.parse(readFileSync(new URL("../../ml/pulse_rules/fixtures/delivery_detection.v2.json", import.meta.url)));
const EA_DESIGN_RULES = JSON.parse(readFileSync(new URL("../../../config/ea-design-type-rules.json", import.meta.url)));
const ATTRIBUTION_FIXTURES = JSON.parse(readFileSync(new URL("../../workers/tests/fixtures/delivery_attribution.v1.json", import.meta.url)));
const DESIGN_CASES = FIXTURES.classify.filter(({ id }) => id.startsWith("design-"));
const DESIGN_SUMMARY_EXCLUSIONS = FIXTURES.design_summary_exclusions;
const DESIGN_SUMMARY_INCLUSIONS = FIXTURES.design_summary_inclusions;
const PERSON = "00000000-0000-0000-0000-000000000001";
const ADMIN = "admin@estateautopilots.com";
const MANAGER = "manager@example.test";
const HR = "hr@example.test";
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";

function appFor({ files = [], org = ORG } = {}) {
  const calls = [];
  const previousPublicLogin = process.env.PULSE_PUBLIC_LOGIN_ENABLED;
  process.env.PULSE_PUBLIC_LOGIN_ENABLED = "0";
  const client = {
    async query(sql, params = []) {
      if(sql.includes("pulse.auth_enforcement"))return {rows:[{blocked:false}]};
      calls.push({ sql, params });
      const normalized = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalized) || sql.includes("set_config")) return { rows: [] };
      if (sql.includes("privacy.access_log")) return { rows: [] };
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      if (sql.includes("select p.id person,p.display_name name")) {
        const email = params[0];
        return { rows: [{ person: PERSON, name: "Synthetic Person", status: "active", pod: null,
          username: "synthetic", accounts: [email], roles: email === ADMIN ? ["admin"] : email === HR ? ["hr"]
            : email === MANAGER ? ["manager"] : ["person"] }] };
      }
      if (sql.includes("design_type_rules")) return { rows: params[0] === org ? [{ body: FIXTURES.tenant_config }] : [] };
      if (sql.includes("lower(f.name) like any")) return { rows: params[0] === org
        ? files.filter(file => (file.staff === true || file.is_shared === true) && (!file.scope || file.scope === params[1])) : [] };
      if (sql.includes("doc_key='modules'")) return { rows: [] }; // no modules document: every module on
      throw new Error(`Unexpected synthetic query: ${sql}`);
    },
    release() {},
  };
  const restore = () => {
    if (previousPublicLogin === undefined) delete process.env.PULSE_PUBLIC_LOGIN_ENABLED;
    else process.env.PULSE_PUBLIC_LOGIN_ENABLED = previousPublicLogin;
  };
  return { app: createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, { connect: async () => client }), calls, restore };
}

test("design classifier reads the same synthetic fixtures as pulse_rules", () => {
  for (const item of DESIGN_CASES) {
    assert.equal(
      classifyDesignType(item.file_event.folder_path.join("/"), item.file_event.name, FIXTURES.tenant_config),
      item.expected.design_type,
      item.id,
    );
  }
  assert.equal(classifyDesignType("Creatives/Logos", "file.ai", {
    design_type_rules: { folder_path: [{ match: "[", type: "logo" }] },
  }), "other");
});

test("EA design folder rules match bounded terms inside normalized segments", () => {
  const config = { design_type_rules: EA_DESIGN_RULES };
  assert.equal(classifyDesignType("W41 project carousel creative exports", "asset.pdf", config), "carousel");
  assert.equal(classifyDesignType("Project_single_IMG, ad_v2", "asset.pdf", config), "single_image_ad");
  assert.equal(classifyDesignType("Carousel image ads", "asset.pdf", config), "carousel");
  assert.equal(classifyDesignType("C.Img ads", "asset.pdf", config), "carousel");
  assert.equal(classifyDesignType("Carousel-Image creatives", "asset.pdf", config), "carousel");
  assert.equal(classifyDesignType("Single image ads", "asset.pdf", config), "single_image_ad");
  assert.equal(classifyDesignType("Image ads", "asset.pdf", config), "single_image_ad");
  assert.equal(classifyDesignType("campaign monologous archive", "asset.pdf", config), "other");
  assert.equal(classifyDesignType("creative archive", "asset.pdf", config), "other");
});

test("EA design rules exclude reference inputs and prefer the deepest matching folder", () => {
  const config = { design_type_rules: EA_DESIGN_RULES };
  for (const item of FIXTURES.design_type_precedence_cases) {
    assert.equal(classifyDesignType(item.folder_path.join("/"), "asset.pdf", config), item.expected, item.id);
  }
});

test("summary counts design types and attribution while excluding client-uploaded logos", async () => {
  const attributionCases = ATTRIBUTION_FIXTURES.cases;
  const files = DESIGN_CASES.map(({ file_event }, index) => {
    const attribution = attributionCases[index % attributionCases.length];
    return { path: file_event.folder_path.join("/"), name: file_event.name, mime: file_event.mime, staff: true,
      has_delivery: file_event.name === "Unmarked export.psd",
      credited_to: attribution.credit === "shared login" || attribution.credit === "unresolved"
        ? attribution.credit : ATTRIBUTION_FIXTURES.people[attribution.credit], how: attribution.how };
  });
  files.push(...DESIGN_SUMMARY_EXCLUSIONS.map(({ file_event, uploader_side, expected_count }) => ({
    path: file_event.folder_path.join("/"), name: file_event.name, mime: file_event.mime,
    staff: uploader_side === "staff", has_delivery: expected_count > 0, credited_to: "unresolved", how: null,
  })));
  files.push(...DESIGN_SUMMARY_INCLUSIONS.map(({ file_event, account, expected_credit }) => ({
    path: file_event.folder_path.join("/"), name: file_event.name, mime: file_event.mime,
    staff: false, is_shared: account.is_shared, has_delivery: true,
    credited_to: expected_credit === "shared_login" ? "shared login" : "unresolved",
    how: expected_credit === "shared_login" ? "shared" : null,
  })));
  files.push({ path: "Creatives/Exports", name: "Promo video.mp4", mime: "video/mp4",
    credited_to: PERSON, how: "account map" });
  files.push({ path: "Creatives/Exports", name: "Video disguised.ai", mime: "video/mp4",
    credited_to: "shared login", how: "shared" });
  const { app, calls, restore } = appFor({ files });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/design-deliveries/summary",
      headers: { "cf-access-authenticated-user-email": ADMIN } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      window_days: 30,
      total: 9,
      unmatched_count: 1,
      types: { single_image_ad: 1, carousel: 2, brochure: 1, logo: 3, pitch_deck: 1, other: 1 },
      attribution: {
        total_deliveries: 9,
        credited_to_person: 4,
        shared_login: 4,
        unresolved: 1,
        by_method: { account_map: 2, confirmation: 0, fingerprint: 1, folder_owner: 1, shared: 4, unresolved: 1 },
      },
    });
    const query = calls.find(({ sql }) => sql.includes("from pulse.index_file f") && sql.includes("lower(f.name) like any"));
    assert.match(query.sql, /coalesce\(f\.modified_at,f\.created_at\) >= now\(\)-interval '30 days'/);
    assert.match(query.sql, /f\.account_basis='last modifying account'/);
    assert.match(query.sql, /ea_person\.side='staff' or coalesce\(ea_account\.is_shared,false\)/);
    assert.doesNotMatch(query.sql, /ea_account\.purpose like 'Workspace%'/);
    assert.match(query.sql, /pulse\.delivery_matches\(f\.file_id,\$2\)/);
    assert.match(query.sql, /pulse\.attribution/);
    assert.deepEqual(query.params, [ORG, null]);
    assert.ok(calls.some(({ sql, params }) => sql.includes("privacy.access_log") && params[0] === ORG));
  } finally {
    await app.close();
    restore();
  }
});

test("confirmed design claims count as personal confirmation; pending and rejected claims stay shared", async () => {
  const files = [
    { path: "Creatives/Logos", name: "Confirmed mark.pdf", mime: "application/pdf", is_shared: true,
      has_delivery: true, credited_to: PERSON, how: "confirmation", claim_status: "confirmed" },
    { path: "Creatives/Logos", name: "Pending mark.pdf", mime: "application/pdf", is_shared: true,
      has_delivery: true, credited_to: "shared login", how: "shared", claim_status: "pending" },
    { path: "Creatives/Logos", name: "Rejected mark.pdf", mime: "application/pdf", is_shared: true,
      has_delivery: true, credited_to: "shared login", how: "shared", claim_status: "rejected" },
  ];
  const { app, calls, restore } = appFor({ files });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/design-deliveries/summary",
      headers: { "cf-access-authenticated-user-email": ADMIN } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 3);
    assert.equal(response.json().types.logo, 3);
    assert.deepEqual(response.json().attribution, {
      total_deliveries: 3, credited_to_person: 1, shared_login: 2, unresolved: 0,
      by_method: { account_map: 0, confirmation: 1, fingerprint: 0, folder_owner: 0, shared: 2, unresolved: 0 },
    });
    const query = calls.find(({ sql }) => sql.includes("with claim_files as materialized") && sql.includes("lower(f.name) like any"));
    assert.match(query.sql, /pulse\.design_claim_person\(f\.file_id\)/);
    assert.doesNotMatch(query.sql, /from pulse\.delivery_claim/);
  } finally {
    await app.close();
    restore();
  }
});

test("managers receive team-scoped aggregate attribution without person-level details", async () => {
  const { app, calls, restore } = appFor({ files: [{ path: "Creatives/Logos", name: "Brand mark.pdf",
    mime: "application/pdf", staff: true, credited_to: PERSON, how: "account map", scope: `team:${PERSON}` }] });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/design-deliveries/summary",
      headers: { "cf-access-authenticated-user-email": MANAGER } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().attribution, {
      total_deliveries: 1, credited_to_person: 1, shared_login: 0, unresolved: 0,
      by_method: { account_map: 1, confirmation: 0, fingerprint: 0, folder_owner: 0, shared: 0, unresolved: 0 },
    });
    assert.equal(JSON.stringify(response.json()).includes(PERSON), false);
    const query = calls.find(({ sql }) => sql.includes("from pulse.index_file f") && sql.includes("lower(f.name) like any"));
    assert.deepEqual(query.params, [ORG, `team:${PERSON}`]);
    assert.ok(calls.some(({ sql }) => sql.includes("privacy.access_log")));
  } finally {
    await app.close();
    restore();
  }
});

test("HR-only accounts cannot request design delivery aggregates", async () => {
  const { app, calls, restore } = appFor();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/design-deliveries/summary",
      headers: { "cf-access-authenticated-user-email": HR } });
    assert.equal(response.statusCode, 403);
    assert.equal(calls.some(({ sql }) => sql.includes("lower(f.name) like any")), false);
  } finally {
    await app.close();
    restore();
  }
});

test("individual accounts cannot request team design delivery aggregates", async () => {
  const { app, calls, restore } = appFor();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/design-deliveries/summary",
      headers: { "cf-access-authenticated-user-email": "designer@example.test" } });
    assert.equal(response.statusCode, 403);
    assert.equal(calls.some(({ sql }) => sql.includes("lower(f.name) like any")), false);
  } finally {
    await app.close();
    restore();
  }
});
