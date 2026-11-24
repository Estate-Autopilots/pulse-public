"""OFFICE-PRINT (2503; owner at the Willow Lane office, 21 Nov 2026): the company print queue, its office print agent and
bhrātā's print_document, on real PostgreSQL and tenant row security. The routes run through
services/api/test/office-print-runner.mjs; the company apart is checked here. Synthetic data only; nothing is printed."""
import hashlib
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
from test_erp_invoice import _seed_erp_world, as_, erp, one  # noqa: F401  (erp is a fixture)


def test_the_office_print_queue_end_to_end(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "domain": w.domain})}
    result = subprocess.run(["node", "test/office-print-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, capture_output=True, text=True, timeout=240)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "OFFICE-PRINT runner: all checks passed" in result.stdout
    # The toner task went to the admin who connected the agent.
    with owner.transaction():
        set_tenant(owner, w.org)
        tasks = owner.execute("select title,owner_id from pulse.task where source='office_print'").fetchall()
    assert [(t["title"], t["owner_id"]) for t in tasks] == [("Order toner for Synthetic LaserJet M1", w.founder)]
    # Another company sees none of it, and the tables are closed to the API role (functions only).
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org)
        assert api.execute("select pulse.office_print_overview() v").fetchone()["v"] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.finance, "select count(*) from pulse.office_print_job")


def test_an_agent_token_finds_its_company_from_any_address(worker, owner, api, erp):  # noqa: F811
    """The first live token (21 Nov 2026): the agent calls app.vitalsos.ai, whose request company is not the token's.
    The token alone must find its company; another company's token or a revoked one finds nothing."""
    w = erp
    token = "vpa_" + "S" * 43
    digest = hashlib.sha256(token.encode()).hexdigest()
    agent = one(api, w, w.founder, "select pulse.office_print_agent_create('Synthetic office',%s) v", (digest,))["v"]
    platform = build_world(worker, owner, api)   # the address's company: not the token's
    with api.transaction():
        set_tenant(api, platform.org)
        assert api.execute("select pulse.office_print_known(%s) v", (digest,)).fetchone()["v"] is True
        assert api.execute("select pulse.office_print_next(%s,'office','p') v", (digest,)).fetchone()["v"] == {"known": True, "job": None}
        assert api.execute("select pulse.office_print_known(%s) v", (hashlib.sha256(b"vpa_other").hexdigest(),)).fetchone()["v"] is False
    one(api, w, w.founder, "select pulse.office_print_agent_revoke(%s) v", (agent,))
    with api.transaction():
        set_tenant(api, platform.org)
        assert api.execute("select pulse.office_print_known(%s) v", (digest,)).fetchone()["v"] is False
