"""PERSONAL-WORKSPACE: tools/admin/personal-workspaces.py, every account's own private workspace backfilled at the terminal.

Through migration 1640's pulse.personal_workspace_ensure / personal_workspace_adopt: a dry run makes nothing but is in the
ledger; --apply makes one personal workspace per account with only that person in it, once (a rerun makes none); an
adopted organisation becomes that person's workspace instead; other hosts and missing words are refused. Synthetic only.
"""
import os
import re
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
TOOL = ROOT / "tools/admin/personal-workspaces.py"
WORDS = "synthetic approval words for personal workspaces"


def _superuser() -> bool:
    with psycopg.connect(os.environ["PULSE_CI_DATABASE_URL"], autocommit=True) as c:
        return c.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]


def _run(*argv, hosts=None, words=WORDS):
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(TOOL), "--exec", "", "--db-user", "", "--database", os.environ["PULSE_CI_DATABASE_URL"],
                           "--approver", "Synthetic Owner (owner)", "--words", words, *argv],
                          capture_output=True, text=True, check=False, timeout=180, env=env)


def _account(owner, org=None, person=None):
    h = "synpw" + uuid.uuid4().hex[:10]
    aid = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id, handle, display_name) values (%s, %s, 'Synthetic Person')", (aid, h))
        owner.execute("insert into pulse_priv.handle_name(handle, kind, ref) values (%s, 'person', %s)", (h, aid))
        if org:
            owner.execute("insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (%s, %s, %s, 'staff')", (aid, org, person))
    return h, aid


def _workspaces(admin, aid):
    # FEATURE-AUDIT (9 Nov 2026): across organisations, so read as the superuser (`admin`); the owner role sees only the
    # tenant it is set to (row security on pulse.org), and these tests already need the superuser (`ready`).
    return admin.execute("""select o.id, o.kind from pulse.org o join pulse_priv.account_member m on m.member_org = o.id
                              where m.account_id = %s and o.kind = 'personal'""", (aid,)).fetchall()


@pytest.fixture
def ready(owner):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    with owner.transaction():
        if owner.execute("select to_regprocedure('pulse.personal_workspace_ensure(uuid)') is not null ok").fetchone()["ok"] is not True:
            pytest.fail("migration 1640 (personal workspaces) is missing")


def test_dry_run_makes_nothing_and_apply_makes_one_workspace_once(owner, admin, ready):
    h, aid = _account(owner)
    # The account trigger may already have made it; the tool then makes none and still reports the account.
    before = len(_workspaces(admin, aid))
    dry = _run("--only", h)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "Dry run ledger row" in dry.stderr
    assert len(_workspaces(admin, aid)) == before, "a dry run rolls back"
    done = _run("--only", h, "--apply")
    assert done.returncode == 0, done.stdout + done.stderr
    ws = _workspaces(admin, aid)
    assert len(ws) == 1, "one workspace of its own"
    assert admin.execute("select count(*) n from pulse_priv.account_member where member_org = %s", (ws[0]["id"],)).fetchone()["n"] == 1, "only that person"
    led = admin.execute("select reason, detail from pulse_priv.platform_audit where action = 'admin.personal_workspaces' order by at desc limit 1").fetchone()
    assert led["reason"] == WORDS and led["detail"]["workspaces"][h] == str(ws[0]["id"])
    assert admin.execute("select count(*) n from pulse.notification where org_id = %s", (ws[0]["id"],)).fetchone()["n"] == 0, "nobody is told"
    again = _run("--only", h, "--apply")
    assert again.returncode == 0 and len(_workspaces(admin, aid)) == 1, "a rerun makes nothing new"


def test_adopt_makes_an_existing_organisation_the_persons_workspace(owner, worker, api, admin, ready):
    w = build_world(worker, owner, api)
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic adopter','staff')", (pid, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, pid))
    h, aid = _account(owner, w.org, pid)
    slug = admin.execute("select slug from pulse.org where id = %s", (w.org,)).fetchone()["slug"]
    done = _run("--only", h, "--adopt", f"{slug}:{h}", "--apply")
    assert done.returncode == 0, done.stdout + done.stderr
    assert admin.execute("select kind from pulse.org where id = %s", (w.org,)).fetchone()["kind"] == "personal"


def test_refuses_other_hosts_missing_words_and_strangers(owner, ready):
    assert _run(hosts="some-other-host").returncode == 2
    assert _run(words=" ").returncode == 2
    p = _run("--adopt", "no-such-org:no-such-handle")
    assert p.returncode == 2 and "no active organisation" in p.stderr


def test_there_is_no_web_route_for_it():
    # The API may name the tool in a comment (personal-workspace.ts does); it must never run it or route to it.
    src = "\n".join(f.read_text() for f in (ROOT / "services/api/src").glob("*.ts"))
    assert not re.search(r"(spawn|exec\w*|fork)\s*\([^;]*personal-workspaces\.py", src), "the API runs the tool"
    assert not re.search(r"app\.(get|post|put|patch|delete)\(\s*['\"`][^'\"`]*personal-workspaces", src), "a route is named after the tool"
