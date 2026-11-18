"""EA-RUNNER: tools/runner/pair-code.py, a pairing code made at the Pulse server's terminal (no web route).

It makes the code exactly as Settings → Servers & AI does (pulse.runner_pair_code_create as an organisation admin), so
the code pairs a server; it writes the platform audit log and the organisation's Audit in the same transaction and
never the code itself; it touches no sign-in or session table; it refuses a person who is not an admin, missing
approval words and any other host. The code's alphabet and hash stay those of services/api/src/runner-model.ts.
"""
import hashlib
import importlib.util
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
TOOL = ROOT / "tools/runner/pair-code.py"
CODE_RE = re.compile(r"^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")


def _superuser() -> bool:
    with psycopg.connect(os.environ["PULSE_CI_DATABASE_URL"], autocommit=True) as c:
        return c.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]


def _run(*argv, hosts=None):
    env = {**os.environ, "PULSE_PAIR_CODE_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(TOOL), "--exec", "", "--db-user", "", "--database", os.environ["PULSE_CI_DATABASE_URL"],
                           *argv], capture_output=True, text=True, check=False, timeout=120, env=env)


@pytest.fixture
def seated(worker, owner, api):
    """A synthetic organisation with an admin and an editor, each with a Pulse account (@handle) and a seat."""
    w = build_world(worker, owner, api)
    admin_id = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic pair admin','staff')", (admin_id, w.org))
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


def _counts(owner, org):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute("""select (select count(*) from pulse_priv.platform_audit where target_org = %s and action = 'runner.pair_code') ledger,
                                       (select count(*) from pulse_priv.runner_pair_code where org_id = %s) codes,
                                       (select count(*) from pulse.login_session) sessions""", (org, org)).fetchone()


def test_code_alphabet_and_hash_match_the_api():
    ts = (ROOT / "services/api/src/runner-model.ts").read_text()
    spec = importlib.util.spec_from_file_location("pair_code", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert f"const ALPHABET = '{mod.ALPHABET}'" in ts
    assert f"sha256(`{mod.CODE_PREFIX}${{code}}`)" in ts
    assert mod.make_code(bytes(range(8))) == "ABCD-EFGH"
    assert CODE_RE.match(mod.make_code())
    assert mod.code_hash("ABCD-EFGH") == hashlib.sha256(b"runner-code:ABCD-EFGH").hexdigest()


def test_mints_a_code_that_pairs_and_writes_the_ledger_not_the_code(owner, api, seated):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, admin_id, org_handle, handles = seated
    before = _counts(owner, w.org)
    p = _run("--org", org_handle, "--as", handles["admin"], "--approver", "Synthetic Owner (owner)", "--words", "synthetic approval words")
    assert p.returncode == 0, p.stdout + p.stderr
    code = p.stdout.strip()
    assert CODE_RE.match(code), "stdout carries the code and nothing else"
    assert code not in p.stderr
    after = _counts(owner, w.org)
    assert after["ledger"] == before["ledger"] + 1 and after["codes"] == before["codes"] + 1
    assert after["sessions"] == before["sessions"], "no sign-in session is made"
    with owner.transaction():
        set_tenant(owner, w.org)
        row = owner.execute("select created_by, used_at from pulse_priv.runner_pair_code where code_hash = %s",
                            (hashlib.sha256(f"runner-code:{code}".encode()).hexdigest(),)).fetchone()
        assert row["created_by"] == admin_id and row["used_at"] is None
        led = owner.execute("select actor, reason, detail from pulse_priv.platform_audit where target_org = %s and action = 'runner.pair_code' order by at desc limit 1",
                            (w.org,)).fetchone()
        assert led["reason"] == "synthetic approval words" and "Synthetic Owner (owner)" in led["actor"]
        assert led["detail"]["approver"] == "Synthetic Owner (owner)" and led["detail"]["onBehalfOf"] == str(admin_id)
        set_tenant(owner, w.org)
        org_audit = owner.execute("select count(*) n from pulse.audit_event where org_id = %s and action = 'platform.runner.pair_code'", (w.org,)).fetchone()["n"]
        assert org_audit >= 1, "the organisation's own Audit shows it"
        leaked = owner.execute("""select (select count(*) from pulse_priv.platform_audit where detail::text like %s or coalesce(reason,'') like %s)
                                       + (select count(*) from pulse.audit_event where org_id = %s and (coalesce(changes::text,'') like %s or coalesce(fields::text,'') like %s)) n""",
                               (f"%{code}%", f"%{code}%", w.org, f"%{code}%", f"%{code}%")).fetchone()["n"]
        assert leaked == 0, "the code itself is never stored"
    # the code pairs a server, exactly like one made in Settings
    with api.transaction():
        d = api.execute("select pulse.runner_pair(%s,%s,'synthetic-box','linux','x64','0.1.0') d",
                        (hashlib.sha256(f"runner-code:{code}".encode()).hexdigest(), hashlib.sha256(b"prc_synthetic" + uuid.uuid4().bytes).hexdigest())).fetchone()["d"]
    assert d["status"] == "ok" and d["orgId"] == str(w.org)


def test_refuses_a_person_who_is_not_an_admin_and_writes_nothing(owner, seated):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, _admin_id, org_handle, handles = seated
    before = _counts(owner, w.org)
    p = _run("--org", org_handle, "--as", handles["editor"], "--approver", "Synthetic Owner", "--words", "synthetic approval words")
    assert p.returncode == 2 and p.stdout == "", p.stdout + p.stderr
    assert "organisation admins" in p.stderr
    nobody = _run("--org", org_handle, "--as", "syn" + uuid.uuid4().hex[:10], "--approver", "Synthetic Owner", "--words", "synthetic approval words")
    assert nobody.returncode == 2 and nobody.stdout == ""
    assert _counts(owner, w.org) == before, "a refused code leaves no code and no ledger line"


def test_needs_approval_words_and_the_pulse_server():
    p = _run("--org", "syntheticorg", "--approver", "Synthetic Owner", "--words", " ")
    assert p.returncode == 2 and p.stdout == "" and "--words" in p.stderr
    elsewhere = _run("--org", "syntheticorg", "--approver", "Synthetic Owner", "--words", "synthetic approval words", hosts="some-other-host")
    assert elsewhere.returncode == 2 and elsewhere.stdout == "" and "only on the Pulse server" in elsewhere.stderr


def test_there_is_no_web_route_for_it():
    src = "\n".join(f.read_text() for f in (ROOT / "services/api/src").glob("*.ts"))
    assert len(re.findall(r"runner_pair_code_create", src)) == 1, "the admin route in runner.ts is the only API caller"
