"""QA-1 step 1 (owner, 18 Nov 2026: "Yes, start stage 1"): tools/admin/qa-org.py makes the QA organisation, one synthetic
person per role, marked test and rehearsal, run the way production runs it (the migrator login, never the superuser).

* Only a Pulse platform admin may act; a dry run writes nothing (no rows, no file).
* --apply: the company (owner: admin + leadership), test + rehearsal; qa.admin, qa.saleshead, qa.seller, qa.finance,
  qa.hr with their roles; the client login qa.client; the AI employee qa.agent with one key. No account has an e-mail
  address, none is a platform admin. Every password and the key are in the credentials file (600, folder 700) and
  nowhere in the tool's output; each one signs in.
* A run again changes nothing; --rotate gives new passwords and a new key and revokes the old key.
Synthetic organisations and people only."""
import hashlib
import json
import os
import re
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


def run_link(*argv, hosts=None):
    from conftest import ADMIN_URL, MODE, role_url
    url = role_url("migrate") if MODE["value"] == "superuser" else ADMIN_URL
    env = {**os.environ, "PULSE_ADMIN_TOOL_HOSTS": hosts if hosts is not None else socket.gethostname()}
    return subprocess.run([sys.executable, str(TOOL), "signin-link", *argv, "--database", url],
                          capture_output=True, text=True, check=False, timeout=120, env=env)


def test_signin_link_is_the_one_time_link_for_a_qa_person_only(boss, worker, owner, api, tmp_path):
    """QA-1B (PC orchestrator, 18 Nov 2026): signin-link mints PEOPLE-CONTACTS' one-time sign-in link (15 minutes, once)
    for a person of a QA (test + rehearsal) company only, writes the link alone to a mode-600 file, never prints it and
    never e-mails it; the person's own password keeps working."""
    tag = uuid.uuid4().hex[:6]
    org_handle = f"ql{tag}"
    creds = tmp_path / "cfg" / "qa.json"
    assert run("--org-handle", org_handle, "--as", boss, "--credentials", str(creds), "--apply").returncode == 0
    data = json.loads(creds.read_text())
    org = data["org"]["id"]
    out = tmp_path / "to-mac" / "QA-SIGNIN-LINK.md"
    code_file = out.with_name("QA-SIGNIN-CODE.md")  # SIGNIN-CODE: the link's code, beside it by default
    out.parent.mkdir()
    base = ("--org-handle", org_handle, "--out", str(out), "--base-url", "https://app.example.test")
    seller = owner.execute("""select m.person_id from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id = m.account_id
                               where a.handle = 'qa.seller' and m.member_org = %s""", (org,)).fetchone()["person_id"]

    def credential():
        with owner.transaction():
            set_tenant(owner, org)
            return owner.execute("select status, must_change from pulse.login_credential where person_id = %s", (seller,)).fetchone()

    # Refused, nothing written: another host; the AI employee and the client (no Pulse account); a platform admin in a
    # real company; nobody; the right person asked for in another company.
    assert run_link("qa.seller", *base, hosts="elsewhere").returncode == 2
    for who, why in (("qa.agent", "not a Pulse account"), ("qa.client", "not a Pulse account"), (boss, "not a QA (test + rehearsal) one"),
                     ("qa.nobody", "not a Pulse account")):
        r = run_link(who, *base)
        assert r.returncode == 2 and why in r.stderr, (who, r.stderr)
    r = run_link("qa.seller", "--org-handle", "vitalsqanot", "--out", str(out))
    assert r.returncode == 2 and "is not in @vitalsqanot" in r.stderr, r.stderr
    assert not out.exists() and not code_file.exists() and credential() is None

    # A dry run checks and mints, then keeps nothing.
    r = run_link("qa.seller", *base, "--dry-run")
    assert r.returncode == 0 and json.loads(r.stdout)["applied"] is False, r.stderr
    assert not out.exists() and not code_file.exists() and credential() is None

    r = run_link("qa.seller", *base)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    assert got["applied"] and got["credentialMade"] and got["person"] == str(seller) and got["out"] == str(out)
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    text = out.read_text()
    assert re.fullmatch(r"https://app\.example\.test/login/link#[A-Za-z0-9_-]{43}\n", text), "the file holds the link alone"
    token = text.strip().split("#", 1)[1]
    assert token not in r.stdout + r.stderr, "the link reached the tool's output"
    assert tuple(credential().values()) == ("active", False)
    # SIGNIN-CODE (19 Nov 2026): the link's 8-character code alone in its own 600 file, never in the output.
    assert got["codeOut"] == str(code_file) and stat.S_IMODE(code_file.stat().st_mode) == 0o600
    first_code = code_file.read_text()
    assert re.fullmatch(r"[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}\n", first_code), "the code file holds the code alone"
    assert first_code[:4] + first_code[5:9] not in r.stdout + r.stderr and first_code.strip() not in r.stdout + r.stderr

    def redeem(tok):
        with api.transaction():
            set_tenant(api, org)
            return api.execute("select pulse.auth_link_sign_in_any('staff', %s, '', %s, 'qa-org test') d",
                               (hashlib.sha256(tok.encode()).hexdigest(), hashlib.sha256(uuid.uuid4().bytes).hexdigest())).fetchone()["d"]

    # A newer link replaces the older one; the link signs the seller in once, with no password change asked.
    r = run_link("qa.seller", *base)
    assert r.returncode == 0 and json.loads(r.stdout)["credentialMade"] is False, r.stderr
    newer = out.read_text().strip().split("#", 1)[1]
    assert newer != token and redeem(token) is None
    signed = redeem(newer)
    assert signed and signed["actor"] == str(seller) and signed["mustChange"] is False and signed.get("expiresAt"), signed
    assert redeem(newer) is None, "a sign-in link works once"

    # SIGNIN-CODE (19 Nov 2026): the link's code, typed with the username in the installed app, is the same sign-in. On
    # the shared address (the install's own organisation) it finds the QA company, as the link does.
    def by_code(user, typed, here=None):
        with api.transaction():
            set_tenant(api, here or org)
            return api.execute("select pulse.auth_link_code_sign_in(%s, %s, '', %s, 'qa-org test') d",
                               (user, typed, hashlib.sha256(uuid.uuid4().bytes).hexdigest())).fetchone()["d"]

    used_code = code_file.read_text().strip()
    assert used_code != first_code.strip() and by_code("qa.seller", first_code) is None and by_code("qa.seller", used_code) is None, \
        "a replaced link's code and a used link's code sign nobody in"
    assert run_link("qa.seller", *base).returncode == 0
    fresh, fresh_link = code_file.read_text().strip(), out.read_text().strip().split("#", 1)[1]
    assert by_code("qa.saleshead", fresh) is None and by_code("qa.nobody", fresh) is None, "the code works only with its username"
    install = owner.execute("select pulse.install_org() o").fetchone()["o"]
    assert install and str(install) != org
    signed = by_code(" QA.Seller ", fresh.lower().replace("-", " "), here=install)
    assert signed and signed["actor"] == str(seller) and signed.get("expiresAt") and signed.get("org") == org, signed
    assert by_code("qa.seller", fresh) is None and redeem(fresh_link) is None, "once: the code used the link up with it"

    # Five wrong tries end a code; its link still works.
    assert run_link("qa.seller", *base).returncode == 0
    ending, ending_link = code_file.read_text().strip(), out.read_text().strip().split("#", 1)[1]
    wrong = "2222-2222" if ending != "2222-2222" else "3333-3333"
    assert all(by_code("qa.seller", wrong) is None for _ in range(5))
    assert by_code("qa.seller", ending) is None, "five wrong tries end the code"
    assert redeem(ending_link), "the link itself still signs in"
    with owner.transaction():
        set_tenant(owner, org)
        seen = {r["action"] for r in owner.execute("select action from pulse_priv.auth_event where org_id = %s and actor = %s", (org, seller))}
    assert {"signin_link_code_issued", "signin_link_code_accepted", "signin_link_code_failed", "signin_link_code_ended"} <= seen, seen

    # The seller's own password still signs in, into one of its companies (in a shared test database the first test's QA
    # company may be the one it used last).
    with api.transaction():
        again = api.execute("select pulse.account_sign_in(%s, %s, %s, 'qa-org test', %s) r",
                            ("qa.seller", data["logins"]["seller"]["password"], uuid.uuid4().hex, uuid.uuid4().hex)).fetchone()["r"]
    mine = {str(r["member_org"]) for r in owner.execute("""select m.member_org from pulse_priv.account_member m
                                                            join pulse_priv.pulse_account a on a.id = m.account_id where a.handle = 'qa.seller'""")}
    assert again and not again.get("failed") and again.get("org") in mine and org in mine, again

    # The company's Audit: each link the tool issued, as the account history's event (staff_auth) and the tool's own row
    # (person: why, whether a credential was made, delivered to a file), both under the tool's name.
    with owner.transaction():
        set_tenant(owner, org)
        rows = owner.execute("""select resource, count(*) n from pulse.audit_event where org_id = %s and action = 'signin_link_issued'
                                  and resource_id = %s and actor_account like 'qa-org.py signin-link%%' group by resource""",
                             (org, str(seller))).fetchall()
    assert {r["resource"]: r["n"] for r in rows} == {"person": 4, "staff_auth": 4}, rows


def test_long_profile_makes_the_long_name_qa_company_for_dev_only(boss, worker, owner, api, tmp_path):
    """QA-1D step 4b (QA-SYSTEM-RESEARCH §4.4 R14): --profile long makes the long-name QA company with qal.* logins whose
    names run past 40 characters, in English, Hindi and Marathi; test + rehearsal as the other; never for production's
    address (nor its database)."""
    tag = uuid.uuid4().hex[:6]
    org_handle = f"qal{tag}"
    creds = tmp_path / "cfg" / "long.json"
    base = ("--profile", "long", "--org-handle", org_handle, "--as", boss, "--credentials", str(creds))

    r = run(*base, "--base-url", "https://app.vitalsos.ai", "--apply")
    assert r.returncode == 2 and "dev only" in r.stderr, r.stderr
    assert not creds.exists()

    r = run(*base, "--apply")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["profile"] == "long"
    org = org_of(owner, out["org"]["id"], org_handle)
    assert org and (org["purpose"], org["rehearsal"], org["status"]) == ("test", True, "active")
    assert len(out["org"]["name"]) <= 80 and re.search(r"[ऀ-ॿ]", out["org"]["name"]) and "(TEST)" in out["org"]["name"]
    data = json.loads(creds.read_text())
    assert data["profile"] == "long" and data["baseUrl"] == "https://dev.vitalsos.ai"
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600
    logins = data["logins"]
    assert {v.get("handle") or v.get("username") for v in logins.values()} == {
        "qal.owner", "qal.admin", "qal.saleshead", "qal.seller", "qal.finance", "qal.hr", "qal.client", "qal.agent"}
    secrets_ = [v.get("password") or v.get("key") for v in logins.values()]
    assert not any(s in r.stdout or s in r.stderr for s in secrets_), "a secret reached the tool's output"

    # The people: long names (Devanagari among them), the same roles as the standard QA company, each signs in there.
    names = []
    for key, roles in ROLES.items():
        handle = logins[key]["handle"]
        assert handle.startswith("qal.")
        acct = owner.execute("select id, email from pulse_priv.pulse_account where handle = %s", (handle,)).fetchone()
        assert acct and acct["email"] is None, key
        with owner.transaction():
            set_tenant(owner, org["id"])
            seat = owner.execute("""select p.display_name from pulse_priv.account_member m join pulse.person p on p.id = m.person_id
                                     where m.account_id = %s and m.member_org = %s""", (acct["id"], org["id"])).fetchone()
        assert seat and len(seat["display_name"]) >= 40, (key, seat)
        names.append(seat["display_name"])
        assert out["people"][key]["roles"] == roles, (key, out["people"][key])
        with api.transaction():
            got = api.execute("select pulse.account_sign_in(%s, %s, %s, 'qa-org test', %s) r",
                              (handle, logins[key]["password"], uuid.uuid4().hex, uuid.uuid4().hex)).fetchone()["r"]
        assert got and not got.get("failed") and got.get("org") == str(org["id"]), (key, got)
    assert any(re.search(r"[ऀ-ॿ]", n) for n in names) and any(n.isascii() for n in names), names

    # A run again changes nothing.
    again = run(*base, "--apply")
    assert again.returncode == 0, again.stderr
    assert not any(v.get("createdSeat") or v.get("rolesAdded") or v.get("newPassword") or v.get("newKey") or v.get("created")
                   for v in json.loads(again.stdout)["people"].values())


def test_demo_profile_makes_the_investor_demo_company_with_its_own_people(boss, worker, owner, api, tmp_path):
    """DEMO-PULSE-2 (investor demo, 20 Nov 2026; the orchestrator for the owner: "a separate demo company with a believable
    name ... marked test + rehearsal like the QA org (synthetic people, no e-mail) ... keep the QA org untouched"):
    --profile demo makes "Suryoday Solar (Demo)" with demo.* people under believable names, no client login and no
    generic AI employee, allowed on production's address; a QA company's people are not added to it; the one-time
    sign-in link works for its people, issued by its own synthetic owner."""
    tag = uuid.uuid4().hex[:6]
    qa_handle, demo_handle = f"qd{tag}", f"sd{tag}"
    qa_creds, creds = tmp_path / "cfg" / "qa.json", tmp_path / "cfg" / "demo.json"
    assert run("--org-handle", qa_handle, "--as", boss, "--credentials", str(qa_creds), "--apply").returncode == 0
    qa_org = json.loads(qa_creds.read_text())["org"]["id"]
    base = ("--profile", "demo", "--org-handle", demo_handle, "--as", boss, "--credentials", str(creds))

    r = run(*base)  # a dry run: nothing kept, no file
    assert r.returncode == 0 and json.loads(r.stdout)["applied"] is False, r.stderr
    assert not creds.exists() and not owner.execute("select 1 from pulse_priv.handle_name where handle = %s", (demo_handle,)).fetchone()

    r = run(*base, "--apply")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["profile"] == "demo" and out["org"]["name"] == "Suryoday Solar (Demo)"
    org = org_of(owner, out["org"]["id"], demo_handle)
    assert org and (org["purpose"], org["rehearsal"], org["status"]) == ("test", True, "active")
    data = json.loads(creds.read_text())
    assert data["profile"] == "demo" and data["baseUrl"] == "https://app.vitalsos.ai" and data["org"]["handle"] == demo_handle
    assert stat.S_IMODE(creds.stat().st_mode) == 0o600
    logins = data["logins"]
    assert set(logins) == set(ROLES) and all(v["kind"] == "staff" for v in logins.values()), "no client login, no AI employee"
    assert not any(v["password"] in r.stdout + r.stderr for v in logins.values()), "a secret reached the tool's output"
    with owner.transaction():
        set_tenant(owner, org["id"])
        assert owner.execute("select count(*) n from pulse.person where org_id = %s and side = 'agent'", (org["id"],)).fetchone()["n"] == 0
        assert not owner.execute("select 1 from pulse_priv.portal_principal where org_id = %s", (org["id"],)).fetchone()
        members = {r["handle"] for r in owner.execute("""select a.handle from pulse_priv.account_member m
                       join pulse_priv.pulse_account a on a.id = m.account_id where m.member_org = %s""", (org["id"],))}
    assert members == {v["handle"] for v in logins.values()} and all(h.startswith("demo.") for h in members), members

    # Believable names, no e-mail, the same roles as the QA company; each signs in, into the demo company.
    for key, roles in ROLES.items():
        handle = logins[key]["handle"]
        acct = owner.execute("select id, email, display_name from pulse_priv.pulse_account where handle = %s", (handle,)).fetchone()
        assert acct and acct["email"] is None and "synthetic" not in acct["display_name"].lower(), (key, acct)
        assert out["people"][key]["roles"] == roles, (key, out["people"][key])
        with api.transaction():
            got = api.execute("select pulse.account_sign_in(%s, %s, %s, 'qa-org test', %s) r",
                              (handle, logins[key]["password"], uuid.uuid4().hex, uuid.uuid4().hex)).fetchone()["r"]
        assert got and not got.get("failed") and got.get("org") == str(org["id"]), (key, got)

    # The QA company keeps only its own people.
    with owner.transaction():
        set_tenant(owner, qa_org)
        qa_members = {r["handle"] for r in owner.execute("""select a.handle from pulse_priv.account_member m
                          join pulse_priv.pulse_account a on a.id = m.account_id where m.member_org = %s""", (qa_org,))}
    assert qa_members and all(h.startswith("qa.") for h in qa_members), qa_members

    # The one-time sign-in link for the demo seller, sent by demo.owner (the company's synthetic owner).
    link = tmp_path / "to-mac" / "DEMO-SIGNIN-LINK.md"
    link.parent.mkdir()
    r = run_link("demo.seller", "--org-handle", demo_handle, "--out", str(link), "--base-url", "https://app.example.test")
    assert r.returncode == 0 and json.loads(r.stdout)["org"] == demo_handle, r.stderr
    assert stat.S_IMODE(link.stat().st_mode) == 0o600
    with owner.transaction():  # it went through as the company's own synthetic owner (none found -> refused)
        set_tenant(owner, org["id"])
        rows = owner.execute("""select resource, count(*) n from pulse.audit_event where org_id = %s and action = 'signin_link_issued'
                                  group by resource""", (org["id"],)).fetchall()
    assert {r["resource"]: r["n"] for r in rows} == {"person": 1, "staff_auth": 1}, rows

    # A run again changes nothing.
    again = run(*base, "--apply")
    assert again.returncode == 0, again.stderr
    assert not any(v.get("createdSeat") or v.get("rolesAdded") for v in json.loads(again.stdout)["people"].values())
