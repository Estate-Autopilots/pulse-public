import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { classifyEditorCreativeType, loadEditorTargets } from "../dist/editor-targets.js";

const PERSON = "00000000-0000-0000-0000-000000000001";
const OTHER_PERSON = "00000000-0000-0000-0000-000000000002";
const EMAIL = "editor@example.test";
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";

const targets = {
  editors: { model_video: { per_week: 4, placeholder: true }, vov: { per_week: 3, placeholder: true } },
  person_overrides: { [PERSON]: { model_video: { per_week: 5, placeholder: true } } },
};
const folderRules = {
  creative_type_rules: {
    folder_path: [{ match: "model\\s+final\\s+videos?", type: "model_video" }, { match: "vovs?", type: "vov" }],
    file_name: [{ match: "\\bfounders?[-\\s]+videos?\\b", type: "founder_video" }, { match: "\\btestimonials?\\b", type: "testimonial" }, { match: "\\bwalk[\\s-]*throughs?\\b", type: "walkthrough" }],
    parsed_type_codes: { MV: "model_video", HK: "model_video", VV: "vov", CP: "vov" },
  },
  file_name: { legacy_type_hints: { "hook\\s*\\d": "HK", "\\bCP\\d{0,3}\\b": "CP" } },
};

function poolFor(options = {}) {
  const { person = PERSON, deliveries = [], editorAccounts = [], tasks = [], dataOrg = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75" } = options;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      if(sql.includes("pulse.auth_enforcement"))return {rows:[{blocked:false}]};
      calls.push({ sql, params });
      if (sql.includes("pulse.audit_signin")) return { rows: [] };
      const normalized = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalized) || sql.includes("set_config")) return { rows: [] };
      if (sql.includes("select p.id person,p.display_name name")) {
        return { rows: [{ person, name: "Synthetic Editor", status: "active", pod: null, username: "synthetic", accounts: [EMAIL], roles: options.roles ?? ["person"] }] };
      }
      if (normalized.includes("(now() at time zone (select pulse.org_time_zone()))::date::text today")) {
        return { rows: [{ today: "2026-10-05", monday: "2026-10-05", zone: "Asia/Kolkata" }] };
      }
      if (normalized.includes("to_date($1,'iyyy-\"w\"iw')")) return { rows: [{ valid: true, monday: "2026-10-05", start: new Date("2026-10-04T18:30:00Z"), end: new Date("2026-10-11T18:30:00Z") }] };
      if (normalized.includes("select to_char($1::date,'iyyy-\"w\"iw') week")) return { rows: [{ week: "2026-W41", dow: 1 }] };
      if (sql.includes("select id from pulse.person")) return { rows: [{ id: params[0] }] };
      if (sql.includes("select pulse.manages($1) ok")) return { rows: [{ ok: options.manages === true }] };
      if (sql.includes("insert into privacy.access_log")) return { rows: [] };
      if (sql.includes("from pulse.task t")) return { rows: tasks };
      if (sql.includes("select d.uploader_account account") && sql.includes("pulse.delivery_matches")) return { rows: editorAccounts };
      if (sql.includes("credited_to_person") && sql.includes("total_deliveries")) return { rows: [{ credited_to_person: 1, shared_login: 1, unresolved: 0, total_deliveries: 2 }] };
      if (sql.includes("doc_kind='targets'")) return { rows: params[0] === dataOrg ? [{ body: targets }] : [] };
      if (sql.includes("doc_kind='folder_rules'")) return { rows: params[0] === dataOrg ? [{ body: folderRules }] : [] };
      if (sql.includes("from pulse.delivery d join pulse.index_file f")) return { rows: params[0] === dataOrg ? deliveries : [] };
      throw new Error("Unexpected synthetic query: " + sql);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, calls };
}

function appFor(options) {
  const { pool, calls } = poolFor(options);
  return { app: createApp({ query: async () => ({ rows: [{ org_id: ORG }] }) }, pool), calls };
}

test("target loader resolves per-person overrides and keeps unbenchmarked taxonomy types null", () => {
  const result = loadEditorTargets(targets, PERSON);
  assert.deepEqual(result.model_video, { target: 5, placeholder: true });
  assert.deepEqual(result.vov, { target: 3, placeholder: true });
  assert.deepEqual(result.founder_video, { target: null, placeholder: true });
  assert.deepEqual(loadEditorTargets(targets, OTHER_PERSON).model_video, { target: 4, placeholder: true });
  assert.throws(() => loadEditorTargets({ editors: { model_video: { per_week: -1, placeholder: true } } }, PERSON), /per_week/);
});

test("creative type classifier follows configured taxonomy and preserves unknowns", () => {
  assert.equal(classifyEditorCreativeType("root/model final videos/draft.mp4", "draft.mp4", folderRules), "model_video");
  assert.equal(classifyEditorCreativeType("root/exports", "Founder Video.mp4", folderRules), "founder_video");
  assert.equal(classifyEditorCreativeType("root/exports", "EA0584-HK03.mp4", folderRules), "model_video");
  assert.equal(classifyEditorCreativeType("root/exports", "CP Video.mp4", folderRules), "vov");
  assert.equal(classifyEditorCreativeType("root/exports", "CP03.mp4", folderRules), "vov");
  assert.equal(classifyEditorCreativeType("root/exports", "unclassified.mp4", folderRules), "other");
});

test("editor week endpoint returns contract counts, target gap, and placeholder without file or person data", async () => {
  const { app, calls } = appFor({ deliveries: [
    { path: "root/model final videos/draft.mp4", name: "draft.mp4", kind: "draft" },
    { path: "root/model final videos/final.mp4", name: "final.mp4", kind: "final" },
    { path: "root/vovs/draft.mp4", name: "draft.mp4", kind: "draft" },
    { path: "root/model final videos/claimed-final.mp4", name: "claimed-final.mp4", kind: "final", claimed: true },
  ] });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/editors/${PERSON}/week?week=2026-W41`,
      headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.week, "2026-W41");
    assert.deepEqual(Object.keys(body.types), ["model_video", "vov", "founder_video", "testimonial", "walkthrough", "other"]);
    assert.deepEqual(body.types.model_video, { target: 5, delivered: { drafts: 1, finals: 2 }, claimed: { drafts: 0, finals: 1 }, gap: 2, placeholder: true });
    assert.deepEqual(body.types.vov, { target: 3, delivered: { drafts: 1, finals: 0 }, claimed: { drafts: 0, finals: 0 }, gap: 2, placeholder: true });
    assert.deepEqual(body.types.other, { target: null, delivered: { drafts: 0, finals: 0 }, claimed: { drafts: 0, finals: 0 }, gap: null, placeholder: true });
    const deliveryQuery = calls.find(({ sql }) => sql.includes("from pulse.delivery d join pulse.index_file f"));
    assert.deepEqual(deliveryQuery.params, ["6f1a455d-ced2-504d-b8d5-5ae0efbe7c75", new Date("2026-10-04T18:30:00.000Z"), new Date("2026-10-11T18:30:00.000Z"), PERSON]);
    assert.ok(calls.some(({ sql }) => sql.includes("insert into privacy.access_log")));
    assert.ok(deliveryQuery.sql.includes("pulse.delivery_claim"));
    assert.equal(deliveryQuery.sql.match(/claim\.claim_scope='delivery'/g)?.length, 2);
    assert.equal(JSON.stringify(response.json()).includes("draft.mp4"), false);
    assert.equal(JSON.stringify(response.json()).includes("Synthetic Editor"), false);
  } finally {
    await app.close();
  }
});

test("editor account responses expose personal holder IDs and suppress shared-login IDs", async () => {
  const { app, calls } = appFor({ editorAccounts: [
    { account: "editor-one@example.test", holder_person_id: PERSON, sharedLogin: false, identityVerified: true,
      allTime: 4, thisWeek: 2, drafts: 1, finals: 3, lastDelivery: "2026-10-05T09:15:00Z" },
    { account: "editor-two@example.test", holder_person_id: OTHER_PERSON, sharedLogin: false, identityVerified: true,
      allTime: 2, thisWeek: 1, drafts: 0, finals: 2, lastDelivery: "2026-10-04T09:15:00Z" },
    { account: "studio-shared@example.test", holder_person_id: null, sharedLogin: true, identityVerified: false,
      allTime: 9, thisWeek: 3, drafts: 2, finals: 7, lastDelivery: "2026-10-03T09:15:00Z" },
  ] });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/editors", headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.accounts.map(({ account, holder_person_id }) => [account, holder_person_id]), [
      ["editor-one@example.test", PERSON], ["editor-two@example.test", OTHER_PERSON], ["studio-shared@example.test", null],
    ]);
    assert.equal(body.accounts[2].sharedLogin, true);
    assert.equal(body.accounts[2].identityVerified, false);
    const accountQuery = calls.find(({ sql }) => sql.includes("select d.uploader_account account"));
    assert.match(accountQuery.sql, /case when coalesce\(a\.is_shared,false\) then null else a\.holder_person_id end holder_person_id/i);
    assert.ok(calls.some(({ sql }) => sql.includes("credited_to_person") && sql.includes("total_deliveries")));
  } finally {
    await app.close();
  }
});

test("own editor week returns only the viewer's open assigned tasks and safe linked asset URLs", async () => {
  const { app, calls } = appFor({ tasks: [
    { id: "10000000-0000-0000-0000-000000000001", title: "Edit synthetic walkthrough", status: "in_progress",
      dueAt: "2026-10-08T10:00:00.000Z", assetId: "20000000-0000-0000-0000-000000000001",
      assetStore: "gdrive", assetStoreId: "synthetic-drive-id" },
    { id: "10000000-0000-0000-0000-000000000001", title: "Edit synthetic walkthrough", status: "in_progress",
      dueAt: "2026-10-08T10:00:00.000Z", assetId: "20000000-0000-0000-0000-000000000002",
      assetStore: null, assetStoreId: null },
    { id: "10000000-0000-0000-0000-000000000002", title: "Review synthetic cut", status: "open",
      dueAt: null, assetId: null, assetStore: null, assetStoreId: null },
  ] });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/editors/${PERSON}/week?week=2026-W41`,
      headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().openTasks, [
      { id: "10000000-0000-0000-0000-000000000001", title: "Edit synthetic walkthrough", status: "in_progress",
        dueAt: "2026-10-08T10:00:00.000Z", assets: [{ id: "20000000-0000-0000-0000-000000000001",
          url: "https://drive.google.com/file/d/synthetic-drive-id/view" },
        { id: "20000000-0000-0000-0000-000000000002", url: null }] },
      { id: "10000000-0000-0000-0000-000000000002", title: "Review synthetic cut", status: "open", dueAt: null, assets: [] },
    ]);
    const taskQuery = calls.find(({ sql }) => sql.includes("from pulse.task t"));
    assert.ok(taskQuery);
    assert.deepEqual(taskQuery.params, ["6f1a455d-ced2-504d-b8d5-5ae0efbe7c75", PERSON]);
    assert.match(taskQuery.sql, /t\.status not in \('done','cancelled'\)/);
    assert.match(taskQuery.sql, /t\.assignee_person_id=\$2/);
    assert.equal(JSON.stringify(response.json()).includes("assigneePersonId"), false);
  } finally {
    await app.close();
  }
});

test("tenant-scoped config and delivery queries use the installed org rather than PULSE_ORG_ID", async () => {
  const previousOrg = process.env.PULSE_ORG_ID;
  process.env.PULSE_ORG_ID = "00000000-0000-0000-0000-000000000099";
  const { app, calls } = appFor({ deliveries: [
    { path: "root/model final videos/draft.mp4", name: "draft.mp4", kind: "draft" },
  ] });
  if (previousOrg === undefined) delete process.env.PULSE_ORG_ID; else process.env.PULSE_ORG_ID = previousOrg;
  try {
    const response = await app.inject({ method: "GET", url: `/v1/editors/${PERSON}/week?week=2026-W41`,
      headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().types.model_video, {
      target: 5, delivered: { drafts: 1, finals: 0 }, claimed: { drafts: 0, finals: 0 }, gap: 4, placeholder: true,
    });
    const deliveryQuery = calls.find(({ sql }) => sql.includes("from pulse.delivery d join pulse.index_file f"));
    assert.equal(deliveryQuery.params[0], ORG);
  } finally {
    await app.close();
  }
});

test("a person cannot request another editor's weekly report", async () => {
  const { app, calls } = appFor();
  try {
    const response = await app.inject({ method: "GET", url: `/v1/editors/${OTHER_PERSON}/week?week=2026-W41`,
      headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 403);
    assert.equal(calls.some(({ sql }) => sql.includes("from pulse.delivery d join pulse.index_file f")), false);
  } finally {
    await app.close();
  }
});

test("a manager can read a direct report's week and credited-claim counts", async () => {
  const { app, calls } = appFor({ person: OTHER_PERSON, roles: ["manager"], manages: true, deliveries: [
    { path: "root/vovs/claimed-draft.mp4", name: "claimed-draft.mp4", kind: "draft", claimed: true },
  ] });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/editors/${PERSON}/week?week=2026-W41`,
      headers: { "cf-access-authenticated-user-email": EMAIL } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().types.vov, { target: 3, delivered: { drafts: 1, finals: 0 },
      claimed: { drafts: 1, finals: 0 }, gap: 2, placeholder: true });
    assert.ok(calls.some(({ sql, params }) => sql.includes("pulse.manages($1)") && params[0] === PERSON));
    assert.equal(Object.hasOwn(response.json(), "openTasks"), false);
  } finally { await app.close(); }
});

test("admin without a person record can inspect an editor week and writes a nullable-viewer access log", async () => {
  // DE-EA: an admin is one by the role the database gives the account, never by its address.
  const { app, calls } = appFor({ person: null, roles: ["admin"], tasks: [
    { id: "10000000-0000-0000-0000-000000000001", title: "Other editor's task", status: "open", dueAt: null,
      assetId: null, assetStore: null, assetStoreId: null },
  ] });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/editors/${PERSON}/week?week=2026-W41`,
      headers: { "cf-access-authenticated-user-email": "admin@example.test" } });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().types);
    assert.equal(Object.hasOwn(response.json(), "openTasks"), false);
    assert.equal(calls.some(({ sql }) => sql.includes("from pulse.task t")), false);
    const accessLog = calls.find(({ sql }) => sql.includes("insert into privacy.access_log"));
    assert.ok(accessLog);
    assert.equal(accessLog.params[1], null);
    assert.equal(accessLog.params[2], PERSON);
  } finally {
    await app.close();
  }
});
