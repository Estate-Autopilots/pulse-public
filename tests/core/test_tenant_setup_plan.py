"""R53 (migration 0480): repeatable company setup and the activation checklist, on synthetic companies only.

A setup plan (company, address, defaults, modules, role template, object prefix, source registry) is previewed row by
row, writes nothing until applied, applies exactly the previewed rows in one transaction, and a rerun changes nothing.
A company's plan comes back as a setup file the next company starts from: its configuration repeats, its data does not.
A failure part-way leaves nothing behind. A company set up here opens in trial (only its admins, HR and leadership get a
sign-in, in the same sign-in store) and is activated for staff only when every gate passes. Nothing is e-mailed."""
from __future__ import annotations

import hashlib
import re
import uuid
from datetime import date, timedelta

import psycopg
import pytest
from helpers import build_world, new_code
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

BUSINESS = ["pulse.person", "pulse.project", "pulse.client", "pulse.task", "pulse.chat_message", "pulse.people_profile",
            "pulse.unit", "pulse.role_assignment", "pulse.presence_office", "pulse.native_device"]


def hashof(value):
    return hashlib.sha256(value.encode()).hexdigest()


def run(conn, org, sql, args=(), viewer=None, session=None):
    with conn.transaction():
        set_tenant(conn, org, viewer)
        if session:
            conn.execute("select set_config('pulse.session_hash',%s,true)", (session,))
        cur = conn.execute(sql, args)
        return cur.fetchall() if cur.description else None


def one(conn, org, sql, args=(), viewer=None, session=None):
    return run(conn, org, sql, args, viewer, session)[0]


def counts(api, org):
    """Rows per company table as the API role sees them inside one company (row-level security does the scoping)."""
    out = {}
    with api.transaction():
        set_tenant(api, org)
        for t in [r["t"] for r in api.execute("select pulse.tenant_tables() t").fetchall()]:
            with api.transaction():
                try:
                    out[t] = api.execute(f"select count(*) n from {t}").fetchone()["n"]
                except psycopg.errors.InsufficientPrivilege:
                    pass
    return out


@pytest.fixture
def ea(worker, owner, api):
    """The install's own company (first world of the test) and an individual admin of it: the platform operator."""
    w = build_world(worker, owner, api)
    op, hr = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name, role in ((op, "Operator EAMARK", "admin"), (hr, "HR EAMARK", "hr")):
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
    assert one(api, w.org, "select pulse.install_org() o")["o"] == w.org
    w.operator, w.hr = op, hr
    return w


def op(api, ea, sql, *args):
    return one(api, ea.org, "select " + sql + " r", args, viewer=ea.operator)["r"]


def start(api, ea, name="Synthetic Setup Co"):
    return op(api, ea, "pulse.tenant_start(%s)", name)


def spec(code, **company):
    slug = f"syn-{code.lower()}"
    return {
        "company": {"name": f"Synthetic {code} Closers", "slug": slug, "code": code, "timeZone": "Asia/Dubai", "dataRegion": "in",
                    "host": f"{slug}.localhost", "rehearsal": True, **company},
        "modules": {"tasks": True, "chats": False, "finance": False, "attendance": False},
        "rules": [{"role": "member", "action": "task.assign", "scope": "pod"}],
        "sources": [
            {"key": "people-csv", "kind": "csv", "label": "People list", "categories": ["people", "structure"]},
            {"key": "company-drive", "kind": "google_drive", "label": "Company shared drive", "categories": ["documents", "projects"]},
            {"key": "payroll-sheet", "kind": "manual", "label": "Payroll sheet", "categories": ["payroll"], "grants": "hr"},
        ],
    }


def plan(api, ea, setup, body, apply):
    return op(api, ea, "pulse.tenant_plan(%s,%s,%s)", setup, Jsonb(body), apply)


def test_preview_writes_nothing_apply_matches_it_and_a_rerun_keeps_everything(api, ea):
    setup, code = start(api, ea), new_code()
    body = spec(code)
    reserved = one(api, ea.org, "select reserved_org_id r from pulse.tenant_setup where id=%s", (setup,))["r"]
    ea_before = counts(api, ea.org)

    preview = plan(api, ea, setup, body, False)
    assert preview["ok"] and not preview["applied"] and preview["new"], preview["problems"]
    assert preview["orgId"] == str(reserved)
    by_key = {a["key"]: a for a in preview["actions"]}
    assert by_key["storage.prefix"]["after"] == f"orgs/{reserved}/"          # the exact prefix, before anything exists
    assert by_key["module.chats"]["after"] == "off" and by_key["module.tasks"]["after"] == "on"
    assert by_key["rule.member:task.assign"]["after"] == "pod" and by_key["rule.hr:task.assign"]["after"] == "anyone"
    assert by_key["source.payroll-sheet"]["needsApproval"] == ["payroll"]
    assert by_key["copied.none"]["action"] == "none"
    assert {a["action"] for a in preview["actions"]} <= {"create", "none"}
    # The preview wrote nothing: no company, no address, no rows of the reserved company, the setup untouched.
    assert run(api, ea.org, "select * from pulse.host_org(%s)", (body["company"]["host"],)) == []
    assert not any(counts(api, reserved).values())
    assert one(api, ea.org, "select target_org_id t from pulse.tenant_setup where id=%s", (setup,))["t"] is None

    applied = plan(api, ea, setup, body, True)
    assert applied["applied"] and applied["actions"] == preview["actions"] and applied["summary"] == preview["summary"]
    org = uuid.UUID(applied["orgId"])
    assert org == reserved
    row = one(api, org, "select name, slug, code, time_zone, status, activation, rehearsal from pulse.org where id=%s", (org,))
    assert row == {"name": f"Synthetic {code} Closers", "slug": f"syn-{code.lower()}", "code": code, "time_zone": "Asia/Dubai",
                   "status": "setup", "activation": "trial", "rehearsal": True}
    assert one(api, org, "select object_prefix p from pulse.org_storage")["p"] == f"orgs/{org}/"
    assert {r["module"]: r["enabled"] for r in run(api, org, "select module, enabled from pulse.org_module")} == {"tasks": True, "chats": False, "finance": False}
    assert one(api, org, "select attendance_enabled a from pulse.hr_policy")["a"] is False
    rules = {f"{r['role']}:{r['action']}": r["scope"] for r in run(api, org, "select role, action, scope from pulse.work_rule")}
    assert len(rules) == sum(1 for a in applied["actions"] if a["table"] == "pulse.work_rule" and a["action"] == "create") == 9
    assert rules["member:task.assign"] == "pod" and rules["pod_head:task.assign"] == "pod"
    sources = {r["key"]: r for r in run(api, org, "select key, kind, connector, categories, grants, decision from pulse.org_source")}
    assert sources["company-drive"]["connector"] == "ea-connect" and sources["payroll-sheet"]["grants"] == "hr"
    assert {s["decision"] for s in sources.values()} == {"planned"}
    assert one(api, org, "select count(*) n from pulse.org_handover")["n"] == 1
    # Nothing copied: the new company has no business rows; the install company's rows did not move (only its own
    # setup row and audit trail changed).
    after = counts(api, org)
    assert all(after.get(t, 0) == 0 for t in BUSINESS), {t: after.get(t) for t in BUSINESS}
    ea_after = counts(api, ea.org)
    assert {t for t in ea_after if ea_after[t] != ea_before.get(t)} <= {t for t in ea_after if "audit" in t}

    # Rerun: everything keeps, nothing is written (not even an audit change in the company).
    audit = one(api, org, "select count(*) n from pulse.record_change")["n"]
    again = plan(api, ea, setup, body, True)
    assert again["summary"]["create"] == 0 and again["summary"]["update"] == 0, [a for a in again["actions"] if a["action"] not in ("keep", "none")]
    assert counts(api, org) == after
    assert one(api, org, "select count(*) n from pulse.record_change")["n"] == audit
    # A change is an update of that row only.
    changed = plan(api, ea, setup, {"company": {"timeZone": "Asia/Kolkata"}, "modules": {"chats": True}}, True)
    assert sorted(a["key"] for a in changed["actions"] if a["action"] != "keep" and a["action"] != "none") == ["company.timeZone", "module.chats"]
    assert one(api, org, "select time_zone z from pulse.org")["z"] == "Asia/Kolkata"


def test_a_setup_file_repeats_configuration_not_data(api, ea):
    first, code = start(api, ea), new_code()
    plan(api, ea, first, spec(code), True)
    file = op(api, ea, "pulse.tenant_spec(%s)", first)
    assert file["contract"] == "pulse.setup.v1" and [s["key"] for s in file["sources"]] == ["company-drive", "payroll-sheet", "people-csv"]
    org = one(api, ea.org, "select target_org_id t from pulse.tenant_setup where id=%s", (first,))["t"]
    run(api, ea.org, "select pulse.tenant_admin(%s,'Synthetic Admin','admin@first.example.test','Founder')", (first,), viewer=ea.operator)

    second = start(api, ea, "Second synthetic company")
    as_is = plan(api, ea, second, file, False)
    assert not as_is["ok"]
    assert any("short name" in p for p in as_is["problems"]) and any("code" in p for p in as_is["problems"]) and any("web address" in p for p in as_is["problems"])
    code2 = new_code()
    file["company"].update(name=f"Synthetic {code2} Closers", slug=f"syn-{code2.lower()}", code=code2, host=f"syn-{code2.lower()}.localhost")
    made = plan(api, ea, second, file, True)
    org2 = uuid.UUID(made["orgId"])
    assert org2 != org
    assert op(api, ea, "pulse.tenant_spec(%s)", second) | {"company": None} == file | {"company": None}
    assert one(api, org2, "select count(*) n from pulse.person")["n"] == 0          # the first company's admin stayed there
    assert one(api, org, "select count(*) n from pulse.person")["n"] == 1


def test_a_failure_part_way_leaves_nothing_and_the_rerun_completes(api, owner, ea):
    setup, code = start(api, ea), new_code()
    body = spec(code)
    body["sources"].append({"key": "fails", "kind": "manual", "label": "Synthetic failure"})
    reserved = one(api, ea.org, "select reserved_org_id r from pulse.tenant_setup where id=%s", (setup,))["r"]
    # A test-only fault: the last rows of the plan (the registry) fail after the company, its address and defaults.
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        assert re.fullmatch(r"[a-z_][a-z0-9_]*", role)
        owner.execute(f"set local role {role}")
        owner.execute("""create function pulse.r53_test_fail() returns trigger language plpgsql as $$
                         begin if new.label = 'Synthetic failure' then raise exception 'synthetic failure after the company row'; end if; return new; end $$""")
        owner.execute("create trigger r53_test_fail before insert on pulse.org_source for each row execute function pulse.r53_test_fail()")
    try:
        with pytest.raises(psycopg.errors.RaiseException):
            plan(api, ea, setup, body, True)
    finally:
        with owner.transaction():
            owner.execute(f"set local role {role}")
            owner.execute("drop trigger r53_test_fail on pulse.org_source")
            owner.execute("drop function pulse.r53_test_fail()")
    assert run(api, ea.org, "select * from pulse.host_org(%s)", (body["company"]["host"],)) == []
    assert not any(counts(api, reserved).values())
    assert one(api, ea.org, "select target_org_id t, steps from pulse.tenant_setup where id=%s", (setup,)) == {"t": None, "steps": {}}
    done = plan(api, ea, setup, body, True)
    assert done["applied"] and uuid.UUID(done["orgId"]) == reserved
    assert one(api, reserved, "select count(*) n from pulse.org_source")["n"] == 4


def test_plan_problems_collisions_and_who_may_call(api, ea):
    setup, code = start(api, ea), new_code()
    bad = spec(code)
    bad["modules"] = {"tasks": "yes", "payroll": True}
    bad["rules"] = [{"role": "member", "action": "task.assign", "scope": "anyone"}]
    bad["sources"] = [{"key": "x", "kind": "fax", "label": "?"}, {"key": "plug-a", "kind": "plugin", "label": "A plugin"},
                      {"key": "dup-key", "kind": "csv", "label": "One"}, {"key": "dup-key", "kind": "csv", "label": "Two"},
                      {"key": "cats", "kind": "csv", "label": "Odd", "categories": ["salary_slips"]}]
    problems = " | ".join(plan(api, ea, setup, bad, False)["problems"])
    for words in ("each on or off", "not available", "lowercase letters", "google_drive, plugin", "names its connector key",
                  "listed twice", "Categories are"):
        assert words in problems, (words, problems)
    refused = plan(api, ea, setup, bad, True)                  # a plan with problems applies nothing
    assert not refused["ok"] and not refused["applied"]
    assert one(api, ea.org, "select target_org_id t from pulse.tenant_setup where id=%s", (setup,))["t"] is None
    with pytest.raises(psycopg.errors.InvalidParameterValue):     # the wizard's company step raises instead
        op(api, ea, "pulse.tenant_company(%s,%s)", setup, Jsonb(bad["company"] | {"code": "x"}))

    plan(api, ea, setup, spec(code), True)
    org = one(api, ea.org, "select target_org_id t from pulse.tenant_setup where id=%s", (setup,))["t"]
    other = start(api, ea, "Collides")
    clash = plan(api, ea, other, spec(code), False)
    assert not clash["ok"] and len(clash["problems"]) == 3

    # Only the platform operator plans, hands over and activates: not the install's HR, not the new company's admin.
    admin = run(api, ea.org, "select pulse.tenant_admin(%s,'Synthetic Admin','admin@acl.example.test','Founder') r", (setup,), viewer=ea.operator)[0]["r"]["personId"]
    for org_id, viewer in ((ea.org, ea.hr), (org, admin)):
        for sql, args in (("pulse.tenant_plan(%s,%s,false)", (setup, Jsonb(spec(code)))), ("pulse.tenant_spec(%s)", (setup,)),
                          ("pulse.tenant_gates(%s)", (setup,)), ("pulse.tenant_handover(%s,%s)", (setup, Jsonb({"support": "Synthetic desk"}))),
                          ("pulse.tenant_activate(%s)", (setup,))):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                one(api, org_id, "select " + sql, args, viewer=viewer)
    # Each side reads only its own registry and checklist.
    assert one(api, org, "select count(*) n from pulse.org_source where org_id=%s", (ea.org,))["n"] == 0
    assert one(api, ea.org, "select count(*) n from pulse.org_source where org_id=%s", (org,))["n"] == 0
    assert one(api, ea.org, "select pulse.company_setup_state() s", viewer=ea.operator)["s"] == {"managed": False}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, org, "select pulse.company_setup_state()", viewer=None)


def test_trial_then_activation_only_when_every_gate_passes(api, worker, owner, ea):
    setup, code = start(api, ea), new_code()
    body = spec(code, rehearsal=False)
    body["sources"] = [{"key": "people-csv", "kind": "csv", "label": "People list", "categories": ["people"]},
                       {"key": "company-drive", "kind": "google_drive", "label": "Company shared drive", "categories": ["documents"]}]
    org = uuid.UUID(plan(api, ea, setup, body, True)["orgId"])
    domain = f"{code.lower()}.example.test"
    admin = run(api, ea.org, "select pulse.tenant_admin(%s,'Asha Admin',%s,'Founder') r", (setup, f"asha@{domain}"), viewer=ea.operator)[0]["r"]["personId"]
    rows = [{"name": "Hari HR", "email": f"hari@{domain}", "access": "hr"}, {"name": "Mira Member", "email": f"mira@{domain}"},
            {"name": "Sam Same", "email": f"sam1@{domain}"}]
    run(api, ea.org, "select pulse.tenant_people(%s,%s,true)", (setup, Jsonb(rows)), viewer=ea.operator)
    # The CSV import matches a repeated name to the same person; a second "Sam Same" arrives the way HR adds a person.
    sam2 = uuid.uuid4()
    run(worker, org, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Sam Same','staff')", (sam2, org))
    run(worker, org, "insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Closer','sam.same.2',%s,'{}')", (org, sam2, f"sam2@{domain}"))
    people = {r["display_name"]: r["id"] for r in run(api, org, "select id, display_name from pulse.person")}
    run(api, ea.org, "select pulse.tenant_isolation_record(%s,120,0,'[]')", (setup,), viewer=ea.operator)
    assert one(api, ea.org, "select pulse.tenant_open(%s) r", (setup,), viewer=ea.operator)["r"]["opened"]

    # Trial: the admin and HR get a sign-in; a member does not, by any path into the same store.
    run(api, org, "select pulse.login_issue(%s,'Synthetic-issued-2026!')", (admin,), viewer=admin)
    run(api, org, "select pulse.login_issue(%s,'Synthetic-issued-2026!')", (people["Hari HR"],), viewer=admin)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="still in its trial"):
        run(api, org, "select pulse.login_issue(%s,'Synthetic-issued-2026!')", (people["Mira Member"],), viewer=admin)
    batch = one(api, org, "select pulse.invitation_prepare() id", viewer=admin)["id"]       # preparing is fine
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="still in its trial"):
        run(api, org, "select pulse.invitation_link(%s,%s,%s)", (people["Mira Member"], batch, hashof("mira-invite" + code)), viewer=admin)
    run(api, org, "select pulse.invitation_link(%s,%s,%s)", (people["Hari HR"], batch, hashof("hari-invite" + code)), viewer=admin)
    signed = {r["person_id"] for r in run(api, org, "select person_id from pulse.login_credential where status='active'", viewer=admin)}
    assert signed == {uuid.UUID(admin), people["Hari HR"]}

    gates = op(api, ea, "pulse.tenant_gates(%s)", setup)
    assert gates["company"]["activation"] == "trial" and not gates["ready"]
    state = {g["key"]: g["ok"] for g in gates["gates"]}
    assert state == {"admin": False, "identity": False, "sources": False, "devices": False, "walkthrough": False, "isolation": True,
                     "backup": False, "handover": False, "terms": False}     # R54 (0490) adds the pilot's two gates
    refused = op(api, ea, "pulse.tenant_activate(%s)", setup)
    assert refused == {"activated": False, "blocked": gates["blocked"]}

    # Admin proof: the admin signs in with the issued password and turns on two-step verification (the real functions).
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (admin,))
    username = one(api, org, "select username u from pulse.people_profile where person_id=%s", (admin,))["u"]
    session = hashof("r53-admin-session" + code)
    one(api, org, "select pulse.auth_login('staff',%s,'Synthetic-issued-2026!',%s,%s,false,'Fixture') r", (username, hashof("r53-c" + code), session))
    totp = one(api, org, "select pulse.auth_account_action('staff','totp-start',%s,%s) r", (Jsonb({"current": "Synthetic-issued-2026!"}), session), viewer=admin)["r"]
    with owner.transaction():
        otp = owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from clock_timestamp())/30)::bigint) code", (totp["secretHex"],)).fetchone()["code"]
    one(api, org, "select pulse.auth_account_action('staff','totp-enable',%s,%s) r", (Jsonb({"code": otp, "current": "Synthetic-issued-2026!"}), session), viewer=admin)

    # Identity: the two people with one name get distinct names (as the company's admin would on their People page).
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("update pulse.person set display_name='Sam Same (Sales)' where id=(select id from pulse.person where display_name='Sam Same' limit 1)")

    # Sources: the CSV is approved; payroll needs a note; the Drive is declined until the company has its own key (E13).
    srcs = {s["key"]: s for s in op(api, ea, "pulse.tenant_gates(%s)", setup)["sources"]}
    assert not srcs["company-drive"]["ready"] and "Not installed yet" in srcs["company-drive"]["why"]
    run(api, org, "select pulse.company_source_decide(%s,'approved',null)", (srcs["people-csv"]["id"],), viewer=admin)
    payroll = one(api, org, "select pulse.company_source_add(%s) id", (Jsonb({"key": "payroll", "kind": "manual", "label": "Payroll register", "categories": ["payroll"], "grants": "hr"}),), viewer=admin)["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="payroll"):
        run(api, org, "select pulse.company_source_decide(%s,'approved',null)", (payroll,), viewer=admin)
    run(api, org, "select pulse.company_source_decide(%s,'approved','Synthetic: approved by the company admin for this rehearsal')", (payroll,), viewer=admin)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(api, org, "select pulse.company_source_decide(%s,'declined',null)", (srcs["company-drive"]["id"],), viewer=people["Hari HR"])
    run(api, org, "select pulse.company_source_decide(%s,'declined','Synthetic: waiting for its own Google key')", (srcs["company-drive"]["id"],), viewer=admin)

    # R54: the pilot, as a real company needs it: an installed device and HR's walkthrough of the real data, read only.
    run(api, org, "select pulse.company_pilot_check(%s)", (Jsonb({"kind": "device", "platform": "android", "evidence": "installed_device",
        "result": "passed", "covers": ["pair", "check_in"]}),), viewer=admin)
    run(api, org, "select pulse.company_pilot_check(%s)", (Jsonb({"kind": "walkthrough", "evidence": "real_data_read_only", "result": "passed",
        "covers": ["people", "policies"]}),), viewer=people["Hari HR"])

    # Handover: a restore drill in the future or into a shared target does not count; a passed isolated one does.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="after it happened"):
        op(api, ea, "pulse.tenant_handover(%s,%s)", setup, Jsonb({"restore": {"on": str(date.today() + timedelta(days=2)), "minutes": 5, "result": "passed", "isolated": True, "ref": "x" * 5}}))
    op(api, ea, "pulse.tenant_handover(%s,%s)", setup, Jsonb({"restore": {"on": str(date.today()), "minutes": 42, "result": "passed", "isolated": False, "ref": "Synthetic drill receipt"}}))
    assert {g["key"]: g["ok"] for g in op(api, ea, "pulse.tenant_gates(%s)", setup)["gates"]}["backup"] is False
    op(api, ea, "pulse.tenant_handover(%s,%s)", setup, Jsonb({
        "operatorId": str(ea.operator), "support": "Pulse Help, Support desk",
        "restore": {"on": str(date.today()), "minutes": 42, "result": "passed", "isolated": True, "ref": "Synthetic drill receipt"}}))
    gates = op(api, ea, "pulse.tenant_gates(%s)", setup)
    assert gates["blocked"] == ["Privacy terms and the owner's rollout instruction"]
    assert gates["operator"] == str(ea.operator)
    company_view = one(api, org, "select pulse.company_setup_state() s", viewer=admin)["s"]
    assert company_view["managed"] and company_view["handover"]["supportRoute"] == "Pulse Help, Support desk"
    assert str(ea.operator) not in str(company_view) and "EAMARK" not in str(company_view)    # nobody of the install named
    op(api, ea, "pulse.tenant_handover(%s,%s)", setup, Jsonb({"termsRef": "Synthetic E08 terms v1", "rolloutRef": "Synthetic E18 instruction"}))

    assert op(api, ea, "pulse.tenant_activate(%s)", setup) == {"activated": True, "already": False, "blocked": []}
    assert one(api, org, "select activation a from pulse.org")["a"] == "live"
    assert one(api, ea.org, "select status s from pulse.tenant_setup where id=%s", (setup,))["s"] == "live"
    run(api, org, "select pulse.login_issue(%s,'Synthetic-issued-2026!')", (people["Mira Member"],), viewer=admin)
    assert op(api, ea, "pulse.tenant_activate(%s)", setup)["already"] is True
    # Nothing was e-mailed or sent along the way.
    assert one(api, org, "select count(*) n from pulse.notification_delivery")["n"] == 0
    with owner.transaction():
        set_tenant(owner, org)
        assert owner.execute("select count(*) n from pulse_priv.staff_invitation where status in ('sending','sent')").fetchone()["n"] == 0


def test_activation_needs_an_open_company_and_live_companies_are_untouched(api, worker, owner, ea):
    setup, code = start(api, ea), new_code()
    plan(api, ea, setup, spec(code), True)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Open the company"):
        op(api, ea, "pulse.tenant_activate(%s)", setup)
    # A company that was not set up here (and the install's own) is live: nothing about its sign-in changes.
    other = build_world(worker, owner, api)
    assert one(api, other.org, "select activation a from pulse.org")["a"] == "live"
    run(worker, other.org, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (other.org, other.manager))
    run(worker, other.org, "insert into pulse.people_profile(org_id,person_id,role,username,evidence) values(%s,%s,'Editor','r53.other','{}') on conflict do nothing", (other.org, other.editor))
    run(api, other.org, "select pulse.login_issue(%s,'Synthetic-issued-2026!')", (other.editor,), viewer=other.manager)
    assert one(api, other.org, "select count(*) n from pulse.login_credential where person_id=%s", (other.editor,), viewer=other.manager)["n"] == 1


def test_no_second_sign_in_store(admin):
    cols = admin.execute("""select table_schema || '.' || table_name t, column_name c from information_schema.columns
                            where (table_schema, table_name) in (('pulse','org_storage'),('pulse','org_source'),('pulse','org_handover'))""").fetchall()
    assert len({r["t"] for r in cols}) == 3
    assert not [r for r in cols if any(w in r["c"] for w in ("password", "hash", "token", "secret", "totp", "credential"))]
