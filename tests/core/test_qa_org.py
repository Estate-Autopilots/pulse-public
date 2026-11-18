"""QA-1 step 1 (owner, 18 Nov 2026: "Yes, start stage 1"): tools/admin/qa-org.py makes the QA organisation, one synthetic
person per role, marked test and rehearsal, run the way production runs it (the migrator login, never the superuser).

* Only a Pulse platform admin may act; a dry run writes nothing (no rows, no file).
* --apply: the company (owner: admin + leadership), test + rehearsal; qa.admin, qa.saleshead, qa.seller, qa.finance,
  qa.hr with their roles; the client login qa.client; the AI employee qa.agent with one key. No account has an e-mail
  address, none is a platform admin. Every password and the key are in the credentials file (600, folder 700) and
  nowhere in the tool's output; each one signs in.
* A run again changes nothing; --rotate gives new passwords and a new key and revokes the old key.
Synthetic organisations and people only."""
import json
import os
import socket
import stat
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_investor_metrics import member, new_account
from test_profile_two import platform_seat

TOOL = Path(__file__).resolve().parents[2] / "tools/admin/qa-org.py"
ROLES = {"owner": ["admin", "leadership"], "admin": ["admin"], "sales_head": ["sales_head"], "seller": ["sales"],
         "finance": ["finance"], "hr": ["hr"]}


def run(*argv, hosts=None):
    from conftest import ADMIN_URL, MODE, role_url
    url = role_url("migrate") if MODE["value"] == "superuser" else ADMIN_URL
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(TOOL), "--database", url, "--approver", "Synthetic Owner (owner)",
                           "--words", "synthetic: make the QA organisation", *argv],
                          capture_output=True, text=True, check=False, timeout=300, env=env)


@pytest.fixture
def boss(worker, owner, api):
    """A platform admin with an account (and a real company first, so a fresh database's install is not the QA one)."""
    build_world(worker, owner, api)
    install, seat = platform_seat(worker, owner)
    handle = f"qaboss{uuid.uuid4().hex[:8]}"
    member(owner, new_account(owner, handle), install, seat)
    return handle


def org_of(owner, org_id, handle):
    """Read inside the organisation (pulse.org forces row security)."""
    with owner.transaction():
        set_tenant(owner, org_id)
        return owner.execute("select id, purpose, rehearsal, status from pulse.org where id = %s and handle = %s", (org_id, handle)).fetchone()


def test_qa_org_is_made_test_and_rehearsal_with_one_synthetic_person_per_role(boss, worker, owner, api, tmp_path):
    tag = uuid.uuid4().hex[:6]
    org_handle = f"qa{tag}"
    creds = tmp_path / "cfg" / "qa.json"
    base = ("--org-handle", org_handle, "--as", boss, "--credentials", str(creds))

    # Refused: another host; an install member who is not a platform admin; nothing written.
    assert run(*base, "--apply", hosts="elsewhere").returncode == 2
    nobody = f"qanob{tag}"
    new_account(owner, nobody)
    r = run("--org-handle", org_handle, "--as", nobody, "--credentials", str(creds), "--apply")
    assert r.returncode == 2 and "no active staff seat" in r.stderr, r.stderr

    # Dry run: does everything, keeps nothing.
    r = run(*base)
    assert r.returncode == 0, r.stderr
    dry = json.loads(r.stdout)
    assert dry["applied"] is False and dry["org"]["purpose"] == "test" and dry["org"]["rehearsal"] is True
    assert org_of(owner, dry["org"]["id"], org_handle) is None and not creds.exists()
    assert owner.execute("select count(*) n from pulse_priv.pulse_account where handle like 'qa.%%'").fetchone()["n"] == 0

    r = run(*base, "--apply")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    org = org_of(owner, out["org"]["id"], org_handle)
    assert org and (org["purpose"], org["rehearsal"], org["status"]) == ("test", True, "active")
    assert out["org"]["id"] == str(org["id"]) and out["credentials"] == str(creds)
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600 and stat.S_IMODE(creds.parent.stat().st_mode) == 0o700
    data = json.loads(creds.read_text())
    logins = data["logins"]
    assert set(logins) == {"owner", "admin", "sales_head", "seller", "finance", "hr", "client", "agent"}
    secrets_ = [v.get("password") or v.get("key") for v in logins.values()]
    assert all(s and len(s) >= 16 for s in secrets_)
    assert not any(s in r.stdout or s in r.stderr for s in secrets_), "a secret reached the tool's output"

    # Each staff persona: a synthetic account (no e-mail), an active staff seat with its role, never a platform admin.
    for key, roles in ROLES.items():
        handle = logins[key]["handle"]
        acct = owner.execute("""select id, email, crypt(%s, password_hash) = password_hash ok from pulse_priv.pulse_account
                                 where handle = %s""", (logins[key]["password"], handle)).fetchone()
        assert acct and acct["email"] is None and acct["ok"], key
        seat = owner.execute("select person_id from pulse_priv.account_member where account_id = %s and member_org = %s",
                             (acct["id"], org["id"])).fetchone()
        assert seat, key
        assert out["people"][key]["roles"] == roles, (key, out["people"][key])
        assert not owner.execute("select 1 from pulse_priv.platform_admin where person_id = %s", (seat["person_id"],)).fetchone()
        # It signs in, into the QA company.
        with api.transaction():
            got = api.execute("select pulse.account_sign_in(%s, %s, %s, 'qa-org test', %s) r",
                              (handle, logins[key]["password"], uuid.uuid4().hex, uuid.uuid4().hex)).fetchone()["r"]
        assert got and not got.get("failed") and got.get("org") == str(org["id"]), (key, got)

    # The client login and the AI employee.
    with owner.transaction():
        set_tenant(owner, org["id"])
        principal = owner.execute("""select must_change, active, crypt(%s, password_hash) = password_hash ok from pulse_priv.portal_principal
                                       where org_id = %s and username = 'qa.client'""", (logins["client"]["password"], org["id"])).fetchone()
        agent = owner.execute("""select p.id, p.side, m.daily_token_budget from pulse.people_profile pp join pulse.person p on p.id = pp.person_id
                                   join pulse.agent_member m on m.person_id = p.id where pp.org_id = %s and pp.username = 'qa.agent'""",
                               (org["id"],)).fetchone()
    assert principal and principal["ok"] and principal["active"] and principal["must_change"] is False
    assert agent and agent["side"] == "agent" and agent["daily_token_budget"] == 20000
    # The client signs in at the company's portal (no password change asked first).
    with api.transaction():
        set_tenant(api, org["id"])
        got = api.execute("select pulse.auth_login('client', 'qa.client', %s, %s, %s, false, 'qa-org test') d",
                          (logins["client"]["password"], uuid.uuid4().hex, uuid.uuid4().hex)).fetchone()["d"]
    assert got and not got.get("failed") and not got.get("mustChange"), got
    # As the API resolves a key: its company (rehearsal), then the co-worker inside it.
    with api.transaction():
        found = api.execute("select * from pulse.agent_key_org(%s)", (logins["agent"]["key"],)).fetchone()
        assert found and found["org_id"] == org["id"] and found["rehearsal"] is True
        set_tenant(api, org["id"])
        assert api.execute("select pulse.agent_key_resolve(%s) a", (logins["agent"]["key"],)).fetchone()["a"] == agent["id"]

    # Audit: the platform log and the company's own.
    assert owner.execute("""select count(*) n from pulse_priv.platform_audit where target_org = %s and action in ('qa.org_setup', 'org.purpose')""",
                         (org["id"],)).fetchone()["n"] == 2

    # A run again changes nothing.
    before = creds.read_text()
    r = run(*base, "--apply")
    assert r.returncode == 0, r.stderr
    again = json.loads(r.stdout)
    assert again["org"]["created"] is False and creds.read_text() == before
    assert not any(v.get("createdSeat") or v.get("rolesAdded") or v.get("newPassword") or v.get("newKey") or v.get("created")
                   for v in again["people"].values()), again["people"]

    # --rotate: new secrets; the old key no longer works.
    r = run(*base, "--apply", "--rotate")
    assert r.returncode == 0, r.stderr
    rotated = json.loads(creds.read_text())["logins"]
    assert all((rotated[k].get("password") or rotated[k].get("key")) != (logins[k].get("password") or logins[k].get("key")) for k in logins)
    with api.transaction():
        set_tenant(api, org["id"])
        assert api.execute("select pulse.agent_key_resolve(%s) a", (logins["agent"]["key"],)).fetchone()["a"] is None
        assert api.execute("select pulse.agent_key_resolve(%s) a", (rotated["agent"]["key"],)).fetchone()["a"] == agent["id"]
    assert owner.execute("select crypt(%s, password_hash) = password_hash ok from pulse_priv.pulse_account where handle = 'qa.seller'",
                         (rotated["seller"]["password"],)).fetchone()["ok"]
