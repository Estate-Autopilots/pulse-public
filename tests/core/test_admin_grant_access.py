"""ACCESS-SETUP: tools/admin/grant-access.py, seats, roles and logos set up at the Pulse server's terminal.

It adds a staff seat with the API's own statements as an organisation admin (no sign-in), links it to the Pulse account
so the company shows in that account's switcher, grants only the roles still missing, rolls back unless --apply, writes
the platform audit log with the approver's words, and refuses a person who is not an admin and any other host.
Synthetic data only.
"""
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
TOOL = ROOT / "tools/admin/grant-access.py"
WORDS = "synthetic approval words"


def _superuser() -> bool:
    with psycopg.connect(os.environ["PULSE_CI_DATABASE_URL"], autocommit=True) as c:
        return c.execute("select rolsuper from pg_roles where rolname = current_user").fetchone()[0]


def _run(*argv, hosts=None):
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    cmd, rest = argv[0], argv[1:]
    return subprocess.run([sys.executable, str(TOOL), cmd, "--exec", "", "--db-user", "", "--database", os.environ["PULSE_CI_DATABASE_URL"],
                           "--approver", "Synthetic Owner (owner)", "--words", WORDS, *rest],
                          capture_output=True, text=True, check=False, timeout=180, env=env)


@pytest.fixture
def seated(worker, owner, api):
    """A synthetic organisation with an admin and an editor (each with a Pulse account and a seat), and an outsider
    account with no seat there."""
    w = build_world(worker, owner, api)
    admin_id = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic grant admin','staff')", (admin_id, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, admin_id))
    handles = {}
    for key, person in (("admin", admin_id), ("editor", w.editor), ("outsider", None)):
        h = "syn" + uuid.uuid4().hex[:10]
        aid = uuid.uuid4()
        with owner.transaction():
            owner.execute("insert into pulse_priv.pulse_account(id, handle, display_name, email) values (%s, %s, 'Synthetic Human', %s)",
                          (aid, h, f"{h}@example.com"))
            owner.execute("insert into pulse_priv.handle_name(handle, kind, ref) values (%s, 'person', %s)", (h, aid))
            if person:
                owner.execute("insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (%s, %s, %s, 'staff')",
                              (aid, w.org, person))
        handles[key] = (h, aid)
    with owner.transaction():
        set_tenant(owner, w.org)
        org_handle = owner.execute("select handle from pulse.org where id = %s", (w.org,)).fetchone()["handle"]
    return w, admin_id, org_handle, handles


def _state(owner, org, account):
    with owner.transaction():
        set_tenant(owner, org)
        return owner.execute("""select (select count(*) from pulse_priv.account_member where member_org = %s and account_id = %s) seats,
                                       (select count(*) from pulse.person where org_id = %s and side = 'staff') staff,
                                       (select count(*) from pulse_priv.platform_audit where target_org = %s and action = 'admin.seat_grant') ledger,
                                       (select count(*) from pulse.login_session) sessions""", (org, account, org, org)).fetchone()


def test_seat_dry_run_writes_nothing_and_apply_adds_once(owner, seated):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, admin_id, org_handle, handles = seated
    h, aid = handles["outsider"]
    args = ("seat", "--org", org_handle, "--account", h, "--title", "Synthetic partner", "--roles", "leadership", "--as", handles["admin"][0])
    before = _state(owner, w.org, aid)
    dry = _run(*args)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "Dry run" in dry.stderr and _state(owner, w.org, aid) == before

    done = _run(*args, "--apply")
    assert done.returncode == 0, done.stdout + done.stderr
    after = _state(owner, w.org, aid)
    assert (after["seats"], after["staff"], after["ledger"]) == (1, before["staff"] + 1, before["ledger"] + 1)
    assert after["sessions"] == before["sessions"], "no sign-in session is made"
    with owner.transaction():
        set_tenant(owner, w.org)
        seat = owner.execute("""select p.side, p.status, pp.role, pp.username, pp.email,
                                       array(select role_key from pulse.role_assignment r where r.person_id = p.id) roles
                                  from pulse_priv.account_member m join pulse.person p on p.id = m.person_id
                                  join pulse.people_profile pp on pp.person_id = p.id where m.account_id = %s and m.member_org = %s""",
                             (aid, w.org)).fetchone()
        assert (seat["side"], seat["status"], seat["role"], seat["username"]) == ("staff", "active", "Synthetic partner", h)
        assert seat["email"] == f"{h}@example.com" and seat["roles"] == ["leadership"]
        led = owner.execute("select actor, reason, detail from pulse_priv.platform_audit where target_org = %s and action = 'admin.seat_grant' order by at desc limit 1",
                            (w.org,)).fetchone()
        assert led["reason"] == WORDS and "Synthetic Owner (owner)" in led["actor"] and led["detail"]["createdSeat"] is True
        assert owner.execute("select count(*) n from pulse.audit_event where org_id = %s and action = 'account_link'", (w.org,)).fetchone()["n"] >= 1

    again = _run(*args, "--apply")
    assert again.returncode == 0, again.stdout + again.stderr
    twice = _state(owner, w.org, aid)
    assert (twice["seats"], twice["staff"]) == (after["seats"], after["staff"]), "a second run adds nothing"


def test_logo_goes_through_the_brand_function(owner, seated, tmp_path):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, _admin_id, org_handle, handles = seated
    svg = tmp_path / "mark.svg"
    svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#123456"/></svg>', encoding="utf-8")
    p = _run("logo", "--org", org_handle, "--kind", "mark", "--file", str(svg), "--as", handles["admin"][0], "--apply")
    assert p.returncode == 0, p.stdout + p.stderr
    with owner.transaction():
        set_tenant(owner, w.org)
        b = owner.execute("select mark_mime, octet_length(mark) n from pulse.org_brand where org_id = %s", (w.org,)).fetchone()
        assert b["mark_mime"] == "image/svg+xml" and b["n"] == svg.stat().st_size


def test_refuses_a_non_admin_other_hosts_and_missing_words(owner, seated):
    if not _superuser():
        pytest.skip("the tool runs as the database superuser (as on the server)")
    w, _admin_id, org_handle, handles = seated
    h, aid = handles["outsider"]
    before = _state(owner, w.org, aid)
    p = _run("seat", "--org", org_handle, "--account", h, "--title", "Synthetic partner", "--as", handles["editor"][0], "--apply")
    assert p.returncode == 2, p.stdout + p.stderr
    assert _state(owner, w.org, aid) == before
    elsewhere = _run("seat", "--org", org_handle, "--account", h, "--title", "Synthetic partner", hosts="some-other-host")
    assert elsewhere.returncode == 2 and "only on the Pulse server" in elsewhere.stderr
    bad = _run("seat", "--org", org_handle, "--account", h, "--title", "Synthetic partner", "--roles", "owner")
    assert bad.returncode == 2 and "--roles" in bad.stderr
    q = subprocess.run([sys.executable, str(TOOL), "seat", "--org", org_handle, "--account", h, "--title", "Synthetic partner",
                        "--approver", "Synthetic Owner", "--words", " "], capture_output=True, text=True, check=False, timeout=60)
    assert q.returncode == 2 and "--words" in q.stderr


def test_there_is_no_web_route_for_it():
    src = "\n".join(f.read_text() for f in (ROOT / "services/api/src").glob("*.ts"))
    assert "grant-access" not in src


def test_legal_name_goes_through_the_settings_function(owner, seated):
    """CONNECTIONS (2199): the registered name, as Settings → Organisation saves it, with the approver's words as the note."""
    if not _superuser():
        pytest.skip("needs the admin role (as on the server)")
    w, admin_id, org_handle, handles = seated
    dry = _run("legal-name", "--org", org_handle, "--name", "Synthetic Registered Private Limited", "--as", handles["admin"][0])
    assert dry.returncode == 0, dry.stderr
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.audit_event where org_id=%s and action='org.legal_name'", (w.org,)).fetchone()["n"] == 0
    done = _run("legal-name", "--org", org_handle, "--name", "Synthetic Registered Private Limited", "--as", handles["admin"][0], "--apply")
    assert done.returncode == 0, done.stderr
    assert '"printed": "Synthetic Registered Private Limited"' in done.stdout
    with owner.transaction():
        set_tenant(owner, w.org)
        note = owner.execute("select actor_id, changes from pulse.audit_event where org_id=%s and action='org.legal_name'", (w.org,)).fetchone()
        name = owner.execute("select name from pulse.org where id=%s", (w.org,)).fetchone()["name"]
        ledger = owner.execute("select count(*) n from pulse_priv.platform_audit where target_org=%s and action='admin.legal_name'", (w.org,)).fetchone()["n"]
    assert note["actor_id"] == admin_id and note["changes"]["note"] == WORDS and name != "Synthetic Registered Private Limited" and ledger == 1
    # Not an admin: refused, nothing written.
    no = _run("legal-name", "--org", org_handle, "--name", "Synthetic Other Name", "--as", handles["editor"][0], "--apply")
    assert no.returncode == 2


def test_connection_backfill_is_suggested_with_a_draft(owner, seated, worker, api):
    """CONNECTIONS (2200): a backfilled connection is suggested (the owner confirms it), its note is the approver's words,
    and its agreement is a draft (never sent)."""
    if not _superuser():
        pytest.skip("needs the admin role (as on the server)")
    w, admin_id, org_handle, handles = seated
    other = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, other.org)
        other_handle = owner.execute("select handle from pulse.org where id = %s", (other.org,)).fetchone()["handle"]
    if not other_handle:
        other_handle = "syn" + uuid.uuid4().hex[:8]
        with owner.transaction():
            set_tenant(owner, other.org)
            owner.execute("update pulse.org set handle=%s where id=%s", (other_handle, other.org))
    r = _run("connection", "--org", org_handle, "--kind", "client", "--other-org", other_handle, "--draft", "--as", handles["admin"][0], "--apply")
    assert r.returncode == 0, r.stderr
    assert '"state": "draft"' in r.stdout
    with owner.transaction():
        c = owner.execute("select status, source, note from pulse_priv.org_connection where a_org=%s and b_org=%s", (w.org, other.org)).fetchone()
        set_tenant(owner, w.org)
        k = owner.execute("select status from pulse.contract where org_id=%s", (w.org,)).fetchall()
    assert c == {"status": "suggested", "source": "backfill", "note": WORDS}
    assert [x["status"] for x in k] == ["draft"]
    # Run again: the same connection is found, and no second draft.
    again = _run("connection", "--org", org_handle, "--kind", "client", "--other-org", other_handle, "--draft", "--as", handles["admin"][0], "--apply")
    assert again.returncode == 0 and '"existed": true' in again.stdout
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.contract where org_id=%s", (w.org,)).fetchone()["n"] == 1


def test_the_migration_login_acts_through_the_same_functions(owner, seated):
    """CONNECTIONS (17 Nov 2026): on the server the tool may only have the migration login (no superuser, not a member of
    pulse_api). The acting seat is read inside the organisation and the product functions run as pulse_owner
    (--admin-role): the same checks (an admin of that organisation) and the same audit notes."""
    if not _superuser():
        pytest.skip("needs the CI logins")
    from conftest import dsn
    w, admin_id, org_handle, handles = seated
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": socket.gethostname()}
    base = [sys.executable, str(TOOL), "legal-name", "--exec", "", "--db-user", "", "--database", dsn("migrate"), "--admin-role", "pulse_owner",
            "--approver", "Synthetic Owner (owner)", "--words", WORDS, "--org", org_handle, "--name", "Synthetic Login Private Limited"]
    no = subprocess.run([*base, "--as", handles["editor"][0], "--apply"], capture_output=True, text=True, check=False, timeout=180, env=env)
    assert no.returncode == 2, no.stdout + no.stderr
    ok = subprocess.run([*base, "--as", handles["admin"][0], "--apply"], capture_output=True, text=True, check=False, timeout=180, env=env)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert '"printed": "Synthetic Login Private Limited"' in ok.stdout
    with owner.transaction():
        set_tenant(owner, w.org)
        note = owner.execute("select actor_id from pulse.audit_event where org_id=%s and action='org.legal_name'", (w.org,)).fetchone()
        ledger = owner.execute("select count(*) n from pulse_priv.platform_audit where target_org=%s and action='admin.legal_name'", (w.org,)).fetchone()["n"]
    assert note["actor_id"] == admin_id and ledger == 1
