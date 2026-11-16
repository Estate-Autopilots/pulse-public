"""PERSONAL-WORKSPACE: tools/admin/reclassify-work.py, goals told apart from projects and tasks at the Pulse server's terminal.

As Savuzo HQ's reorganisation (6 Nov 2026): goals are made as the admin's own person goals and linked to projects and
tasks; a task that IS the goal is kept (linked, tagged 'became-goal', Cancelled with a note in its history); a task can
move project; a project's kind changes. Nothing is deleted, a rerun adds nothing, the dry run rolls back but is in the
ledger, and anyone but an admin, ids of another organisation and other hosts are refused. Synthetic data only.
"""
import json
import os
import socket
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools/admin/reclassify-work.py"
WORDS = "synthetic approval words for a reclassification"


def _superuser() -> bool:
    with psycopg.connect(os.environ["PULSE_CI_DATABASE_URL"], autocommit=True) as c:
        return c.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]


def _run(manifest, *argv, hosts=None):
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(TOOL), "--exec", "", "--db-user", "", "--database", os.environ["PULSE_CI_DATABASE_URL"],
                           "--manifest", str(manifest), "--approver", "Synthetic Owner (owner)", "--words", WORDS, *argv],
                          capture_output=True, text=True, check=False, timeout=180, env=env)


@pytest.fixture
def seated(worker, owner, api):
    """A synthetic organisation with an admin (an account and a seat), two fulfilment projects and four tasks."""
    w = build_world(worker, owner, api)
    admin_id = uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    t = {k: uuid.uuid4() for k in ("ach", "goal", "milestone", "routine")}
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic reorg admin','staff')", (admin_id, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, admin_id))
        for n, (pid, name) in enumerate(((p1, "Synthetic story"), (p2, "Synthetic routines"))):
            worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,kind) values(%s,%s,%s,%s,%s,'client_work')",
                           (pid, w.org, 990001 + n, name, name))
            worker.execute("insert into pulse.work_project(org_id,project_id,kind) values(%s,%s,'fulfilment') on conflict (project_id) do update set kind='fulfilment'",
                           (w.org, pid))
        for key, title, pid in (("ach", "Achievement A99: Synthetic thing achieved", p1), ("goal", "Goal: synthetic rate of Rs 1,234 an hour", p1),
                                ("milestone", "Synthetic milestone lands", p1), ("routine", "Synthetic weekly review", p1)):
            worker.execute("insert into pulse.task(id,org_id,title,project_id,status,source,created_by,assignee_person_id,owner_id) values(%s,%s,%s,%s,'open','pulse',%s,%s,%s)",
                           (t[key], w.org, title, pid, admin_id, admin_id, admin_id))
    h = "syn" + uuid.uuid4().hex[:10]
    aid = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id, handle, display_name) values (%s, %s, 'Synthetic Human')", (aid, h))
        owner.execute("insert into pulse_priv.handle_name(handle, kind, ref) values (%s, 'person', %s)", (h, aid))
        owner.execute("insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (%s, %s, %s, 'staff')", (aid, w.org, admin_id))
        set_tenant(owner, w.org)
        org_handle = owner.execute("select coalesce(handle, slug) h from pulse.org where id = %s", (w.org,)).fetchone()["h"]
    return w, admin_id, org_handle, h, (p1, p2), t


def _manifest(tmp_path, org, handle, projects, t, **extra):
    p1, p2 = projects
    m = {"org": org, "as": handle,
         "projectKinds": [{"project": str(p1), "kind": "internal"}, {"project": str(p2), "kind": "internal"}],
         "goals": [{"title": "A99: Synthetic thing achieved", "status": "done", "fromTask": str(t["ach"]), "projects": [str(p1)]},
                   {"title": "Synthetic rate of Rs 1,234 an hour", "status": "active", "targetOn": "2027-01-31", "fromTask": str(t["goal"]),
                    "measure": {"label": "Rate (Rs/hour)", "start": 0, "target": 1234, "current": 0}, "projects": [str(p1)], "tasks": [str(t["milestone"])]}],
         "relink": [{"task": str(t["routine"]), "project": str(p2)}]}
    m.update(extra)
    p = tmp_path / "reorg.json"
    p.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    return p


def _state(owner, org):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute("""select (select count(*) from pulse.goal where org_id = %(o)s) goals,
                                       (select count(*) from pulse.goal_link where org_id = %(o)s) links,
                                       (select count(*) from pulse.task where org_id = %(o)s and title like '%%ynthetic%%') tasks,
                                       (select count(*) from pulse.task where org_id = %(o)s and status = 'cancelled') cancelled,
                                       (select count(*) from pulse.work_project where org_id = %(o)s and kind = 'internal' and project_id in
                                          (select id from pulse.project where org_id = %(o)s and name like 'Synthetic %%')) internal,
                                       (select count(*) from pulse_priv.platform_audit where target_org = %(o)s and action = 'admin.reclassify') ledger,
                                       (select count(*) from pulse.login_session) sessions""", {"o": org}).fetchone()


def test_dry_run_changes_nothing_and_apply_reclassifies_once(owner, seated, tmp_path):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, admin_id, org_handle, handle, projects, t = seated
    man = _manifest(tmp_path, org_handle, handle, projects, t)
    before = _state(owner, w.org)
    dry = _run(man)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "Dry run" in dry.stderr and "Dry run ledger row" in dry.stderr
    assert _state(owner, w.org) == before, "a dry run rolls back everything"
    with owner.transaction():
        dr = owner.execute("select reason, detail from pulse_priv.platform_audit where target_org = %s and action = 'admin.reclassify_dry_run' order by at desc limit 1",
                           (w.org,)).fetchone()
        assert dr and dr["reason"] == WORDS and dr["detail"]["applied"] is False and dr["detail"]["madeGoals"] == 2

    done = _run(man, "--apply")
    assert done.returncode == 0, done.stdout + done.stderr
    after = _state(owner, w.org)
    assert after["goals"] == before["goals"] + 2 and after["links"] == before["links"] + 5
    assert after["tasks"] == before["tasks"], "nothing is deleted"
    assert after["cancelled"] == before["cancelled"] + 2 and after["internal"] == 2 and after["ledger"] == before["ledger"] + 1
    assert after["sessions"] == before["sessions"], "no sign-in session is made"
    with owner.transaction():
        set_tenant(owner, w.org)
        g = {r["title"]: r for r in owner.execute("select title, level, status, owner_person_id, created_by, measure_label, target_value, done_at from pulse.goal where org_id = %s",
                                                  (w.org,)).fetchall()}
        assert g["A99: Synthetic thing achieved"]["status"] == "done" and g["A99: Synthetic thing achieved"]["done_at"] is not None
        rate = g["Synthetic rate of Rs 1,234 an hour"]
        assert (rate["level"], rate["status"], rate["owner_person_id"], rate["created_by"], rate["measure_label"], float(rate["target_value"])) == (
            "person", "active", admin_id, admin_id, "Rate (Rs/hour)", 1234.0)
        src = owner.execute("select status, tags from pulse.task where id = %s", (t["ach"],)).fetchone()
        assert src["status"] == "cancelled" and "became-goal" in src["tags"]
        ev = owner.execute("select note from pulse.task_event where task_id = %s and kind = 'status' order by at desc limit 1", (t["ach"],)).fetchone()
        assert ev["note"].startswith("Became the goal")
        assert owner.execute("select status from pulse.task where id = %s", (t["milestone"],)).fetchone()["status"] == "open", "a milestone stays a task"
        assert owner.execute("select project_id from pulse.task where id = %s", (t["routine"],)).fetchone()["project_id"] == projects[1]
        assert {r["kind"] for r in owner.execute("select kind from pulse.project where id = any(%s)", (list(projects),)).fetchall()} == {"internal"}
        led = owner.execute("select actor, reason, detail from pulse_priv.platform_audit where target_org = %s and action = 'admin.reclassify' order by at desc limit 1",
                            (w.org,)).fetchone()
        assert led["reason"] == WORDS and "Synthetic Owner (owner)" in led["actor"] and led["detail"]["convertedTasks"] == 2

    again = _run(man, "--apply")
    assert again.returncode == 0, again.stdout + again.stderr
    twice = _state(owner, w.org)
    assert (twice["goals"], twice["links"], twice["cancelled"]) == (after["goals"], after["links"], after["cancelled"]), "a second run adds nothing"


def test_refuses_non_admins_foreign_ids_bad_manifests_and_other_hosts(owner, seated, tmp_path):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, _admin, org_handle, handle, projects, t = seated
    before = _state(owner, w.org)
    stranger = _run(_manifest(tmp_path, org_handle, "syn" + uuid.uuid4().hex[:10], projects, t), "--apply")
    assert stranger.returncode == 2 and "staff seat" in stranger.stderr
    foreign = _run(_manifest(tmp_path, org_handle, handle, projects, t, relink=[{"task": str(uuid.uuid4()), "project": str(projects[0])}]), "--apply")
    assert foreign.returncode == 2 and "not in" in foreign.stderr
    assert _state(owner, w.org) == before, "a refusal writes nothing"
    bad = _manifest(tmp_path, org_handle, handle, projects, t, goals=[{"title": "x", "measure": {"label": "n", "start": 3, "target": 3}}])
    assert _run(bad).returncode == 2
    kind = _manifest(tmp_path, org_handle, handle, projects, t, projectKinds=[{"project": str(projects[0]), "kind": "client"}])
    assert _run(kind).returncode == 2
    elsewhere = _run(_manifest(tmp_path, org_handle, handle, projects, t), hosts="some-other-host")
    assert elsewhere.returncode == 2 and "only on the Pulse server" in elsewhere.stderr


def test_there_is_no_web_route_for_it():
    src = "\n".join(f.read_text() for f in (ROOT / "services/api/src").glob("*.ts"))
    assert "reclassify-work" not in src
