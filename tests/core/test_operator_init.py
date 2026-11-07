"""First run of a fresh install (EST-546, ADR-0031 §2): pulse.install_init, the operator API and pulse-admin create
the company and its first admin, who signs in with the temporary password and must change it. Roles come only from
the database (EST-547, ADR-0031 §3): pulse-admin grant|revoke|roles, and the last admin cannot be revoked."""

from __future__ import annotations

import json
import os
import random
import string
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "synthetic-operator-token-0123456789abcdef"
INIT = "select * from pulse.install_init(%s,%s,%s,%s,%s,%s,%s)"
SIGNATURE = "pulse.install_init(text,text,text,text,text,text,text)"


def args(**override):
    values = {"name": "Northwind Studio", "slug": "northwind", "code": "NWS", "time_zone": "Europe/London",
              "email": "Admin@Northwind.example", "admin": "Admin", "actor": "operator"} | override
    return tuple(values.values())


def test_install_init_creates_the_company_its_admin_and_a_temporary_sign_in(api):
    with api.transaction(force_rollback=True):
        row = api.execute(INIT, args()).fetchone()
        org, person = row["org_id"], row["person_id"]
        assert 10 <= len(row["temporary_password"]) <= 72 and row["username"] == "admin.admin"
        assert api.execute("select pulse.install_org() o").fetchone()["o"] == org
        assert api.execute("select current_setting('pulse.org_id') o").fetchone()["o"] == str(org)
        assert api.execute("select name,slug,code,time_zone from pulse.org where id=%s", (org,)).fetchone() == {
            "name": "Northwind Studio", "slug": "northwind", "code": "NWS", "time_zone": "Europe/London"}
        assert api.execute("select initialised_by from pulse.install").fetchone()["initialised_by"] == "operator"
        assert api.execute("select display_name,side,status from pulse.person where id=%s", (person,)).fetchone() == {
            "display_name": "Admin", "side": "staff", "status": "active"}
        assert api.execute("select email from pulse.people_profile where person_id=%s", (person,)).fetchone()[
            "email"] == "admin@northwind.example"
        assert [r["role_key"] for r in api.execute(
            "select role_key from pulse.role_assignment where person_id=%s", (person,))] == ["admin"]

        verified = api.execute("select * from pulse.login_verify(%s,%s)",
                               (row["username"], row["temporary_password"])).fetchone()
        assert verified == {"person_id": person, "must_change": True}
        api.execute("select set_config('pulse.viewer_id',%s,true)", (str(person),))
        assert api.execute("select must_change,status from pulse.login_credential where person_id=%s",
                           (person,)).fetchone() == {"must_change": True, "status": "active"}
        audit = api.execute("select action,actor_account from pulse.audit_event where action in ('install_init','invite')"
                            " order by action").fetchall()
        assert audit == [{"action": "install_init", "actor_account": "operator"},
                         {"action": "invite", "actor_account": "operator"}]

        with pytest.raises(psycopg.errors.UniqueViolation, match="already initialised"), api.transaction():
            api.execute(INIT, args(slug="second", code="SEC"))

        api.execute("select pulse.operator_org_set(%s,'operator')", ("  Northwind   Studio Ltd ",))
        assert api.execute("select name from pulse.org where id=%s", (org,)).fetchone()["name"] == "Northwind Studio Ltd"
        assert api.execute("select old_value,new_value from pulse.record_change where entity_type='org'"
                           " and entity_id=%s", (org,)).fetchone() == {"old_value": "Northwind Studio",
                                                                       "new_value": "Northwind Studio Ltd"}


@pytest.mark.parametrize("override", [
    {"time_zone": "Mars/Olympus"}, {"time_zone": ""}, {"time_zone": None}, {"code": "nws"}, {"code": "NWSXY"},
    {"slug": "North wind"}, {"slug": "-x"}, {"email": "not-an-email"}, {"name": " "}, {"admin": ""}, {"actor": ""},
])
def test_install_init_has_no_defaults_and_refuses_invalid_values(api, override):
    with api.transaction(force_rollback=True):
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
            api.execute(INIT, args(**override))
        assert api.execute("select pulse.install_org() o").fetchone()["o"] is None


def test_operator_functions_are_for_the_api_role_only(api):
    with api.transaction(force_rollback=True), pytest.raises(psycopg.errors.NoDataFound):
        api.execute("select pulse.operator_org_set('Northwind','operator')")
    grants = api.execute(f"""select has_function_privilege('pulse_api','{SIGNATURE}','execute') api,
      has_function_privilege('pulse_worker','{SIGNATURE}','execute') worker,
      has_function_privilege('pulse_ingest','{SIGNATURE}','execute') ingest,
      has_function_privilege('pulse_privacy','{SIGNATURE}','execute') privacy,
      has_function_privilege('public','{SIGNATURE}','execute') everyone,
      has_function_privilege('pulse_worker','pulse.operator_org_set(text,text)','execute') worker_rename""").fetchone()
    assert grants == {"api": True, "worker": False, "ingest": False, "privacy": False, "everyone": False,
                      "worker_rename": False}


@contextmanager
def api_server(token: str | None):
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {k: v for k, v in os.environ.items() if k not in ("PULSE_ORG_ID", "PULSE_OPERATOR_TOKEN")}
    env |= {"TEST_API_CONFIG": json.dumps(config), "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "1",
            "PULSE_AUTH_MAIL_MODE": "sink"} | ({"PULSE_OPERATOR_TOKEN": token} if token else {})
    proc = subprocess.Popen(["node", "test/operator-server.mjs"], cwd=ROOT / "services/api", env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines: list[str] = []
    ready = threading.Event()

    def drain():
        for line in proc.stdout:
            lines.append(line)
            if line.startswith("operator-server listening "):
                ready.set()
        ready.set()

    threading.Thread(target=drain, daemon=True).start()
    try:
        assert ready.wait(60) and proc.poll() is None, "".join(lines)[-4000:]
        port = next(line.split()[-1] for line in lines if line.startswith("operator-server listening "))
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        proc.wait(20)


def http(url: str, method: str, path: str, body: dict | None = None, session: str | None = None):
    headers = {"content-type": "application/json", "x-pulse-client-ip": "198.51.100.46"}
    if session:
        headers["x-pulse-session"] = session
    request = urllib.request.Request(url + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def pulse_admin(url: str, *argv: str, token: str = TOKEN) -> subprocess.CompletedProcess:
    entry = Path(sys.executable).parent / "pulse-admin"
    assert entry.exists(), "the pulse-admin entry point is not installed (packages/sdk-py [project.scripts])"
    env = {**os.environ, "PULSE_OPERATOR_TOKEN": token}
    return subprocess.run([str(entry), "--url", url, *argv], env=env, capture_output=True, text=True, timeout=60,
                          check=False)


def test_pulse_admin_initialises_a_fresh_install_and_the_admin_signs_in(database):
    slug = "northwind-" + uuid.uuid4().hex[:8]
    code = "N" + "".join(random.choices(string.ascii_uppercase, k=3))
    with api_server(TOKEN) as url:
        status = pulse_admin(url, "status", "--json")
        assert status.returncode == 0 and json.loads(status.stdout)["initialised"] is False, status.stderr
        init = pulse_admin(url, "init", "--name", "Northwind Studio", "--slug", slug, "--code", code,
                           "--time-zone", "Europe/London", "--admin-email", "admin@northwind.example",
                           "--admin-name", "Admin")
        assert init.returncode == 0, init.stderr
        fields = dict(line.split(": ", 1) for line in init.stdout.splitlines() if ": " in line)
        username = fields["Username"].strip()
        temporary = fields["Temporary password (shown once, change it at first sign-in)"].strip()

        code_, signed = http(url, "POST", "/api/v0/auth/sign-in", {"username": username, "password": temporary})
        assert code_ == 200, signed
        code_, me = http(url, "GET", "/api/v0/me", session=signed["token"])
        assert code_ == 200 and me["mustChange"] is True and me["role"] == "admin"
        assert http(url, "GET", "/api/v0/settings", session=signed["token"])[0] == 403
        changed = http(url, "POST", "/api/v0/auth/change-password",
                       {"current": temporary, "next": "Fresh northwind admin cedar!"}, session=signed["token"])
        assert changed[0] == 200, changed
        code_, signed = http(url, "POST", "/api/v0/auth/sign-in",
                             {"username": username, "password": "Fresh northwind admin cedar!"})
        assert code_ == 200, signed
        code_, me = http(url, "GET", "/api/v0/me", session=signed["token"])
        assert code_ == 200 and me["mustChange"] is False
        assert me["roles"] == ["admin"] and me["orgName"] == "Northwind Studio"

        again = pulse_admin(url, "init", "--name", "Other", "--slug", "other-" + slug, "--code", "OTH",
                            "--time-zone", "Europe/London", "--admin-email", "a@other.example", "--admin-name", "Al")
        assert again.returncode == 1 and "409" in again.stderr
        wrong = pulse_admin(url, "status", token="wrong-operator-token-0123456789abcdef")
        assert wrong.returncode == 1 and "401" in wrong.stderr
        assert pulse_admin(url, "org", "set", "--name", "Northwind Studio Ltd").returncode == 0
        status = pulse_admin(url, "status", "--json")
        assert json.loads(status.stdout)["org"] == {"name": "Northwind Studio Ltd", "slug": slug, "code": code,
                                                    "time_zone": "Europe/London"}

    with api_server(None) as url:
        off = pulse_admin(url, "status")
        assert off.returncode == 1 and "404" in off.stderr
        assert http(url, "GET", "/api/v0/me", session=signed["token"])[1]["orgName"] == "Northwind Studio Ltd"


ROLE_SET = "select * from pulse.operator_role_set(%s,%s,%s,'operator')"


def ensure_installed(api) -> uuid.UUID:
    """The install's company: the one the test above created, or a fresh one when this file runs on its own."""
    org = api.execute("select pulse.install_org() o").fetchone()["o"]
    if org is None:
        with api.transaction():
            org = api.execute(INIT, args(slug="northwind-" + uuid.uuid4().hex[:8],
                                         code="N" + "".join(random.choices(string.ascii_uppercase, k=3)))).fetchone()["org_id"]
    return org


def test_operator_role_functions_are_for_the_api_role_only_and_check_their_input(api):
    ensure_installed(api)
    with api.transaction(force_rollback=True):
        for role in ("manager", "Admin", "", None):
            with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
                api.execute(ROLE_SET, ("admin@northwind.example", role, True))
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
            api.execute(ROLE_SET, ("not-an-email", "hr", True))
        with pytest.raises(psycopg.errors.NoDataFound, match="No staff member"), api.transaction():
            api.execute(ROLE_SET, ("nobody-" + uuid.uuid4().hex[:8] + "@northwind.example", "hr", True))
    for signature in ("pulse.operator_role_set(text,text,boolean,text)", "pulse.operator_roles(text)"):
        grants = api.execute(f"""select has_function_privilege('pulse_api','{signature}','execute') api,
          has_function_privilege('pulse_worker','{signature}','execute') worker,
          has_function_privilege('pulse_privacy','{signature}','execute') privacy,
          has_function_privilege('public','{signature}','execute') everyone""").fetchone()
        assert grants == {"api": True, "worker": False, "privacy": False, "everyone": False}, signature


def operator(url: str, method: str, path: str, body: dict | None = None):
    """A direct operator API call, as pulse-admin makes it (no web-tier headers)."""
    request = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def test_pulse_admin_grants_hr_to_a_second_account_and_never_revokes_the_last_admin(database, api, owner):
    tag = uuid.uuid4().hex[:8]
    second, email, temporary = uuid.uuid4(), f"people.{tag}@northwind.example", "Synthetic temporary " + tag
    with api_server(TOKEN) as url:
        org = ensure_installed(api)
        with owner.transaction():
            set_tenant(owner, org)
            admins = owner.execute("""select r.person_id,pp.email from pulse.role_assignment r
              join pulse.person p on p.id=r.person_id and p.status='active' join pulse.people_profile pp on pp.person_id=p.id
              where r.role_key='admin' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')""").fetchall()
            assert len(admins) == 1, "a fresh install has exactly one admin"
            first = admins[0]
            owner.execute("insert into pulse.person(id,org_id,display_name,side) values (%s,%s,%s,'staff')",
                          (second, org, "Second " + tag))
            owner.execute("insert into pulse.people_profile(org_id,person_id,role,email,evidence) "
                          "values (%s,%s,'Coordinator',%s,'Synthetic second account.')", (org, second, email))
        with api.transaction():
            set_tenant(api, org, first["person_id"])
            api.execute("select pulse.login_issue(%s,%s)", (second, temporary))
        with owner.transaction():
            set_tenant(owner, org)
            username = owner.execute("select username from pulse.people_profile where person_id=%s",
                                     (second,)).fetchone()["username"]

        code, signed = http(url, "POST", "/api/v0/auth/sign-in", {"username": username, "password": temporary})
        assert code == 200, signed
        changed = http(url, "POST", "/api/v0/auth/change-password",
                       {"current": temporary, "next": "Second northwind cedar " + tag}, session=signed["token"])
        assert changed[0] == 200, changed
        code, signed = http(url, "POST", "/api/v0/auth/sign-in",
                            {"username": username, "password": "Second northwind cedar " + tag})
        session = signed["token"]
        assert http(url, "GET", "/api/v0/me", session=session)[1]["role"] == "person"

        listed = pulse_admin(url, "roles", "--json")
        assert listed.returncode == 0, listed.stderr
        assert [(r["role"], r["email"]) for r in json.loads(listed.stdout)] == [("admin", first["email"])]

        granted = pulse_admin(url, "grant", "--email", email.upper(), "--role", "hr")
        assert granted.returncode == 0 and f"Granted hr to Second {tag}" in granted.stdout, granted.stderr
        code, me = http(url, "GET", "/api/v0/me", session=session)
        assert code == 200 and me["role"] == "hr" and me["roles"] == ["hr"]
        assert http(url, "GET", "/api/v0/hr/desk", session=session)[0] == 200             # HR tabs
        code, worked = http(url, "GET", "/api/v0/delivery/agent-contract", session=session)  # work tabs too (owner, 21 Oct 2026)
        assert not (code == 403 and worked.get("error") == "This account has HR access only"), (code, worked)
        assert http(url, "GET", "/api/v0/settings", session=session)[0] == 403             # admin tabs
        again = pulse_admin(url, "grant", "--email", email, "--role", "hr")
        assert again.returncode == 1 and "409: This person already has this role" in again.stderr

        code, last = operator(url, "POST", "/api/v1/operator/roles",
                              {"email": first["email"], "role": "admin", "action": "revoke"})
        assert code == 409 and last == {"error": "This is the last admin; grant admin to someone else first"}
        assert pulse_admin(url, "revoke", "--email", first["email"], "--role", "admin").returncode == 1
        assert pulse_admin(url, "grant", "--email", email, "--role", "admin").returncode == 0
        assert http(url, "GET", "/api/v0/me", session=session)[1]["role"] == "admin"
        assert pulse_admin(url, "revoke", "--email", email, "--role", "admin").returncode == 0
        assert pulse_admin(url, "revoke", "--email", email, "--role", "hr").returncode == 0
        assert http(url, "GET", "/api/v0/me", session=session)[1]["role"] == "person"
        assert [r["role"] for r in json.loads(pulse_admin(url, "roles", "--json").stdout)] == ["admin"]

    with owner.transaction():
        set_tenant(owner, org)
        changes = owner.execute("select field,old_value,new_value from pulse.record_change where entity_type='role' "
                                "and entity_id=%s order by changed_at,field", (second,)).fetchall()
        assert sorted(((c["field"], c["old_value"], c["new_value"]) for c in changes), key=lambda c: (c[0], c[1] or "")) == [
            ("admin", None, "granted"), ("admin", "held", None), ("hr", None, "granted"), ("hr", "held", None)]
        audit = owner.execute("select action,count(*)::int n from pulse.audit_event where actor_account='operator' "
                              "and resource='role' and resource_id=%s group by action order by action",
                              (str(second),)).fetchall()
        assert audit == [{"action": "operator_role_grant", "n": 2}, {"action": "operator_role_revoke", "n": 2}]
