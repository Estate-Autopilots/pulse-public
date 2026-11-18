import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { countedWorkdays, loadDesignerTargets, singleImageExpectation } from "../dist/editor-targets.js";
const ORG = "6f1a455d-ced2-504d-b8d5-5ae0efbe7c75";
const OTHER_ORG = "00000000-0000-0000-0000-000000000099";
const PERSON = "00000000-0000-0000-0000-000000000001";
const REPORT = "00000000-0000-0000-0000-000000000002";
const OUTSIDER = "00000000-0000-0000-0000-000000000003";
const EMAILS = { admin: "admin@example.test", leadership: "leader@example.test", manager: "manager@example.test", person: "designer@example.test", staff: "staff@example.test" };
const PEOPLE = [
  { personId: PERSON, name: "Sam Designer", role: "Graphic Designer", manager: false },
  { personId: REPORT, name: "Asha Designer", role: "Graphic Designer", managerId: PERSON },
  { personId: OUTSIDER, name: "Zed Editor", role: "Video Editor", manager: false },
];
const FILES = [
  { path: "Creatives/Logos", name: "private-logo.png", mime: "image/png", eventDay: "2026-10-06",
    personId: PERSON, sharedLogin: false, hasDelivery: true, claimed: false },
  { path: "Creatives/Logos", name: "report-logo.png", mime: "image/png", eventDay: "2026-10-06",
    personId: REPORT, sharedLogin: false, hasDelivery: true, claimed: false, teamPersonId: PERSON },
  { path: "Creatives/Social Ads", name: "other-ad.png", mime: "image/png", eventDay: "2026-10-06",
    personId: OUTSIDER, sharedLogin: false, hasDelivery: true, claimed: false },
  { path: "Creatives/Logos", name: "shared-one.pdf", mime: "application/pdf", eventDay: "2026-10-07",
    personId: REPORT, sharedLogin: false, hasDelivery: true, claimed: true, claimStatus: "confirmed", teamPersonId: PERSON },
  { path: "Creatives/Carousels", name: "shared-two.png", mime: "image/png", eventDay: "2026-10-07",
    personId: null, sharedLogin: true, hasDelivery: true, claimed: false, claimStatus: "pending", teamPersonId: PERSON },
  { path: "Creatives/Logos", name: "shared-rejected.pdf", mime: "application/pdf", eventDay: "2026-10-07",
    personId: null, sharedLogin: true, hasDelivery: true, claimed: false, claimStatus: "rejected", teamPersonId: PERSON },
  { path: "Creatives/Exports", name: "unclassified.pdf", mime: "application/pdf", eventDay: "2026-10-07",
    personId: REPORT, sharedLogin: false, hasDelivery: false, claimed: false, teamPersonId: PERSON },
];
const CONFIG = { design_type_rules: { folder_path: [
  { match: "logos", type: "logo" }, { match: "social ads", type: "single_image_ad" },
  { match: "carousels", type: "carousel" },
] } };
const TARGETS = {
  designers: { roles: ["Graphic Designer"], single_image: { per_day: 2, placeholder: true } },
  windows: { logo: { days: { min: 2, max: 5 }, placeholder: true } },
};
function appFor({ role = "person", person = PERSON, org = ORG, brandProjects = [], workDays = [1, 2, 3, 4, 5, 6], holidays = ["2026-10-06"] } = {}) {
  const calls = [];
  const previousPublicLogin = process.env.PULSE_PUBLIC_LOGIN_ENABLED;
  const previousOrg = process.env.PULSE_ORG_ID;
  process.env.PULSE_PUBLIC_LOGIN_ENABLED = "0";
  process.env.PULSE_ORG_ID = org;
  const client = {
    async query(sql, params = []) {
      if (sql.includes("pulse.auth_enforcement")) return { rows: [{ blocked: false }] };
      calls.push({ sql, params });
      const normalized = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalized) || sql.includes("set_config")) return { rows: [] };
      if (sql.includes("privacy.access_log") || sql.includes("pulse.audit_signin")) return { rows: [] };
      if (sql.includes("select p.id person,p.display_name name")) {
        return { rows: [{ person, name: "Synthetic Designer", status: "active", pod: null, username: "synthetic",
          accounts: [EMAILS[role]], roles: [role] }] };
      }
      if (normalized.includes("(now() at time zone (select pulse.org_time_zone()))::date::text today")) {
        return { rows: [{ today: "2026-10-07", monday: "2026-10-05", zone: "Asia/Kolkata" }] };
      }
      if (normalized.includes("to_date($1,'iyyy-\"w\"iw')")) return { rows: [{ valid: true, monday: "2026-10-05", start: new Date("2026-10-04T18:30:00Z"), end: new Date("2026-10-11T18:30:00Z") }] };
      if (normalized.includes("select to_char($1::date,'iyyy-\"w\"iw') week")) return { rows: [{ week: "2026-W41", dow: 1 }] };
      if (sql.includes('select p.id "personId",p.display_name name')) {
        if (params[0] !== ORG) return { rows: [] };
        const scope = params[1]; const roles = params[2] ?? [];
        return { rows: PEOPLE.filter(item => scope === null || scope === "person:" + item.personId ||
          scope === "team:" + person && (item.managerId === person || item.personId === person))
          .filter(item => roles.includes(item.role.trim().toLocaleLowerCase("en")))
          .map(({ personId, name, role: personRole }) => ({ personId, name, role: personRole })) };
      }
      if (sql.includes("doc_key='designers'")) return { rows: params[0] === ORG ? [{ body: TARGETS }] : [] };
      if (sql.includes("select role from pulse.people_profile")) return { rows: params[0] === ORG ? [{ role: PEOPLE.find(item => item.personId === params[1])?.role }] : [] };
      if (sql.includes("select work_days from pulse.hr_policy")) return { rows: params[0] === ORG ? [{ work_days: workDays }] : [] };
      if (sql.includes("select h.day::text as holiday_day from pulse.holiday")) return { rows: params[0] === ORG ? holidays.filter(day => day >= params[1] && day <= params[2]).map(day => ({ holiday_day: day })) : [] };
      if (sql.includes("select body from pulse.tenant_config")) return { rows: params[0] === ORG ? [{ body: CONFIG }] : [] };
      if (sql.includes("eligible as (")) {
        if (params[0] !== ORG) return { rows: [] };
        const scope = params[3];
        return { rows: FILES.filter(file => scope === null || scope === "person:" + person && file.personId === person ||
          scope === "team:" + person && (file.personId === person || file.teamPersonId === person))
          .map(({ teamPersonId: _teamPersonId, claimStatus: _claimStatus, ...file }) => file) };
      }
      if (sql.includes("from pulse.task t join pulse.project p")) {
        return { rows: params[0] === ORG ? brandProjects : [] };
      }
      throw new Error("Unexpected synthetic query: " + sql);
    },
    release() {},
  };
  const restore = () => {
    if (previousPublicLogin === undefined) delete process.env.PULSE_PUBLIC_LOGIN_ENABLED;
    else process.env.PULSE_PUBLIC_LOGIN_ENABLED = previousPublicLogin;
    if (previousOrg === undefined) delete process.env.PULSE_ORG_ID;
    else process.env.PULSE_ORG_ID = previousOrg;
  };
  return { app: createApp({ query: async () => ({ rows: [{ org_id: process.env.PULSE_ORG_ID ?? ORG }] }) }, { connect: async () => client }), calls, restore };
}
test("designer target loader keeps unset targets explicit and validates window ranges", () => {
  const targets = loadDesignerTargets(TARGETS);
  assert.deepEqual(targets.singleImage, { per_day: 2, placeholder: true });
  assert.deepEqual(targets.roles, ["graphic designer"]);
  assert.deepEqual(targets.windows.logo, { days: { min: 2, max: 5 }, placeholder: true });
  assert.deepEqual(targets.windows.brand_identity, { days: { min: null, max: null }, placeholder: true });
  assert.deepEqual(singleImageExpectation(targets.singleImage, 3, 7),
    { perDay: 2, expected: 14, delivered: 3, gap: 11, placeholder: true });
  assert.throws(() => loadDesignerTargets({
    designers: { single_image: { per_day: -1, placeholder: true } },
  }), /per_day/);
  assert.throws(() => loadDesignerTargets({
    windows: { logo: { days: { min: 6, max: 3 }, placeholder: false } },
  }), /days range/);
  assert.throws(() => loadDesignerTargets({
    designers: { roles: "Graphic Designer", single_image: { per_day: 1, placeholder: true } },
  }), /designer roles/);
});

test("designer expectations count workdays, skip holidays and stop at today", () => {
  const workDays = [1, 2, 3, 4, 5, 6];
  const noHolidays = new Set();
  assert.equal(countedWorkdays("2026-10-04", "2026-10-04", "2026-10-07", workDays, noHolidays, false), 0);
  assert.deepEqual(singleImageExpectation({ per_day: 1, placeholder: true }, 1,
    countedWorkdays("2026-10-04", "2026-10-04", "2026-10-07", workDays, noHolidays, false)),
  { perDay: 1, expected: 0, delivered: 1, gap: 0, placeholder: true });
  assert.equal(countedWorkdays("2026-10-06", "2026-10-06", "2026-10-07", workDays, new Set(["2026-10-06"]), false), 0);
  assert.equal(countedWorkdays("2026-10-05", "2026-10-11", "2026-10-07", workDays, new Set(["2026-10-06"]), true), 2);
});

test("admins and leadership receive alphabetized weekly counts without file details", async () => {
  for (const role of ["admin", "leadership"]) {
    const { app, calls, restore } = appFor({ role, person: null });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v0/designers?week=2026-W41",
        headers: { "cf-access-authenticated-user-email": EMAILS[role] } });
      assert.equal(response.statusCode, 200); const body = response.json();
      assert.equal(body.week, "2026-W41");
      assert.deepEqual(body.designers.map(row => row.name), ["Asha Designer", "Sam Designer", "shared login"]);
      assert.deepEqual(body.designers.find(row => row.name === "shared login").types, {
        single_image_ad: 0, carousel: 1, brochure: 0, logo: 1, pitch_deck: 0, other: 0,
      });
      assert.equal(body.designers.find(row => row.name === "Asha Designer").types.logo, 2);
      assert.deepEqual(body.designers.find(row => row.name === "Asha Designer").claimed, {
        single_image_ad: 0, carousel: 0, brochure: 0, logo: 1, pitch_deck: 0, other: 0,
      });
      assert.deepEqual(body.designers.find(row => row.name === "shared login").claimed, {
        single_image_ad: 0, carousel: 0, brochure: 0, logo: 0, pitch_deck: 0, other: 0,
      });
      assert.deepEqual(body.designers.find(row => row.name === "Sam Designer").singleImage,
        { perDay: 2, expected: 4, delivered: 0, gap: 4, placeholder: true });
      assert.deepEqual(body.designers.find(row => row.name === "shared login").singleImage,
        { perDay: null, expected: null, delivered: 0, gap: null, placeholder: true });
      const access = calls.find(({ sql }) => sql.includes("insert into privacy.access_log"));
      assert.match(access.sql, /'week','design_delivery_weekly_counts'/);
      const forbidden = new Set(["rank", "position", "topN", "fileName", "fileId", "path", "account"]);
      const visit = value => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          assert.equal(forbidden.has(key), false);
          visit(child);
        }
      };
      visit(body);
      assert.equal(JSON.stringify(body).includes("private-logo.png"), false);
    } finally { await app.close(); restore(); }
  }
});

test("managers see team rows and shared work once; staff see only their own row", async () => {
  const managerApp = appFor({ role: "manager" });
  try {
    const response = await managerApp.app.inject({ method: "GET", url: "/api/v0/designers",
      headers: { "cf-access-authenticated-user-email": EMAILS.manager } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().designers.map(row => row.name), ["Asha Designer", "Sam Designer", "shared login"]);
    assert.equal(response.json().designers.find(row => row.name === "Asha Designer").types.logo, 2);
    assert.equal(response.json().designers.find(row => row.name === "Asha Designer").claimed.logo, 1);
    assert.equal(response.json().designers.find(row => row.name === "Sam Designer").types.logo, 1);
    const shared = response.json().designers.find(row => row.name === "shared login");
    assert.equal(shared.types.logo, 1);
    assert.equal(shared.types.carousel, 1);
    assert.equal(Object.values(shared.claimed).reduce((sum, count) => sum + count, 0), 0);
    const roster = managerApp.calls.find(({ sql }) => sql.includes('select p.id "personId",p.display_name name'));
    assert.match(roster.sql, /pulse\.manages\(p\.id\)/);
    assert.match(roster.sql, /p\.id=pulse\.current_viewer\(\)/);
    assert.deepEqual(roster.params[2], ["graphic designer"]);
    const files = managerApp.calls.find(({ sql }) => sql.includes("eligible as ("));
    assert.match(files.sql, /f\.project_id=any\(pulse\.work_projects\(\)\)/);
    assert.match(files.sql, /credit\.person_id=pulse\.current_viewer\(\)/);
    assert.match(files.sql, /pulse\.manages\("personId"\)/);
    assert.match(files.sql, /pulse\.design_claim_person\(f\.file_id\)/);
    assert.doesNotMatch(files.sql, /from pulse\.delivery_claim/);
  } finally { await managerApp.app.close(); managerApp.restore(); }
  const staffApp = appFor();
  try {
    const response = await staffApp.app.inject({ method: "GET", url: "/api/v0/designers",
      headers: { "cf-access-authenticated-user-email": EMAILS.person } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().designers.map(row => row.name), ["Sam Designer"]);
    assert.equal(response.json().designers[0].types.logo, 1);
    assert.equal(Object.values(response.json().designers[0].claimed).reduce((sum, count) => sum + count, 0), 0);
    assert.equal(staffApp.calls.find(({ sql }) => sql.includes("eligible as (")).params[3], "person:" + PERSON);
  } finally { await staffApp.app.close(); staffApp.restore(); }
  const anotherTeamManager = appFor({ role: "manager", person: OUTSIDER });
  try {
    const response = await anotherTeamManager.app.inject({ method: "GET", url: "/api/v0/designers",
      headers: { "cf-access-authenticated-user-email": EMAILS.manager } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().designers.some(row => row.personId === REPORT), false);
    assert.equal(response.json().designers.some(row => Object.values(row.claimed).some(count => count > 0)), false);
  } finally { await anotherTeamManager.app.close(); anotherTeamManager.restore(); }
});
test("daily detail is self-only for people and staff, denies managers, and logs day grain", async () => {
  const own = appFor();
  try {
    const response = await own.app.inject({ method: "GET", url: "/api/v0/designers/" + PERSON + "?week=2026-W41",
      headers: { "cf-access-authenticated-user-email": EMAILS.person } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().days.length, 7);
    assert.deepEqual(response.json().singleImage,
      { perDay: 2, expected: 4, delivered: 0, gap: 4, placeholder: true });
    assert.deepEqual(response.json().days[0].singleImage,
      { perDay: 2, expected: 2, delivered: 0, gap: 2, placeholder: true });
    assert.equal(response.json().days[2].claimed.logo, 0);
    assert.deepEqual(response.json().days[1].singleImage,
      { perDay: 2, expected: 0, delivered: 0, gap: 0, placeholder: true });
    assert.deepEqual(response.json().days[6].singleImage,
      { perDay: 2, expected: 0, delivered: 0, gap: 0, placeholder: true });
    const access = own.calls.find(({ sql }) => sql.includes("insert into privacy.access_log"));
    assert.match(access.sql, /'day','design_delivery_daily_self'/);
    const detail = await own.app.inject({ method: "GET", url: "/api/v0/designers/" + REPORT,
      headers: { "cf-access-authenticated-user-email": EMAILS.person } });
    assert.equal(detail.statusCode, 403);
  } finally { await own.app.close(); own.restore(); }
  const claimant = appFor({ person: REPORT });
  try {
    const response = await claimant.app.inject({ method: "GET", url: "/api/v0/designers/" + REPORT + "?week=2026-W41",
      headers: { "cf-access-authenticated-user-email": EMAILS.person } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().days[2].types.logo, 1);
    assert.equal(response.json().days[2].claimed.logo, 1);
  } finally { await claimant.app.close(); claimant.restore(); }
  const manager = appFor({ role: "manager" });
  try {
    const self = await manager.app.inject({ method: "GET", url: "/api/v0/designers/" + PERSON,
      headers: { "cf-access-authenticated-user-email": EMAILS.manager } });
    assert.equal(self.statusCode, 403);
    const response = await manager.app.inject({ method: "GET", url: "/api/v0/designers/" + REPORT,
      headers: { "cf-access-authenticated-user-email": EMAILS.manager } });
    assert.equal(response.statusCode, 403);
    assert.equal(manager.calls.filter(({ sql }) => sql.includes("eligible as (")).length, 0);
  } finally { await manager.app.close(); manager.restore(); }
  const staff = appFor({ role: "staff" });
  try {
    const response = await staff.app.inject({ method: "GET", url: "/api/v0/designers/" + PERSON,
      headers: { "cf-access-authenticated-user-email": EMAILS.staff } });
    assert.equal(response.statusCode, 200);
  } finally { await staff.app.close(); staff.restore(); }
});

test("open brand project report adds tenant windows, scopes subjects, and omits labels", async () => {
  const { app, calls, restore } = appFor({ role: "manager", brandProjects: [{
    personId: REPORT, projectId: "10000000-0000-0000-0000-000000000090", deliverableType: "LG",
    openedOn: "2026-10-01", daysOpen: 6,
  }] });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/designers/brand-projects/open",
      headers: { "cf-access-authenticated-user-email": EMAILS.manager } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { brandProjects: [{
      personId: REPORT, projectId: "10000000-0000-0000-0000-000000000090", brandAsset: "logo",
      openedOn: "2026-10-01", daysOpen: 6,
      window: { days: { min: 2, max: 5 }, placeholder: true },
    }] });
    const query = calls.find(({ sql }) => sql.includes("from pulse.task t join pulse.project p"));
    assert.match(query.sql, /t\.org_id=\$1/);
    assert.match(query.sql, /pulse\.manages\(t\.assignee_person_id\)/);
    assert.deepEqual(query.params.slice(0, 2), [ORG, ["logo", "LG", "colour_palette", "CL", "brochure", "BR", "pitch_deck", "PD", "brand_identity", "BI"]]);
    const access = calls.find(({ sql }) => sql.includes("designers.brand_projects"));
    assert.match(access.sql, /unnest\(\$3::uuid\[\]\)/);
    assert.deepEqual(access.params[2], [REPORT]);
    assert.equal(JSON.stringify(response.json()).includes("project title"), false);
  } finally { await app.close(); restore(); }
});

test("designer queries are tenant-scoped", async () => {
  const { app, calls, restore } = appFor({ org: OTHER_ORG });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v0/designers",
      headers: { "cf-access-authenticated-user-email": EMAILS.person } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().designers, []);
    const roster = calls.find(({ sql }) => sql.includes('select p.id "personId",p.display_name name'));
    const files = calls.find(({ sql }) => sql.includes("eligible as ("));
    assert.match(roster.sql, /p\.org_id=\$1/);
    assert.match(files.sql, /f\.org_id=\$1/);
    assert.equal(roster.params[0], OTHER_ORG);
    assert.equal(files.params[0], OTHER_ORG);
    const brand = await app.inject({ method: "GET", url: "/api/v0/designers/brand-projects/open",
      headers: { "cf-access-authenticated-user-email": EMAILS.person } });
    assert.equal(brand.statusCode, 200);
    assert.deepEqual(brand.json(), { brandProjects: [] });
    const brandQuery = calls.find(({ sql }) => sql.includes("from pulse.task t join pulse.project p"));
    assert.match(brandQuery.sql, /t\.org_id=\$1/);
    assert.equal(brandQuery.params[0], OTHER_ORG);
  } finally { await app.close(); restore(); }
});
