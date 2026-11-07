"""R54 (migration 0490): the second-company path end to end, on synthetic companies only, plus the pilot's gates.

One walk proves the path a company like Atlas Crest takes, in a throwaway database: the install's company (EA's
synthetic stand-in) plans and creates "tenant two", its admin signs in with two-step verification, registers its
sources, installs EA Connect with its own key and its own plugin, a synthetic Drive edit and a signed plugin batch land
in tenant two only, a device pairs there and not at EA's address, a stalled reader and a source permission removed at
Google close the source gate without deleting anything, a revoked plugin stops, a restore into an isolated database
keeps both companies apart, the pilot records its device and HR checks and anonymous feedback, and only then does
activation pass. EA's rows are fingerprinted before and after: untouched. Every Drive is FakeDrive, every key and
person synthetic, nothing is e-mailed: mock evidence, never a live company launch."""
from __future__ import annotations

import json
import math
import os
import subprocess
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from random import SystemRandom
from types import SimpleNamespace

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pulse_gdrive_changes import connect, feed
from pulse_gdrive_changes.drive import AccessLost
from pulse_sdk.db import set_tenant
from test_company_connectors import (SYNTHETIC_KEY, add_root, approve, batch, ea_connect, key_file, plugin,
                                     plugin_manifest, push, record, revoke, sa, secrets, status)  # noqa: F401
from test_drive_changes import FakeDrive
from test_drive_extract import _pg_bin
from test_tenant_setup_plan import counts, ea, hashof, new_code, one, op, plan, run, spec, start  # noqa: F401
from test_acceptance_isolation import GLOBAL_ALLOW_LIST  # owner-only tables outside tenant RLS by design

PASSWORD = "Synthetic-issued-2026!"
secrets_choice = SystemRandom().choice
# Rows the operator's own work writes on the install company's side: its setup record and the audit of its actions.
OPERATOR_SIDE = {"pulse.tenant_setup", "pulse.audit_event"}


def fingerprint(owner, org):
    """Every company table's rows of one company: count and a content hash (filtered by org_id, whatever the role)."""
    with owner.transaction():
        tables = [r["t"] for r in owner.execute(
            """select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
                where n.nspname in ('pulse','pulse_priv','privacy') and c.relkind in ('r','p') and not c.relispartition
                order by 1""").fetchall()]
    out = {}
    for t in tables:
        with owner.transaction():
            set_tenant(owner, org)
            row = owner.execute(f"select count(*) n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h "
                                f"from {t} x where x.org_id = %s", (org,)).fetchone()
            out[t] = (row["n"], row["h"])
    return out


def isolation_check(api, org):
    """What the wizard's isolation check does (POST /api/v0/tenants/:id/check): every company table the API role reads,
    inside the company; any row of another company, or a second company in pulse.org, is a leak."""
    tables = leaks = 0
    with api.transaction():
        set_tenant(api, org)
        names = [r["t"] for r in api.execute("select pulse.tenant_tables() t").fetchall()]
        for t in names:
            try:
                with api.transaction():
                    leaks += api.execute(f"select count(*) n from {t} where org_id is distinct from %s", (org,)).fetchone()["n"]
                    tables += 1
            except psycopg.errors.InsufficientPrivilege:
                pass
        leaks += api.execute("select count(*) n from pulse.org").fetchone()["n"] - 1
    return tables, leaks


def gates(api, ea, setup):
    g = op(api, ea, "pulse.tenant_gates(%s)", setup)
    return g, {x["key"]: x["ok"] for x in g["gates"]}


def source(api, ea, setup, key):
    return next(s for s in op(api, ea, "pulse.tenant_gates(%s)", setup)["sources"] if s["key"] == key)


def sign_in_with_two_step(api, owner, org, admin, code):
    """The admin's proof (R53): the ordinary sign-in with an issued password, then two-step verification."""
    run(api, org, "select pulse.login_issue(%s,%s)", (admin, PASSWORD), viewer=admin)
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("update pulse.login_credential set must_change=false where person_id=%s", (admin,))
    username = one(api, org, "select username u from pulse.people_profile where person_id=%s", (admin,))["u"]
    session = hashof("r54-admin-session" + code)
    one(api, org, "select pulse.auth_login('staff',%s,%s,%s,%s,false,'Fixture') r", (username, PASSWORD, hashof("r54-c" + code), session))
    totp = one(api, org, "select pulse.auth_account_action('staff','totp-start',%s,%s) r", (Jsonb({"current": PASSWORD}), session), viewer=admin)["r"]
    with owner.transaction():
        otp = owner.execute("select pulse.auth_totp(decode(%s,'hex'),floor(extract(epoch from clock_timestamp())/30)::bigint) code", (totp["secretHex"],)).fetchone()["code"]
    one(api, org, "select pulse.auth_account_action('staff','totp-enable',%s,%s) r", (Jsonb({"code": otp, "current": PASSWORD}), session), viewer=admin)


def restore_drill(api, org_ids, secrets_seen):
    """pg_dump of this throwaway database restored into a fresh, separate one: both companies' rows come back exactly
    and stay apart under row-level security; no secret is in the backup. None when this machine cannot run it."""
    from conftest import ADMIN_URL, MODE, dsn
    if MODE["value"] != "superuser":
        return None
    server = int(api.execute("show server_version_num").fetchone()["server_version_num"]) // 10000
    dump, restore = _pg_bin("pg_dump", server), _pg_bin("pg_restore", server)
    if not dump or not restore:
        return None
    source_db = conninfo_to_dict(ADMIN_URL)["dbname"]
    target_db = f"pulse_ci_restore_{uuid.uuid4().hex[:10]}"
    archive = Path(os.environ.get("TMPDIR", "/tmp")) / f"{target_db}.dump"
    before = {org: counts(api, org) for org in org_ids}
    started = time.monotonic()
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'create database "{target_db}"')
    try:
        subprocess.run([dump, "-Fc", "-Z", "0", "-f", str(archive), "-d", ADMIN_URL], check=True, capture_output=True)
        subprocess.run([restore, "--exit-on-error", "-d", make_conninfo(ADMIN_URL, dbname=target_db), str(archive)],
                       check=True, capture_output=True)
        seconds = time.monotonic() - started
        raw = archive.read_bytes()
        assert not [s for s in secrets_seen if s.encode() in raw], "a secret reached the backup"
        with psycopg.connect(make_conninfo(dsn("api"), dbname=target_db), autocommit=True, row_factory=dict_row) as restored:
            assert restored.execute("select current_database() d").fetchone()["d"] not in (source_db,)
            for org in org_ids:
                assert counts(restored, org) == before[org], f"restored rows differ for {org}"
                tables, leaks = isolation_check(restored, org)
                assert tables > 100 and leaks == 0
            forced = restored.execute("""select count(*) filter (where not c.relforcerowsecurity) n from pg_class c
                                           join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id'
                                          where s.nspname in ('pulse','pulse_priv') and c.relkind = 'r' and not c.relispartition
                                            and s.nspname || '.' || c.relname <> all(%s)""", (sorted(GLOBAL_ALLOW_LIST),)).fetchone()["n"]
            assert forced == 0, "row-level security is forced on every company table of the restored copy"
        return {"target": target_db, "minutes": max(1, math.ceil(seconds / 60)), "seconds": round(seconds, 1)}
    finally:
        archive.unlink(missing_ok=True)
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{target_db}" with (force)')


def test_tenant_two_walks_the_whole_path_and_ea_stays_untouched(api, worker, owner, ingest, ea, secrets, tmp_path):
    ea_before = fingerprint(owner, ea.org)

    # 1. The operator plans tenant two (preview first, then exactly those rows), with three registered sources.
    setup, code = start(api, ea, "Tenant Two Rehearsal"), new_code()
    body = spec(code)
    body["sources"] = [{"key": "people-csv", "kind": "csv", "label": "People list", "categories": ["people", "structure"]},
                       {"key": "company-drive", "kind": "google_drive", "label": "Company shared drive", "categories": ["documents", "projects"]},
                       {"key": "company-plugin", "kind": "plugin", "connector": "acme-sync", "label": "Company plugin", "categories": ["projects"]}]
    preview = plan(api, ea, setup, body, False)
    assert preview["ok"] and not preview["applied"]
    applied = plan(api, ea, setup, body, True)
    assert applied["actions"] == preview["actions"]
    org = uuid.UUID(applied["orgId"])
    domain = f"{code.lower()}.example.test"
    admin = uuid.UUID(run(api, ea.org, "select pulse.tenant_admin(%s,'Tara Admin',%s,'Founder') r", (setup, f"tara@{domain}"), viewer=ea.operator)[0]["r"]["personId"])
    rows = [{"name": "Hema HR", "email": f"hema@{domain}", "access": "hr"}, {"name": "Mo Member", "email": f"mo@{domain}"}]
    rows += [{"name": f"Lead {i}", "email": f"lead{i}@{domain}"} for i in range(3)]
    run(api, ea.org, "select pulse.tenant_people(%s,%s,true)", (setup, Jsonb(rows)), viewer=ea.operator)
    people = {r["display_name"]: r["id"] for r in run(api, org, "select id, display_name from pulse.person")}
    for i in range(3):        # leadership can sign in during the trial, so they are pilot participants too
        run(worker, org, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2020-01-01')", (org, people[f"Lead {i}"]))
    t2 = SimpleNamespace(org=org, manager=admin)

    # 2. The isolation check (the wizard's own reads) and opening the trial.
    tables, leaks = isolation_check(api, org)
    assert tables > 100 and leaks == 0
    run(api, ea.org, "select pulse.tenant_isolation_record(%s,%s,%s,'[]')", (setup, tables, leaks), viewer=ea.operator)
    assert one(api, ea.org, "select pulse.tenant_open(%s) r", (setup,), viewer=ea.operator)["r"]["opened"]
    sign_in_with_two_step(api, owner, org, admin, code)
    run(api, org, "select pulse.login_issue(%s,%s)", (people["Hema HR"], PASSWORD), viewer=admin)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="still in its trial"):
        run(api, org, "select pulse.login_issue(%s,%s)", (people["Mo Member"], PASSWORD), viewer=admin)
    _, state = gates(api, ea, setup)
    assert state["admin"] and state["identity"] and state["isolation"]
    assert not state["sources"] and not state["devices"] and not state["walkthrough"]

    # 3. Sources: the CSV approved by the company's admin; EA Connect with tenant two's own key and root; its own plugin.
    run(api, org, "select pulse.company_source_decide(%s,'approved',null)", (source(api, ea, setup, "people-csv")["id"],), viewer=admin)
    assert "Not installed yet" in source(api, ea, setup, "company-drive")["why"]
    drive_install = ea_connect(api, t2)
    add_root(api, t2, drive_install, ref="t2-shared", label="Tenant two deliverables")
    assert "waiting for the admin's grant" in source(api, ea, setup, "company-drive")["why"]
    t2_account = sa("tenant-two-reader")
    connect.install_secret(worker, org, drive_install, key_file(tmp_path, t2_account))
    approve(api, t2, drive_install)
    plugin_install, plugin_key, _ = plugin(api, t2, plugin_manifest(key="acme-sync"))
    add_root(api, t2, plugin_install, kind="folder", ref="plugin-root", label="Plugin root")
    approve(api, t2, plugin_install, entities=["drive.file.created", "drive.file.updated"])
    assert source(api, ea, setup, "company-drive")["ready"] and source(api, ea, setup, "company-plugin")["ready"]
    assert gates(api, ea, setup)[1]["sources"]

    # 4. A synthetic edit in tenant two's Drive and a signed plugin batch reach tenant two, once, and nobody else.
    drive = FakeDrive()

    def api_for(src):
        path, _subject = connect.credential_for(src, ea.org)
        assert path == secrets / str(org) / "ea-connect.json", "tenant two is read with its own key only"
        return drive

    feed.run_once(worker, org, api_for)
    drive.put("t2file1", "Synthetic listing brief.pdf", ["t2-shared"], drive_id="t2-shared", mime="application/pdf")
    due = datetime.now(UTC) + timedelta(hours=1)
    for _ in range(2):
        feed.run_once(worker, org, api_for, now=lambda: due)
    sent = push(ingest, plugin_install, plugin_key, batch("plugin-root", "t2-0001", [record("t2plugin1")]))
    assert sent.status == 200 and sent.body["accepted"] == 1, sent.body
    subjects = ("file:gdrive:t2file1", "file:gdrive:t2plugin1")
    seen = lambda o: run(worker, o, "select count(*) n from pulse.event where subject = any(%s)", (list(subjects),))[0]["n"]
    assert (seen(org), seen(ea.org)) == (2, 0)
    accepted = {"events": seen(org), "files": run(worker, org, "select count(*) n from pulse.drive_source_file")[0]["n"]}
    assert accepted["files"] == 1
    roots = {s["label"]: s for i in status(api, t2) for s in i["sources"]}
    assert roots["Tenant two deliverables"]["cursor"]["files"] == 1 and roots["Plugin root"]["cursor"]["records"] == 1
    assert one(api, ea.org, "select pulse.connector_status() s", viewer=ea.operator)["s"] == []      # EA has none

    # 5. A device pairs at tenant two's address and its token means nothing at EA's.
    poll, access = hashof("poll" + code), hashof("access" + code)
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    pair_code = "".join(secrets_choice(letters) for _ in range(4)) + "-" + "".join(secrets_choice(letters) for _ in range(4))
    pair = one(api, org, "select pulse.native_pair_start(%s,%s,'android','Synthetic pilot phone') id", (pair_code, poll))["id"]
    assert one(api, org, "select pulse.native_pair_decide(%s,true) d", (pair_code,), viewer=admin)["d"]["status"] == "approved"
    redeemed = one(api, org, "select pulse.native_pair_redeem(%s,%s,%s,%s) d", (pair, poll, access, hashof("refresh" + code)))["d"]
    assert redeemed["status"] == "approved"
    assert len(run(api, org, "select * from pulse.native_token_resolve(%s)", (access,))) == 1
    assert run(api, ea.org, "select * from pulse.native_token_resolve(%s)", (access,)) == []
    run(api, org, "select pulse.native_token_revoke(%s)", (redeemed["deviceId"],), viewer=admin)
    assert run(api, org, "select * from pulse.native_token_resolve(%s)", (access,)) == []      # revoked: gone

    # 6. Lag and permission: a stalled reader, then Google access removed, close the gate; nothing is deleted.
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("update pulse.drive_source set caught_up_at = now() - interval '30 hours' where install_id = %s", (drive_install,))
    behind = source(api, ea, setup, "company-drive")
    assert not behind["ready"] and behind["why"] == "Behind: last caught up 30 hours ago"
    assert behind["install"]["health"]["lagSeconds"] >= 30 * 3600
    assert not gates(api, ea, setup)[1]["sources"]
    later = due + timedelta(hours=2)
    feed.run_once(worker, org, api_for, now=lambda: later)
    assert source(api, ea, setup, "company-drive")["ready"]
    drive.raise_next = [AccessLost()]
    lost_at = later + timedelta(hours=2)
    assert [r.status for r in feed.run_once(worker, org, api_for, now=lambda: lost_at)] == ["access_lost"]
    lost = source(api, ea, setup, "company-drive")
    assert not lost["ready"] and lost["why"].startswith("Access to 1 root lost at the source") and lost["install"]["health"]["lost"] == 1
    assert {"events": seen(org), "files": run(worker, org, "select count(*) n from pulse.drive_source_file")[0]["n"]} == accepted
    regranted = lost_at + timedelta(hours=2)
    feed.run_once(worker, org, api_for, now=lambda: regranted)                  # access back: reading resumes
    assert source(api, ea, setup, "company-drive")["ready"]

    # 7. Revoke: the plugin's next batch is refused, what it delivered stays, its source is no longer ready.
    revoke(api, t2, plugin_install)
    refused = push(ingest, plugin_install, plugin_key, batch("plugin-root", "t2-0002", [record("t2plugin2")], frm="cursor-after-t2-0001"))
    assert refused.status >= 400
    assert seen(org) == 2
    assert not source(api, ea, setup, "company-plugin")["ready"] and not gates(api, ea, setup)[1]["sources"]
    run(api, org, "select pulse.company_source_decide(%s,'declined','Synthetic: the plugin was revoked in the rehearsal')",
        (source(api, ea, setup, "company-plugin")["id"],), viewer=admin)
    assert gates(api, ea, setup)[1]["sources"]

    # 8. The pilot: the device check (a mock: the pairing above ran in a throwaway database), HR's walkthrough (HR only).
    run(api, org, "select pulse.company_pilot_check(%s)", (Jsonb({"kind": "device", "platform": "android", "evidence": "mock", "result": "passed",
        "covers": ["pair", "revoke"], "note": "Synthetic: paired and revoked in the R54 core test"}),), viewer=admin)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="HR signs off"):
        run(api, org, "select pulse.company_pilot_check(%s)", (Jsonb({"kind": "walkthrough", "evidence": "mock", "result": "passed", "covers": ["people"]}),), viewer=admin)
    run(api, org, "select pulse.company_pilot_check(%s)", (Jsonb({"kind": "walkthrough", "evidence": "mock", "result": "passed",
        "covers": ["people", "roles", "sources"]}),), viewer=people["Hema HR"])
    _, state = gates(api, ea, setup)
    assert state["devices"] and state["walkthrough"]
    for who in (admin, people["Hema HR"], people["Lead 0"], people["Lead 1"], people["Lead 2"]):
        run(api, org, "select pulse.pilot_feedback_give(%s)", (Jsonb({"effort": 4, "fair": 5, "calm": 4, "easy": 3}),), viewer=who)
    fb = op(api, ea, "pulse.tenant_gates(%s)", setup)["pilot"]["feedback"]
    assert (fb["answers"], fb["shownAnswers"]) == (5, 5)
    assert {q["key"]: q["average"] for q in fb["questions"]} == {"effort": 4.0, "fair": 5.0, "calm": 4.0, "easy": 3.0}

    # 9. A restore into an isolated database, then the handover. Without the tools here, activation stays refused.
    g, state = gates(api, ea, setup)
    assert [k for k, ok in state.items() if not ok] == ["backup", "handover"]
    assert op(api, ea, "pulse.tenant_activate(%s)", setup)["activated"] is False
    drill = restore_drill(api, [ea.org, org], [SYNTHETIC_KEY.splitlines()[1], t2_account])
    if drill is None:
        pytest.skip("the restore drill needs the scratch server's superuser and pg_dump/pg_restore for its version (tools/pg-scratch.sh)")
    op(api, ea, "pulse.tenant_handover(%s,%s)", setup, Jsonb({"operatorId": str(ea.operator), "support": "Pulse Help, Support desk",
        "restore": {"on": str(date.today()), "minutes": drill["minutes"], "result": "passed", "isolated": True, "ref": f"R54 synthetic drill into {drill['target']}"}}))
    run(api, ea.org, "select pulse.tenant_isolation_record(%s,%s,%s,'[]')", (setup, *isolation_check(api, org)), viewer=ea.operator)
    g, state = gates(api, ea, setup)
    assert g["ready"] and g["blocked"] == [], g["blocked"]
    assert op(api, ea, "pulse.tenant_activate(%s)", setup) == {"activated": True, "already": False, "blocked": []}
    run(api, org, "select pulse.login_issue(%s,%s)", (people["Mo Member"], PASSWORD), viewer=admin)       # staff now

    # 10. Nothing was sent, and EA's own rows did not change (only the operator's setup record and its audit).
    assert one(api, org, "select count(*) n from pulse.notification_delivery")["n"] == 0
    with owner.transaction():
        set_tenant(owner, org)
        assert owner.execute("select count(*) n from pulse_priv.staff_invitation where status in ('sending','sent')").fetchone()["n"] == 0
    ea_after = fingerprint(owner, ea.org)
    changed = sorted(t for t in ea_before if ea_before[t] != ea_after.get(t))
    assert set(changed) <= OPERATOR_SIDE, changed
    if os.environ.get("PULSE_PILOT_RECEIPT"):
        Path(os.environ["PULSE_PILOT_RECEIPT"]).write_text(json.dumps({
            "isolation": {"tables": tables, "leaks": leaks}, "drill": drill, "eaTables": len(ea_before), "eaChanged": changed,
            "tenantTwoEvents": seen(org), "eaEvents": seen(ea.org), "gates": [x["key"] for x in g["gates"]], "feedback": fb}, indent=2, default=str))


def managed_company(api, worker, owner, ea, rehearsal):
    """A company set up by the plan and opened in trial, with an admin, HR and four leadership people."""
    setup, code = start(api, ea), new_code()
    body = spec(code, rehearsal=rehearsal)
    body["sources"] = [{"key": "people-csv", "kind": "csv", "label": "People list", "categories": ["people"]}]
    org = uuid.UUID(plan(api, ea, setup, body, True)["orgId"])
    domain = f"{code.lower()}.example.test"
    admin = uuid.UUID(run(api, ea.org, "select pulse.tenant_admin(%s,'Ada Admin',%s,'Founder') r", (setup, f"ada@{domain}"), viewer=ea.operator)[0]["r"]["personId"])
    rows = [{"name": "Hal HR", "email": f"hal@{domain}", "access": "hr"}] + [{"name": f"Lea {i}", "email": f"lea{i}@{domain}"} for i in range(4)]
    run(api, ea.org, "select pulse.tenant_people(%s,%s,true)", (setup, Jsonb(rows)), viewer=ea.operator)
    people = {r["display_name"]: r["id"] for r in run(api, org, "select id, display_name from pulse.person")}
    for i in range(4):
        run(worker, org, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2020-01-01')", (org, people[f"Lea {i}"]))
    run(api, ea.org, "select pulse.tenant_isolation_record(%s,120,0,'[]')", (setup,), viewer=ea.operator)
    assert one(api, ea.org, "select pulse.tenant_open(%s) r", (setup,), viewer=ea.operator)["r"]["opened"]
    return setup, org, admin, people


def check(api, org, who, **p):
    return run(api, org, "select pulse.company_pilot_check(%s)", (Jsonb(p),), viewer=who)


def test_a_real_company_needs_an_installed_device_hr_on_real_data_and_the_owner_s_gates(api, worker, owner, ea):
    setup, org, admin, people = managed_company(api, worker, owner, ea, rehearsal=False)
    hr = people["Hal HR"]
    detail = lambda key: next(x for x in op(api, ea, "pulse.tenant_gates(%s)", setup)["gates"] if x["key"] == key)

    assert detail("devices")["detail"].startswith("No pilot device tested yet (owner errand E03")
    check(api, org, admin, kind="device", platform="android", evidence="simulator", result="passed", covers=["pair", "check_in"])
    d = detail("devices")
    assert not d["ok"] and "Android passed (simulator)" in d["detail"] and "needs at least one installed device" in d["detail"]
    check(api, org, hr, kind="device", platform="android", evidence="installed_device", result="passed", covers=["pair", "check_in", "offline"])
    assert detail("devices")["ok"]
    check(api, org, admin, kind="device", platform="ios", evidence="installed_device", result="failed", covers=[], note="Synthetic: the widget did not refresh")
    d = detail("devices")
    assert not d["ok"] and "Test a failed platform again" in d["detail"]
    check(api, org, admin, kind="device", platform="ios", evidence="installed_device", result="passed", covers=["pair", "notification"])
    assert detail("devices")["ok"]

    # HR alone signs off; synthetic data does not count for a real company; a failed walkthrough must be repeated.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        check(api, org, admin, kind="walkthrough", evidence="real_data_read_only", result="passed", covers=["people"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        check(api, org, people["Lea 0"], kind="device", platform="macos", evidence="installed_device", result="passed", covers=["pair"])
    check(api, org, hr, kind="walkthrough", evidence="mock", result="passed", covers=["people", "policies"])
    assert detail("walkthrough")["detail"].startswith("Signed off on synthetic data only")
    check(api, org, hr, kind="walkthrough", evidence="real_data_read_only", result="failed", covers=["people"])
    assert "failed" in detail("walkthrough")["detail"] and not detail("walkthrough")["ok"]
    check(api, org, hr, kind="walkthrough", evidence="real_data_read_only", result="passed", covers=["people", "roles", "policies", "leave"])
    assert detail("walkthrough")["ok"]

    # Bad records are named, not stored.
    for bad, words in (({"kind": "device", "platform": "fax", "evidence": "mock", "result": "passed", "covers": ["pair"]}, "Choose the platform"),
                       ({"kind": "device", "platform": "web", "evidence": "real_data_read_only", "result": "passed", "covers": ["pair"]}, "a mock, a simulator"),
                       ({"kind": "device", "platform": "web", "evidence": "mock", "result": "passed", "covers": []}, "Say what was tried"),
                       ({"kind": "device", "platform": "web", "evidence": "mock", "result": "passed", "covers": ["payroll"]}, "It covers"),
                       ({"kind": "walkthrough", "evidence": "simulator", "result": "passed", "covers": ["people"]}, "synthetic data, or")):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match=words):
            check(api, org, hr, **bad)

    # Pilot passed, but a real company still waits for the owner: the restore drill, the handover, terms and rollout.
    g = op(api, ea, "pulse.tenant_gates(%s)", setup)
    assert [x["key"] for x in g["gates"] if not x["ok"]] == ["admin", "sources", "backup", "handover", "terms"]
    terms = next(x for x in g["gates"] if x["key"] == "terms")["detail"]
    assert "(owner errand E08)" in terms and "(E18)" in terms
    assert op(api, ea, "pulse.tenant_activate(%s)", setup)["activated"] is False
    # The operator sees results and evidence kinds, never the notes or who recorded them; the company sees both.
    assert "widget did not refresh" not in str(g) and "Hal HR" not in str(g)
    own = one(api, org, "select pulse.company_setup_state() s", viewer=hr)["s"]
    assert own["canSignOff"] and not own["canEdit"] and len(own["pilotChecks"]) == 7
    assert any(c["note"] == "Synthetic: the widget did not refresh" and c["by"] == "Ada Admin" for c in own["pilotChecks"])
    # The install company is not managed: nothing to record there, and it sees none of these.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not set up with the checklist"):
        check(api, ea.org, ea.hr, kind="device", platform="web", evidence="mock", result="passed", covers=["pair"])
    assert one(api, ea.org, "select count(*) n from pulse.org_pilot_check")["n"] == 0
    assert one(api, org, "select count(*) n from pulse.org_pilot_check")["n"] == 7


def test_pilot_feedback_keeps_totals_only_and_shows_them_in_fives(api, worker, owner, admin, ea):
    setup, org, adm, people = managed_company(api, worker, owner, ea, rehearsal=True)
    voters = [adm, people["Hal HR"]] + [people[f"Lea {i}"] for i in range(4)]
    give = lambda who, **a: run(api, org, "select pulse.pilot_feedback_give(%s) r", (Jsonb(a),), viewer=who)[0]["r"]
    summary = lambda: op(api, ea, "pulse.tenant_gates(%s)", setup)["pilot"]["feedback"]

    assert one(api, org, "select pulse.pilot_feedback_mine() m", viewer=adm)["m"]["open"] is True
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="from 1 to 5"):
        give(adm, effort=6, fair=5, calm=5, easy=5)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="from 1 to 5"):
        give(adm, effort=4, fair=5)
    scores = [(5, 5, 4, 4), (4, 4, 4, 3), (3, 5, 5, 4), (4, 4, 2, 5), (5, 3, 4, 4), (1, 1, 1, 1)]
    for n, (who, (e, f, c, s)) in enumerate(zip(voters, scores), start=1):
        assert give(who, effort=e, fair=f, calm=c, easy=s) == {"given": True}
        fb = summary()
        assert fb["answers"] == n
        if n < 5:
            assert fb["shownAnswers"] is None and fb["questions"] == []
        else:
            # As of five answers: the sixth (all ones) does not show on its own until the next multiple of five.
            assert fb["shownAnswers"] == 5
            assert {q["key"]: (q["average"], q["agree"]) for q in fb["questions"]} == {
                "effort": (4.2, 80), "fair": (4.2, 80), "calm": (3.8, 80), "easy": (4.0, 80)}
    with pytest.raises(psycopg.errors.UniqueViolation, match="already answered"):
        give(adm, effort=1, fair=1, calm=1, easy=1)
    assert one(api, org, "select pulse.pilot_feedback_mine() m", viewer=adm)["m"]["given"] is True

    # Nothing links an answer to a person: the totals have no person and no time, and none of it is audited.
    cols = admin.execute("""select table_name t, column_name c from information_schema.columns
                            where table_schema = 'pulse' and table_name like 'pilot_feedback%%' order by 1, 2""").fetchall()
    shape = {}
    for r in cols:
        shape.setdefault(r["t"], set()).add(r["c"])
    assert shape == {"pilot_feedback_tally": {"org_id", "question", "score", "answers"}, "pilot_feedback_given": {"org_id", "person_id"},
                     "pilot_feedback_shown": {"org_id", "answers", "questions", "updated_on"}}
    for table in ("pulse.pilot_feedback_tally", "pulse.pilot_feedback_given", "pulse.pilot_feedback_shown"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run(api, org, f"select * from {table}")
    with owner.transaction():
        set_tenant(owner, org)
        assert owner.execute("select count(*) n from pulse.audit_event where resource like 'pilot_feedback%%'").fetchone()["n"] == 0
        assert owner.execute("select count(*) n from pulse.record_change where field like '%%feedback%%'").fetchone()["n"] == 0
    # Another company has no pilot questions and sees nothing of these totals.
    assert one(api, ea.org, "select pulse.pilot_feedback_mine() m", viewer=ea.operator)["m"]["open"] is False
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="no pilot questions"):
        run(api, ea.org, "select pulse.pilot_feedback_give(%s)", (Jsonb({"effort": 5, "fair": 5, "calm": 5, "easy": 5}),), viewer=ea.operator)
    with owner.transaction():
        set_tenant(owner, ea.org)
        assert owner.execute("select count(*) n from pulse.pilot_feedback_tally where org_id = %s", (ea.org,)).fetchone()["n"] == 0
