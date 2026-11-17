"""FIX-SHELL (owner walkthrough, 10 Nov 2026). "Funding: I can't reach it from Estate Autopilots. Make Focus/Funding
reachable from any org; never a dead page." pulse.account_org_only (1947) gives, for each of the signed-in account's
staff seats, the organisation-only modules switched on there, read inside each company under its own row security, so
the menu links to them (/@handle/funding). Product map is organisation-only now too. Synthetic companies only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from psycopg.conninfo import conninfo_to_dict
from conftest import dsn
from pulse_sdk.db import set_tenant
from test_my_day import _MARK, _account, _token
from test_org_switcher import _grant, _world
from test_tasks_rt1 import as_
from helpers import build_world


def _modules(owner, w, body):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.tenant_config set is_active=false where org_id=%s and doc_kind='tenant' and doc_key='modules'", (w.org,))
        owner.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'tenant','modules',"
                      "(select coalesce(max(version),0)+1 from pulse.tenant_config where org_id=%s and doc_kind='tenant' and doc_key='modules'),%s,true)",
                      (w.org, w.org, json.dumps(body)))


def test_org_only_modules_of_each_of_the_accounts_companies(api, worker, owner):
    a = _world(worker, owner, api, "Synthetic Riverside Studio")
    b = _world(worker, owner, api, "Synthetic Funding Desk")
    c = _world(worker, owner, api, "Synthetic Owner Space")
    other = build_world(worker, owner, api)
    _modules(owner, b, {"off": [], "on": ["funding", "product_map", "creative"]})
    _modules(owner, c, {"off": ["focus"], "on": ["focus", "pulse_hq"]})
    _modules(owner, other, {"off": [], "on": ["funding"]})
    _account(owner, *((w.org, w.editor) for w in (a, b, c)))
    rows = as_(api, a, a.editor, "select pulse.account_org_only() l, current_setting('pulse.org_id') o, current_setting('pulse.viewer_id') v")
    only = {x["id"]: x["on"] for x in rows[0]["l"]}
    # Read inside each company and put back: the request's own organisation and viewer are unchanged.
    assert rows[0]["o"] == str(a.org) and rows[0]["v"] == str(a.editor)
    # Only organisation-only modules (never a company-chosen one), "off" wins, and companies with none are left out.
    assert only == {str(b.org): ["funding", "product_map"], str(c.org): ["pulse_hq"]}
    # Never a company the account is not in.
    assert str(other.org) not in only
    # A colleague without a Pulse account, and nobody signed in: nothing.
    assert as_(api, a, a.editor2, "select pulse.account_org_only() l")[0]["l"] == []
    assert as_(api, a, None, "select pulse.account_org_only() l")[0]["l"] == []


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_fix_shell_in_the_browser(api, worker, owner):
    """services/api/test/fix-shell-browser-runner.mjs: the company shown once in the rail (collapsed and open), All apps as
    one clear grid with groups, Recent and a readable chosen group, no Product map outside the companies that have it,
    Focus/Funding linked across (/@handle/funding), and the company path switching and opening the page. 1440 and 363,
    light and dark. Screenshots with PULSE_FS_SCREENSHOTS."""
    a = _world(worker, owner, api, "Synthetic Riverside Studio", mark=_MARK)
    b = _world(worker, owner, api, "Synthetic Harbour Sales")
    _grant(owner, a, a.editor, "admin", "Founder")
    _grant(owner, b, b.editor, "admin")
    _modules(owner, b, {"off": [], "on": ["funding", "product_map"]})
    handle_b = "synth" + uuid.uuid4().hex[:8]
    with owner.transaction():
        set_tenant(owner, b.org)
        owner.execute("update pulse.org set handle=%s where id=%s", (handle_b, b.org))
    _account(owner, (a.org, a.editor), (b.org, b.editor))
    with owner.transaction():
        set_tenant(owner, a.org)
        owner.execute("update pulse.account set purpose='Workspace account' where org_id=%s and handle=%s", (a.org, a.editor_handle))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"token": _token(api, a, a.editor, a.org), "email": a.editor_handle, "orgB": str(b.org), "handleB": handle_b,
                                   "nameA": "Synthetic Riverside Studio", "nameB": "Synthetic Harbour Sales"})}
    p = subprocess.run(["node", "test/fix-shell-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "checks passed" in p.stdout
