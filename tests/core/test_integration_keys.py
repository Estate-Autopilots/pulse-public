"""Admin integration keys: two synthetic companies, real PostgreSQL/RLS and HTTP/proxy boundaries."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import MODE, dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import as_agent, make_agent, owner_sql
from test_hr_suite import _staff
from test_tasks_rt1 import one


def test_integration_keys(api, worker, owner, tmp_path):
    first, other = build_world(worker, owner, api), build_world(worker, owner, api)
    for w in (first, other):
        _staff(worker, w)
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"integration-admin@{w.domain}", w.manager))
    agent, agent_key = make_agent(api, first, "integration-helper")
    foreign_agent, _ = make_agent(api, other, "other-helper")
    digest = "0" * 64
    query = "select pulse.integration_key_issue(%s,%s,%s,%s,%s) id"
    for who in (first.editor, agent):
        for statement, args in [(query, ("Synthetic", ["catalog.read"], 30, None, digest)),
                                ("select pulse.integration_key_list()", ()),
                                ("select pulse.integration_key_revoke(%s)", (uuid.uuid4(),))]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                one(api, first, who, statement, args)
    # Even a valid human admin viewer must be refused when the AI-session flag is on.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, first, first.manager, "select pulse.integration_key_list()")
    for name, scopes, days, binding in [("", ["catalog.read"], 30, None), ("Synthetic", [], 30, None),
                                       ("Synthetic", ["unknown"], 30, None), ("Synthetic", [None], 30, None),
                                       ("Synthetic", ["catalog.read"] * 2, 30, None),
                                       ("Synthetic", ["catalog.read"], 0, None), ("Synthetic", ["catalog.read"], 366, None),
                                       ("Synthetic", ["tasks.read"], 30, None), ("Synthetic", ["catalog.read"], 30, agent),
                                       ("Synthetic", ["tasks.read"], 30, foreign_agent)]:
        with pytest.raises((psycopg.errors.InvalidParameterValue, psycopg.errors.InsufficientPrivilege)):
            one(api, first, first.manager, query, (name, scopes, days, binding, digest))
    # Boundary expiry, direct SQL auth and the v1 principal cannot bypass the HTTP check.
    expired = one(api, first, first.manager, query, ("Expired", ["tasks.read"], 1, agent, digest))["id"]
    owner_sql(owner, first, "update pulse_priv.service_key set expires_at=now() where id=%s", (expired,))
    assert api.execute("select pulse.service_key_hash(%s) h", (expired,)).fetchone()["h"] is None
    assert not api.execute("select pulse.service_key_auth(%s,%s,'tasks.read') ok", (expired, digest)).fetchone()["ok"]
    with api.transaction():
        set_tenant(api, first.org)
        assert api.execute("select pulse.v1_service_principal(%s,%s,'tasks.read') id", (expired, digest)).fetchone()["id"] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, other, other.manager, query, ("Other company", ["catalog.read"], 365, None, digest))
    foreign = uuid.uuid4()
    owner_sql(owner, other, "insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label) values(%s,%s,%s,%s,'Synthetic foreign key')",
              (foreign, other.org, digest, ["catalog.read"]))
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, first, first.manager, "select pulse.integration_key_revoke(%s)", (foreign,))
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("insert into pulse.org_domain(org_id,host,sign_in,added_by) values(%s,'integration-other.example','access','synthetic')", (other.org,))
    def config(role):
        c = conninfo_to_dict(dsn("migrate" if role == "owner" and MODE["value"] == "superuser" else role))
        c["database"] = c.pop("dbname")
        return json.dumps(c)
    env = {**os.environ, "TEST_API_CONFIG": config("api"), "TEST_OWNER_CONFIG": config("owner"),
           "TEST_ORG": str(first.org), "TEST_ADMIN": str(first.manager), "TEST_ADMIN_EMAIL": f"integration-admin@{first.domain}",
           "TEST_OTHER_ADMIN_EMAIL": f"integration-admin@{other.domain}", "TEST_STAFF": first.editor_handle,
           "TEST_AGENT": str(agent), "TEST_AGENT_KEY": agent_key, "TEST_FOREIGN_AGENT": str(foreign_agent),
           "TEST_FOREIGN_KEY": str(foreign), "TEST_LOG": str(tmp_path / "integration-keys.log"), "PULSE_PUBLIC_LOGIN_ENABLED": "0"}
    p = subprocess.run(["node", "test/integration-keys-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                       env=env, capture_output=True, text=True, timeout=90)
    assert p.returncode == 0, (p.stdout + p.stderr)[-4000:]
    scan = subprocess.run(["grep", "-Eq", r"psvc_|pak_|[a-f0-9]{64}", env["TEST_LOG"]], capture_output=True)
    assert scan.returncode == 1, "Credential pattern found in captured application logs"
