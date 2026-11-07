"""API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"): webhooks
and the event stream on real tenant RLS (services/api/test/api-webhooks-runner.mjs, migration 1594), then what the
database holds afterwards: forced row security on the new tables, no secret readable by the API role, no body in the
delivery log, the per-tier webhook cap, and events recorded only for a company that has a webhook or a stream.
Synthetic people and addresses only; the receiver is local and DNS is faked."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)

TABLES = ("v1_webhook", "v1_event", "v1_webhook_delivery", "v1_event_listen")


def test_api_webhooks_and_events(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) select %s,%s,'admin','2026-01-01'
            where not exists(select 1 from pulse.role_assignment where person_id=%s and role_key='admin')""", (w.org, w.manager, w.manager))
    agent, _key = make_agent(api, w, "events-bot-synthetic")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"admin@{w.domain}", w.manager))

    # Nothing is recorded while the company has no webhook and no stream.
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse_priv.v1_event where org_id=%s", (w.org,)).fetchone()["n"] == 0

    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "agent": str(agent), "member": str(w.member), "memberEmail": f"member@{w.domain}", "adminEmail": f"admin@{w.domain}"})}
    p = subprocess.run(["node", "test/api-webhooks-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 60, out

    with owner.transaction():
        set_tenant(owner, w.org)
        for t in TABLES:
            r = owner.execute("select relrowsecurity r, relforcerowsecurity f from pg_class where oid=%s::regclass", (f"pulse_priv.{t}",)).fetchone()
            assert r["r"] and r["f"], t
            assert owner.execute("select count(*) n from pg_policies where schemaname='pulse_priv' and tablename=%s and policyname='tenant'", (t,)).fetchone()["n"] == 1, t
        cols = {r["column_name"] for r in owner.execute("select column_name from information_schema.columns where table_schema='pulse_priv' and table_name='v1_webhook_delivery'").fetchall()}
        assert not cols & {"body", "payload", "secret", "url", "response"}, cols
        types = {r["type"] for r in owner.execute("select distinct type from pulse_priv.v1_event where org_id=%s", (w.org,)).fetchall()}
        assert {"task.created", "task.completed", "webhook.ping"} <= types, types
        ops = {r["operation_id"] for r in owner.execute("select distinct operation_id from pulse_priv.v1_call where org_id=%s", (w.org,)).fetchall()}
        assert {"createWebhook", "listEvents", "streamEvents", "redeliverWebhookDelivery", "listWebhookDeliveries"} <= ops, ops

    # The API role cannot read webhook rows (and so never a secret) except through the admin functions.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        with pytest.raises(Exception, match="permission denied"):
            api.execute("select secret from pulse_priv.v1_webhook limit 1")

    # Per tier: a Free company (trial plan) may have no webhooks.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse_priv.platform_plan(for_org,plan) values(%s,'trial') on conflict(for_org) do update set plan='trial'", (w.org,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select pulse.api_plan()->>'webhooks' v").fetchone()["v"] == "0"
        with pytest.raises(Exception, match="plan allows 0 webhooks"):
            api.execute("select pulse.v1_webhook_create('https://hooks.synthetic.example/free', array['task.created'], null, 'whsec_'||repeat('a',43))")
    with api.transaction():
        set_tenant(api, w.org, w.member)
        with pytest.raises(Exception, match="Company admins manage webhooks"):
            api.execute("select pulse.v1_webhook_list()")
