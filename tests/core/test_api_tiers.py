"""API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API ... tier-wise access"): the API tier on
every call (migration 1595, services/api/test/api-tiers-runner.mjs): per-tier requests per minute with 429 and
Retry-After, areas outside the tier refused after a 14-day grace from a downgrade. And the phase-1 fix: the platform
admin's first edit of a company's limits keeps the company's tier (no plan row is enterprise) instead of the table's
'trial' default. Synthetic people only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def _config(role):
    try:
        c = conninfo_to_dict(dsn(role))
    except Exception:  # superuser mode names the owner role "migrate"
        c = conninfo_to_dict(dsn("migrate"))
    c["database"] = c.pop("dbname")
    return c


def test_first_limits_edit_keeps_the_tier(owner, erp):  # noqa: F811
    """platform_org_set on a company with no plan row: the row starts at enterprise ('custom'), not Free ('trial')."""
    w = erp
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("delete from pulse_priv.platform_plan where for_org=%s", (w.org,))
        assert owner.execute("select pulse.api_tier() v").fetchone()["v"] == "enterprise"
        # Only the guard is stood in for, inside this transaction (rolled back): the function body is the real one.
        owner.execute("create or replace function pulse.platform_guard() returns void language sql as 'select'")
        owner.execute("select pulse.platform_org_set(%s, %s::jsonb, 'Synthetic check of the API tier on a first limits edit')",
                      (w.org, json.dumps({"seatLimit": 40})))
        row = owner.execute("select plan, seat_limit, api_prior_tier from pulse_priv.platform_plan where for_org=%s", (w.org,)).fetchone()
        install = owner.execute("select pulse.install_org() = %s v", (w.org,)).fetchone()["v"]
        assert row["plan"] == ("internal" if install else "custom") and row["seat_limit"] == 40 and row["api_prior_tier"] is None, row
        assert owner.execute("select pulse.api_tier() v").fetchone()["v"] == "enterprise"
        assert owner.execute("select pulse.api_plan()->>'tier' v").fetchone()["v"] == "enterprise"
        # Choosing a lower plan in a later edit applies it, with the 14-day grace for calls.
        owner.execute("select pulse.platform_org_set(%s, %s::jsonb, 'Synthetic check of the API tier on a downgrade')", (w.org, json.dumps({"plan": "trial"})))
        assert owner.execute("select pulse.api_tier() v").fetchone()["v"] == "free"
        assert owner.execute("select pulse.api_call_tier() v").fetchone()["v"] == "enterprise"
        assert owner.execute("select pulse.api_plan()->>'graceUntil' v").fetchone()["v"]
        # A first edit that names the plan gets that plan.
        owner.execute("delete from pulse_priv.platform_plan where for_org=%s", (w.org,))
        owner.execute("select pulse.platform_org_set(%s, %s::jsonb, 'Synthetic check of the API tier with a plan')", (w.org, json.dumps({"plan": "growth", "seatLimit": 10})))
        assert owner.execute("select plan from pulse_priv.platform_plan where for_org=%s", (w.org,)).fetchone()["plan"] == "growth"
        assert owner.execute("select pulse.api_tier() v").fetchone()["v"] == "business"
        # Coming from no row (enterprise), that is a downgrade too: calls keep enterprise for the grace.
        assert owner.execute("select pulse.api_call_tier() v").fetchone()["v"] == "enterprise"
        raise psycopg.Rollback()   # the stand-in guard and the rows go with it
    with owner.transaction():
        set_tenant(owner, w.org)
        assert "platform_admin()" in owner.execute("select prosrc from pg_proc where oid='pulse.platform_guard()'::regprocedure").fetchone()["prosrc"]


def test_api_tier_on_every_call(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) select %s,%s,'admin','2026-01-01'
            where not exists(select 1 from pulse.role_assignment where person_id=%s and role_key='admin')""", (w.org, w.manager, w.manager))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"admin@{w.domain}", w.manager))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("delete from pulse_priv.platform_plan where for_org=%s", (w.org,))
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example",
           "TEST_API_CONFIG": json.dumps(_config("api")), "TEST_OWNER_CONFIG": json.dumps(_config("owner")),
           "TEST_W": json.dumps({"org": str(w.org), "adminEmail": f"admin@{w.domain}"})}
    p = subprocess.run(["node", "test/api-tiers-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 15, out
    with owner.transaction():
        set_tenant(owner, w.org)
        statuses = {r["status"] for r in owner.execute("select distinct status from pulse_priv.v1_call where org_id=%s", (w.org,)).fetchall()}
        assert {200, 403, 429} <= statuses, statuses
