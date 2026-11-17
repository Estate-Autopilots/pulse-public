"""KAZUK-REST slice 5 (1708): bug reports from every company also land on the Pulse dev organisation's board, with the
reporting company noted, a way back to the original, and nothing private copied. Two synthetic companies, synthetic
people and invented reports only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, one, person

API = Path(__file__).resolve().parents[2] / "services/api"


def set_install(owner, org):
    """The API serves the install's company; a test moves it to the company whose people it signs in."""
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) as r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        owner.execute("delete from pulse.install")
        owner.execute("insert into pulse.install(org_id,initialised_by) values(%s,'test:synthetic')", (org,))


def report(api, w, who, number, words="Synthetic: the save button spins. Call me on +91 98765 43210 or fake.person@example.test",
           title=None, route="/tasks/:id", kind="bug"):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute("""insert into pulse.reported_bug(org_id, number, person_id, command_id, words, route, fingerprint, context, errors, network, trail,
                              blocks_work, severity, title, kind)
            values (%s, %s, %s, %s, %s, %s, repeat('b', 64), %s, %s, '[]', '[{"at":"2026-11-06T10:00:00Z","kind":"ui.click"}]', true, 'high', %s, %s) returning id""",
            (w.org, number, who, f"cmd-synthetic-{number}-{w.code.lower()}", words, route,
             json.dumps({"browser": "Chrome 141", "os": "Windows 11", "release": "dev-synthetic"}),
             json.dumps([{"at": "2026-11-06T10:00:00Z", "kind": "error", "message": "TypeError: secret client Northstar"}]), title, kind)).fetchone()["id"]


def as_owner(owner, sql, args=()):
    """Platform data (pulse_priv, an organisation's handle) as the schema owner."""
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) as r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        return owner.execute(sql, args).fetchall() if sql.lstrip().lower().startswith("select") else owner.execute(sql, args)


def test_the_default_dev_organisation_is_vitals_technologies_by_handle(owner):
    """The setting ships seeded (platform data, not a code default): the organisation with the handle vitalstechnologies."""
    rows = as_owner(owner, "select dev_org, dev_handle from pulse_priv.dev_board")
    assert [(r["dev_org"], r["dev_handle"]) for r in rows] == [(None, "vitalstechnologies")]


@pytest.fixture
def boards(worker, owner, api):
    """A reporting company and the Pulse dev organisation, named as the dev board for this test only (the default row is
    put back afterwards)."""
    # The first world is the install's company, which the API serves: the Pulse dev organisation here.
    d = build_world(worker, owner, api)
    a = build_world(worker, owner, api)
    a.founder, a.member = person(worker, a, "Synthetic Reporter Lead", "leadership"), person(worker, a, "Synthetic Reporter")
    d.founder, d.member = person(worker, d, "Synthetic Dev Lead", "leadership"), person(worker, d, "Synthetic Dev Member")
    saved = as_owner(owner, "select dev_org, dev_handle, set_by from pulse_priv.dev_board")
    with owner.transaction():
        owner.execute("delete from pulse_priv.dev_board")
        owner.execute("insert into pulse_priv.dev_board(one, dev_org, set_by) values (true, %s, 'synthetic test')", (d.org,))
    yield a, d
    with owner.transaction():
        owner.execute("delete from pulse_priv.dev_board")
        for r in saved:
            owner.execute("insert into pulse_priv.dev_board(one, dev_org, dev_handle, set_by) values (true, %s, %s, %s)",
                          (r["dev_org"], r["dev_handle"], r["set_by"]))


def test_a_report_lands_on_the_dev_board_with_its_company_and_nothing_private(api, boards):
    a, d = boards
    rid = report(api, a, a.member, 1)
    rows = as_(api, d, d.founder, "select * from pulse.dev_bug_inbox")
    assert len(rows) == 1
    r = rows[0]
    assert (r["source_org"], r["source_report"], r["source_number"]) == (a.org, rid, 1)
    assert r["source_org_name"] == f"Synthetic {a.code}"
    assert (r["title"], r["route"], r["severity"], r["blocks_work"]) == ("Bug on /tasks/:id", "/tasks/:id", "high", True)
    assert (r["browser"], r["os"], r["error_count"], r["call_count"], r["step_count"]) == ("Chrome 141", "Windows 11", 1, 0, 1)
    # Nothing the person typed, no error text, no names or contacts: not in any column.
    flat = json.dumps({k: str(v) for k, v in r.items()})
    for private in ("98765", "fake.person", "save button", "Northstar", "TypeError", "Synthetic Reporter"):
        assert private not in flat, private
    # A board title keeps its words, with addresses and numbers masked.
    report(api, a, a.member, 2, title="Export fails for ops.lead@example.test, ref +91 99999 00000", kind="feature")
    t = one(api, d, d.founder, "select title, kind from pulse.dev_bug_inbox where source_number = 2")
    assert t == {"title": "Export fails for [email], ref [number]", "kind": "feature"}


def test_each_company_keeps_its_own_side(api, boards):
    a, d = boards
    report(api, a, a.member, 1)
    # The reporting company never reads the dev organisation's inbox, and the dev organisation never reads the report.
    assert as_(api, a, a.founder, "select id from pulse.dev_bug_inbox") == []
    assert as_(api, d, d.founder, "select id from pulse.reported_bug where org_id = %s", (a.org,)) == []
    # A report made inside the dev organisation stays there (it is already on its own board).
    report(api, d, d.member, 1)
    assert one(api, d, d.founder, "select count(*)::int n from pulse.dev_bug_inbox")["n"] == 1
    # Rows arrive only through the trigger: the API role cannot write one, nor point one at another company.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, d, d.founder, """insert into pulse.dev_bug_inbox(org_id, source_org, source_org_name, source_report, source_number, title, route, reported_at)
            values (%s, %s, 'x', gen_random_uuid(), 9, 'Synthetic', '/', now())""", (d.org, a.org))
    assert as_(api, a, a.founder, "update pulse.dev_bug_inbox set task_id = null returning id") == []
    # Status is never written straight: only through pulse.dev_bug_inbox_set, and only from the dev organisation.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, d, d.founder, "update pulse.dev_bug_inbox set status = 'fixed'")
    row = one(api, d, d.founder, "select id from pulse.dev_bug_inbox")["id"]
    assert one(api, a, a.founder, "select pulse.dev_bug_inbox_set(%s, 'fixed') id", (row,))["id"] is None
    # The dev organisation is who the platform named; the reporting company is not it.
    assert one(api, a, a.founder, "select pulse.dev_board_org() = pulse.current_org() ok")["ok"] is False
    assert one(api, d, d.founder, "select pulse.dev_board_org() = pulse.current_org() ok")["ok"] is True


def test_the_setting_finds_the_dev_organisation_by_handle(api, owner, boards):
    a, d = boards
    handle = f"syntheticdev.{d.code.lower()}"
    with owner.transaction():
        owner.execute("select set_config('pulse.org_id', %s, true)", (str(d.org),))
        assert owner.execute("update pulse.org set handle = %s where id = %s", (handle, d.org)).rowcount == 1
    with owner.transaction():
        owner.execute("update pulse_priv.dev_board set dev_org = null, dev_handle = %s", (handle,))
    report(api, a, a.member, 1)
    assert one(api, d, d.founder, "select count(*)::int n from pulse.dev_bug_inbox")["n"] == 1
    # A handle no organisation has: nothing moves, and the report stays.
    with owner.transaction():
        owner.execute("update pulse_priv.dev_board set dev_handle = 'synthetic.nosuchorg'")
    report(api, a, a.member, 2)
    assert one(api, d, d.founder, "select count(*)::int n from pulse.dev_bug_inbox")["n"] == 1
    assert one(api, a, a.member, "select count(*)::int n from pulse.reported_bug")["n"] == 2


def test_one_status_per_report_shared_with_bugkit_triage(api, boards):
    """BUGKIT's triage (the company's /bug-reports, the admin console) and the dev board never disagree."""
    a, d = boards
    rid = report(api, a, a.member, 1)
    row = one(api, d, d.founder, "select id from pulse.dev_bug_inbox")["id"]
    # The dev organisation sets fixing: the original report says fixing, in its history from "Pulse dev team".
    assert one(api, d, d.founder, "select pulse.dev_bug_inbox_set(%s, 'fixing') id", (row,))["id"] == row
    assert one(api, a, a.founder, "select status from pulse.reported_bug where id = %s", (rid,))["status"] == "fixing"
    ev = one(api, a, a.founder, "select value, note from pulse.reported_bug_event where report_id = %s and kind = 'status' order by at desc limit 1", (rid,))
    assert ev == {"value": "fixing", "note": "Pulse dev team"}
    # The company marks it fixed in its own triage: the dev board shows fixed.
    as_(api, a, a.founder, "update pulse.reported_bug set status = 'fixed', status_at = now() where id = %s returning id", (rid,))
    assert one(api, d, d.founder, "select status from pulse.dev_bug_inbox where id = %s", (row,))["status"] == "fixed"


def test_with_no_dev_organisation_reports_stay_put(api, owner, boards):
    a, d = boards
    with owner.transaction():
        owner.execute("delete from pulse_priv.dev_board")
    report(api, a, a.member, 1)
    assert as_(api, d, d.founder, "select id from pulse.dev_bug_inbox") == []
    assert one(api, a, a.member, "select count(*)::int n from pulse.reported_bug")["n"] == 1
    # Only a platform admin names the dev organisation.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, a, a.founder, "select pulse.platform_dev_board_set(%s)", (a.org,))


def test_the_dev_inbox_through_the_api(api, worker, owner, boards):
    a, d = boards
    report(api, a, a.member, 1)
    with worker.transaction():
        for w, who, handle in ((d, d.founder, "devlead"), (d, d.member, "devmember"), (a, a.founder, "reporterlead")):
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_SOURCE_ORG": str(a.org),
           "TEST_EMAILS": json.dumps({"devLead": f"devlead@{d.domain}", "devMember": f"devmember@{d.domain}", "reporterLead": f"reporterlead@{a.domain}"})}
    env["TEST_ROW_ID"] = str(one(api, d, d.founder, "select id from pulse.dev_bug_inbox")["id"])
    for phase, org in (("dev", d.org), ("reporter", a.org)):
        set_install(owner, org)
        p = subprocess.run(["node", "test/kazuk-rest-s5-runner.mjs", phase], cwd=API, env=env, capture_output=True, text=True, timeout=120, check=False)
        assert p.returncode == 0, phase + ": " + p.stderr[-4000:] + p.stdout[-4000:]
    row = one(api, d, d.founder, "select status, task_id from pulse.dev_bug_inbox")
    assert row["status"] == "fixing" and row["task_id"] is not None
    assert one(api, a, a.founder, "select status from pulse.reported_bug where number = 1")["status"] == "fixing"
    task = one(api, d, d.founder, "select title, notes from pulse.task where id = %s", (row["task_id"],))
    assert task["title"].startswith(f"Synthetic {a.code} bug #1: Bug on /tasks/:id")
    assert f"/bugs/{a.org}/" in task["notes"] and "98765" not in task["notes"]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_the_dev_inbox_in_the_browser(api, worker, boards):
    """services/api/test/kazuk-rest-s5-browser-runner.mjs: the Pulse dev organisation's inbox at 1440 and 390, light and
    dark (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    a, d = boards
    report(api, a, a.member, 1)
    report(api, a, a.member, 2, title="Synthetic idea: bulk export of the leave calendar", kind="feature", route="/hr")
    with worker.transaction():
        set_tenant(worker, d.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (d.org, f"devlead@{d.domain}", d.founder))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_EMAILS": json.dumps({"devLead": f"devlead@{d.domain}"}),
           "TEST_SOURCE_NAME": f"Synthetic {a.code}"}
    p = subprocess.run(["node", "test/kazuk-rest-s5-browser-runner.mjs"], cwd=API, env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
