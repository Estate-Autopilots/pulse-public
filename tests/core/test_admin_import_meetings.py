"""MEETINGS-INTO-PULSE: tools/admin/import-meetings.py, projects, tasks and files added at the Pulse server's terminal.

It adds them through the API's own functions as an organisation admin (no sign-in), gives tasks to that admin only,
can run twice without doubling anything, rolls back unless --apply, writes the platform audit log and the
organisation's Audit with the approver's words, and refuses a person who is not an admin, oversized files and any
other host. Synthetic data only.
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
TOOL = ROOT / "tools/admin/import-meetings.py"
WORDS = "synthetic approval words"


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
    """A synthetic organisation with an admin and an editor, each with a Pulse account (@handle) and a seat."""
    w = build_world(worker, owner, api)
    admin_id = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic import admin','staff')", (admin_id, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, admin_id))
    handles = {}
    for key, person in (("admin", admin_id), ("editor", w.editor)):
        h = "syn" + uuid.uuid4().hex[:10]
        aid = uuid.uuid4()
        with owner.transaction():
            owner.execute("insert into pulse_priv.pulse_account(id, handle, display_name) values (%s, %s, 'Synthetic Human')", (aid, h))
            owner.execute("insert into pulse_priv.handle_name(handle, kind, ref) values (%s, 'person', %s)", (h, aid))
            owner.execute("insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (%s, %s, %s, 'staff')", (aid, w.org, person))
        handles[key] = h
    with owner.transaction():
        set_tenant(owner, w.org)
        org_handle = owner.execute("select handle from pulse.org where id = %s", (w.org,)).fetchone()["handle"]
    return w, admin_id, org_handle, handles


def _manifest(tmp_path, org, handle, **extra):
    (tmp_path / "notes.txt").write_text("Synthetic meeting transcript\nलाइन दोन\n", encoding="utf-8")
    m = {"org": org, "as": handle,
         "projects": [{"title": "Synthetic meetings"}, {"title": "Synthetic partner", "visibility": "leadership"}],
         "tasks": [{"project": "Synthetic meetings", "title": "Synthetic meeting summary", "notes": "What was agreed.", "dueOn": "2026-11-10",
                    "priority": "high", "attachments": [{"file": "notes.txt", "mime": "text/plain", "label": "Transcript"}]},
                   {"project": "Synthetic partner", "title": "Synthetic partner follow-up", "leadershipOnly": True}]}
    m.update(extra)
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    return p


def _state(owner, org):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute("""select (select count(*) from pulse.project where org_id = %s and title like 'Synthetic %%' and deleted_at is null) projects,
                                       (select count(*) from pulse.task where org_id = %s and title like 'Synthetic %%' and deleted_at is null) tasks,
                                       (select count(*) from pulse.task_attachment a join pulse.task t on t.id = a.task_id
                                         where t.org_id = %s and t.title like 'Synthetic %%' and a.removed_at is null) files,
                                       (select count(*) from pulse_priv.platform_audit where target_org = %s and action = 'admin.import') ledger,
                                       (select count(*) from pulse.login_session) sessions""", (org, org, org, org)).fetchone()


def test_dry_run_writes_nothing_and_apply_adds_once(owner, seated, tmp_path):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, admin_id, org_handle, handles = seated
    man = _manifest(tmp_path, org_handle, handles["admin"])
    before = _state(owner, w.org)
    dry = _run(man)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "Dry run" in dry.stderr
    assert _state(owner, w.org) == before, "a dry run rolls back everything it would add"
    with owner.transaction():
        dr = owner.execute("select reason, detail from pulse_priv.platform_audit where target_org = %s and action = 'admin.import_dry_run' order by at desc limit 1",
                           (w.org,)).fetchone()
        assert dr and dr["reason"] == WORDS and dr["detail"]["applied"] is False and dr["detail"]["madeTasks"] == 2, "the dry run is in the ledger"

    done = _run(man, "--apply")
    assert done.returncode == 0, done.stdout + done.stderr
    after = _state(owner, w.org)
    assert (after["projects"], after["tasks"], after["files"], after["ledger"]) == (
        before["projects"] + 2, before["tasks"] + 2, before["files"] + 1, before["ledger"] + 1)
    assert after["sessions"] == before["sessions"], "no sign-in session is made"
    with owner.transaction():
        set_tenant(owner, w.org)
        tasks = owner.execute("""select t.title, t.assignee_person_id, t.created_by, t.leadership_only, t.priority, p.visibility, p.title project
                                   from pulse.task t join pulse.project p on p.id = t.project_id where t.org_id = %s and t.title like 'Synthetic %%'""",
                              (w.org,)).fetchall()
        assert {t["assignee_person_id"] for t in tasks} == {admin_id} and {t["created_by"] for t in tasks} == {admin_id}
        partner = next(t for t in tasks if t["project"] == "Synthetic partner")
        assert partner["visibility"] == "leadership" and partner["leadership_only"] is True
        summary = next(t for t in tasks if t["title"] == "Synthetic meeting summary")
        assert summary["priority"] == "high"
        f = owner.execute("""select f.bytes, f.mime from pulse.task_attachment a join pulse_priv.work_file f on f.id = a.file_id
                               join pulse.task t on t.id = a.task_id where t.org_id = %s and t.title = 'Synthetic meeting summary'""", (w.org,)).fetchone()
        assert bytes(f["bytes"]).decode("utf-8") == "Synthetic meeting transcript\nलाइन दोन\n" and f["mime"] == "text/plain"
        led = owner.execute("select actor, reason, detail from pulse_priv.platform_audit where target_org = %s and action = 'admin.import' order by at desc limit 1",
                            (w.org,)).fetchone()
        assert led["reason"] == WORDS and "Synthetic Owner (owner)" in led["actor"]
        assert led["detail"]["onBehalfOf"] == str(admin_id) and led["detail"]["madeTasks"] == 2 and led["detail"]["applied"] is True
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.audit_event where org_id = %s and action = 'platform.admin.import'", (w.org,)).fetchone()["n"] >= 1

    again = _run(man, "--apply")
    assert again.returncode == 0, again.stdout + again.stderr
    twice = _state(owner, w.org)
    assert (twice["projects"], twice["tasks"], twice["files"]) == (after["projects"], after["tasks"], after["files"]), "a second run adds nothing"
    assert twice["ledger"] == after["ledger"] + 1


def test_wa_route_gives_a_task_to_a_person_without_telling_them_and_files_bugs_once(owner, seated, tmp_path):
    """WA-ROUTE: "assignee" gives the task to that seat; the notice that would tell them is taken back before commit;
    "bugs" go on the bug board once; the ledger counts both."""
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, admin_id, org_handle, handles = seated
    man = _manifest(tmp_path, org_handle, handles["admin"],
                    tasks=[{"project": "Synthetic meetings", "title": "Synthetic routed task", "notes": "For a colleague.",
                            "assignee": "@" + handles["editor"]}],
                    bugs=[{"title": "Synthetic login scroll", "words": "Screen: sign-in. Steps: open it and scroll.", "route": "/login",
                           "severity": "medium"}])

    def notices():
        with owner.transaction():
            set_tenant(owner, w.org)
            return owner.execute("select count(*) n from pulse.notification where org_id = %s and person_id = %s", (w.org, w.editor)).fetchone()["n"]

    def bugs():
        with owner.transaction():
            set_tenant(owner, w.org)
            return owner.execute("select count(*) n from pulse.reported_bug where org_id = %s and title = 'Synthetic login scroll'", (w.org,)).fetchone()["n"]

    before = notices()
    dry = _run(man)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert bugs() == 0
    done = _run(man, "--apply")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "1 notices taken back" in done.stderr, done.stderr
    assert notices() == before, "the person given the task is not told"
    with owner.transaction():
        set_tenant(owner, w.org)
        t = owner.execute("select assignee_person_id, created_by from pulse.task where org_id = %s and title = 'Synthetic routed task'", (w.org,)).fetchone()
        assert t["assignee_person_id"] == w.editor and t["created_by"] == admin_id
        b = owner.execute("select person_id, route, kind, severity, status from pulse.reported_bug where org_id = %s and title = 'Synthetic login scroll'",
                          (w.org,)).fetchone()
        assert (b["person_id"], b["route"], b["kind"], b["severity"], b["status"]) == (admin_id, "/login", "bug", "medium", "new")
        led = owner.execute("select detail from pulse_priv.platform_audit where target_org = %s and action = 'admin.import' order by at desc limit 1",
                            (w.org,)).fetchone()["detail"]
        assert led["madeBugs"] == 1 and led["quietedNotices"] == 1 and led["assignees"] == [handles["editor"]]
    again = _run(man, "--apply")
    assert again.returncode == 0, again.stdout + again.stderr
    assert bugs() == 1 and notices() == before
    stranger = _run(_manifest(tmp_path, org_handle, handles["admin"], tasks=[{"project": "Synthetic meetings", "title": "Synthetic stray",
                                                                             "assignee": "@syn" + uuid.uuid4().hex[:10]}]), "--apply")
    assert stranger.returncode == 2 and "no active staff seat" in stranger.stderr


def test_refuses_a_person_who_is_not_an_admin_and_writes_nothing(owner, seated, tmp_path):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, _admin_id, org_handle, handles = seated
    before = _state(owner, w.org)
    p = _run(_manifest(tmp_path, org_handle, handles["editor"]), "--apply")
    assert p.returncode == 2, p.stdout + p.stderr
    nobody = _run(_manifest(tmp_path, org_handle, "syn" + uuid.uuid4().hex[:10]), "--apply")
    assert nobody.returncode == 2 and "staff seat" in nobody.stderr
    assert _state(owner, w.org) == before


def test_refuses_bad_manifests_other_hosts_and_missing_words(tmp_path):
    big = tmp_path / "big.txt"
    big.write_bytes(b"x" * 5_300_000)
    m = _manifest(tmp_path, "syntheticorg", "synadmin")
    data = json.loads(m.read_text(encoding="utf-8"))
    data["tasks"][0]["attachments"] = [{"file": "big.txt", "mime": "text/plain"}]
    m.write_text(json.dumps(data), encoding="utf-8")
    p = _run(m)
    assert p.returncode == 2 and "5 MB" in p.stderr
    data["tasks"][0]["attachments"] = []
    data["tasks"][0]["assigneeId"] = str(uuid.uuid4())
    m.write_text(json.dumps(data), encoding="utf-8")
    assert _run(m).returncode == 2
    data["tasks"][0].pop("assigneeId")
    data["tasks"][0]["project"] = "Not listed"
    m.write_text(json.dumps(data), encoding="utf-8")
    assert _run(m).returncode == 2
    elsewhere = _run(_manifest(tmp_path, "syntheticorg", "synadmin"), hosts="some-other-host")
    assert elsewhere.returncode == 2 and "only on the Pulse server" in elsewhere.stderr
    q = subprocess.run([sys.executable, str(TOOL), "--manifest", str(m), "--approver", "Synthetic Owner", "--words", " "],
                       capture_output=True, text=True, check=False, timeout=60)
    assert q.returncode == 2 and "--words" in q.stderr


def test_there_is_no_web_route_for_it():
    src = "\n".join(f.read_text() for f in (ROOT / "services/api/src").glob("*.ts"))
    assert "import-meetings" not in src
