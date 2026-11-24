"""AI-ACCESS (owner, 23 Nov 2026: "When Claude is connected to Kazuk's account it should get every company his account can
access. Everyone who connects their Claude gets exactly what they are permitted to do. From one account I should manage
all of that."), migration 2536 and services/api/src/v1-ai-access.ts, on synthetic companies only (nothing is sent).

Three companies A, B, C. "Kazuk" has one account with staff seats in A and B and connects an AI app once (in A).
"Member" has an account with a seat in A only. "Owner" is an admin of A and of B and an ordinary member of C.
- many companies over MCP: list_my_organisations shows A and B; org (handle or id) moves a call into B as Kazuk's seat
  there; the last one named stays the default; use_organisation switches back;
- isolation: C (where Kazuk has no seat), by handle or by id, is refused in words and nothing falls back; Member cannot
  reach B even with B's id;
- a policy denial (Member's own rule in A: work off) and the default "delete is off";
- the approval queue: A's rule "work: ask first" holds Kazuk's create_task, keeps the request, the approver says yes, the
  same call then goes through once, and the next one asks again;
- the owner console: the Owner sees A and B (where he is an admin) and never C; Kazuk and Member manage nothing but see
  their own connection; a non-admin cannot set rules or decide;
- the audit: every call names the connection and the company it acted in, with the rule that held or refused it;
- revoke marks the connection revoked (from A, where it was made; B's admin cannot end it, only turn AI off there)."""
import hashlib
import json
import os
import secrets
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_account_code import make_account, owner_do
from test_agent_ui_browser import install_org

ROOT = Path(__file__).resolve().parents[2]


def member(owner, account, org, person):
    owner_do(owner, "insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff')", (account, org, person))


def admin_role(owner, org, person):
    owner_do(owner, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01') on conflict do nothing", (org, person), org)


def connect(owner, org, person, app="Claude"):
    """What Allow + the token exchange leave (oauth.ts): an app, a connection with every area, a one-hour access token."""
    client = "pcl_" + secrets.token_hex(12)
    token = "pat_" + secrets.token_urlsafe(32)[:43]
    assert len(token) == 47
    sha = hashlib.sha256(token.encode()).hexdigest()
    grant = uuid.uuid4()
    owner_do(owner, "insert into pulse_priv.oauth_client(org_id,client_id,name,redirect_uris) values(%s,%s,%s,array['https://claude.example/cb'])", (org, client, app), org)
    owner_do(owner, "insert into pulse_priv.oauth_grant(org_id,id,client_id,person_id,scopes) values(%s,%s,%s,%s,pulse.v1_scopes())", (org, grant, client, person), org)
    owner_do(owner, "insert into pulse_priv.oauth_token(org_id,grant_id,kind,token_sha256,expires_at) values(%s,%s,'access',%s,now()+interval '1 hour')", (org, grant, sha), org)
    return token, str(grant)


def as_person(api, org, person, sql, args=()):
    with api.transaction():
        set_tenant(api, org, person)
        return api.execute("select " + sql + " v", args).fetchone()["v"]


def refused(api, org, person, sql, args=()):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_person(api, org, person, sql, args)


@pytest.fixture
def aia(worker, owner, api):
    a, b, c = (build_world(worker, owner, api) for _ in range(3))
    tag = secrets.token_hex(3)
    for w, h in ((a, "aiaa" + tag), (b, "aiab" + tag), (c, "aiac" + tag)):
        owner_do(owner, "update pulse.org set handle=%s where id=%s", (h, w.org), w.org)
        w.handle = h
    _, kazuk = make_account(owner, a.org, a.editor)
    member(owner, kazuk, b.org, b.editor)
    _, mem = make_account(owner, a.org, a.editor2)
    _, boss = make_account(owner, a.org, a.manager, password='Synthetic-own-2026!')  # no "one password" prompt over the walk
    member(owner, boss, b.org, b.manager)
    member(owner, boss, c.org, c.lead)
    admin_role(owner, a.org, a.manager)
    admin_role(owner, b.org, b.manager)
    # The Owner's sign-in for the browser walk (an Access identity on A's address).
    a.boss_email = f"boss@{a.domain}"
    owner_do(owner, "insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace (synthetic)')", (a.org, a.boss_email, a.manager), a.org)
    return a, b, c


def runner(phase, cfg, tmp_path):
    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)
    report = tmp_path / f"ai-access-{phase}.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "AIA": json.dumps(cfg), "AIA_PHASE": phase, "AIA_REPORT": str(report), "AIA_SHOTS": os.environ.get("AIA_SHOTS", str(tmp_path / "shots"))}
    # The browser walk starts next dev and compiles Settings once: slow on a busy runner.
    result = subprocess.run(["node", "test/ai-access-runner.mjs"], cwd=ROOT / "services/api", env=env, capture_output=True, text=True,
                            timeout=1500 if phase == "shots" else 600)
    if result.returncode and phase == "shots":  # the walk's whole output beside its screenshots, for whoever looks next
        Path(env["AIA_SHOTS"]).mkdir(parents=True, exist_ok=True)
        (Path(env["AIA_SHOTS"]) / "runner-shots.log").write_text(result.stderr + result.stdout)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6000:]
    return json.loads(report.read_text())


def test_one_connection_many_companies_rules_and_console(api, worker, owner, aia, tmp_path):
    a, b, c = aia
    k_token, k_grant = connect(owner, a.org, a.editor, "Claude")
    m_token, m_grant = connect(owner, a.org, a.editor2, "ChatGPT")
    # A's rules: everyone "ask first" for work, the Owner (A's admin seat) says yes; Member's own rule: work never.
    with api.transaction():
        set_tenant(api, a.org, a.manager)
        api.execute("select pulse.ai_access_policy_set(%s,null,null,%s,%s,false)", (a.org, Jsonb({"work": "ask"}), a.manager))
        api.execute("select pulse.ai_access_policy_set(%s,null,%s,%s,null,false)", (a.org, a.editor2, Jsonb({"work": "off"})))
    # A non-admin sets no rules and the Owner cannot set C's (he is no admin there).
    refused(api, a.org, a.editor, "pulse.ai_access_policy_set(%s,null,null,%s,null,false)", (a.org, Jsonb({"read": "off"})))
    refused(api, c.org, c.lead, "pulse.ai_access_policy_set(%s,null,null,%s,null,false)", (c.org, Jsonb({"read": "off"})))
    eff = as_person(api, a.org, a.editor, "pulse.ai_access_effective(%s)", (a.editor,))
    assert eff["work"] == "ask" and eff["delete"] == "off" and eff["read"] == "on" and eff["approverId"] == str(a.manager)
    assert as_person(api, a.org, a.editor2, "pulse.ai_access_effective(%s)", (a.editor2,))["work"] == "off"

    cfg = {"kazuk": k_token, "member": m_token,
           "a": {"id": str(a.org), "handle": a.handle, "person": str(a.editor)}, "b": {"id": str(b.org), "handle": b.handle, "person": str(b.editor)},
           "c": {"id": str(c.org), "handle": c.handle}, "bossEmail": a.boss_email}
    was = install_org(owner, a.org)
    try:
        one = runner("one", cfg, tmp_path)
        assert one["checks"] >= 20
        # The held create_task is kept for A's approver; Member cannot decide it, the Owner can (from C, through his A seat).
        req = owner_do(owner, "select id,state,tool,tool_group,approver_person_id from pulse.ai_access_request where org_id=%s", (a.org,), a.org)
        assert len(req) == 1 and req[0]["state"] == "waiting" and req[0]["tool"] == "create_task" and req[0]["tool_group"] == "work"
        assert req[0]["approver_person_id"] == a.manager
        refused(api, a.org, a.editor2, "pulse.ai_access_decide(%s,%s,true,null)", (a.org, req[0]["id"]))
        assert as_person(api, c.org, c.lead, "pulse.ai_access_decide(%s,%s,true,%s)", (a.org, req[0]["id"], "ok (synthetic)"))["state"] == "approved"
        two = runner("two", cfg, tmp_path)
        assert two["checks"] >= 3
        if os.environ.get("PULSE_AUTH_BROWSER") == "1":
            os.environ.setdefault("AIA_SHOTS", str(tmp_path / "shots"))
            assert runner("shots", cfg, tmp_path)["checks"] >= 24

        # The owner console: A and B (admin seats), never C, from any of his seats; Kazuk and Member manage nothing.
        for org, seat in ((a.org, a.manager), (c.org, c.lead)):
            con = as_person(api, org, seat, "pulse.ai_access_console()")
            assert sorted(x["id"] for x in con["companies"]) == sorted([str(a.org), str(b.org)])
        con = as_person(api, b.org, b.manager, "pulse.ai_access_console()")
        co = {x["id"]: x for x in con["companies"]}
        ka = next(x for x in co[str(a.org)]["connections"] if x["id"] == k_grant)
        kb = next(x for x in co[str(b.org)]["connections"] if x["id"] == k_grant)
        assert ka["homeHere"] and ka["canRevoke"] and not kb["homeHere"] and not kb["canRevoke"]
        assert kb["homeName"], "the Owner also runs A, so B's view names where it was made"
        assert kb["activity"]["calls7d"] >= 2, "what it did in B"
        assert any(r["state"] == "used" for r in co[str(a.org)]["requests"])
        assert not any(x["id"] == m_grant for x in co[str(b.org)]["connections"]), "Member has no seat in B"
        for org, seat, grant in ((a.org, a.editor, k_grant), (b.org, b.editor, k_grant), (a.org, a.editor2, m_grant)):
            mine = as_person(api, org, seat, "pulse.ai_access_console()")
            assert mine["companies"] == [] and [x["id"] for x in mine["mine"]] == [grant]
        assert len(as_person(api, b.org, b.editor, "pulse.ai_access_console()")["myOrgs"]) == 2

        # The audit: each call names the connection, the company it acted in and the rule that held or refused it.
        # pulse_priv.v1_call is per company (row security), so each company's receipts are read inside it.
        def receipts(grant):
            return [r for w in (a, b, c) for r in owner_do(owner, "select org_id, operation_id, status, ai_rule from pulse_priv.v1_call where grant_id=%s", (grant,), w.org)]
        calls = receipts(k_grant)
        assert {r["org_id"] for r in calls} >= {a.org, b.org}
        assert any(r["ai_rule"] == "ask" and r["status"] == 403 for r in calls)
        assert any(r["ai_rule"] == "approved" and r["status"] == 200 for r in calls)
        assert any(r["ai_rule"] == "off" and r["org_id"] == b.org for r in calls), "delete_project: delete is off by default"
        assert not [r for r in calls if r["org_id"] == c.org], "never acted in C"
        m_calls = receipts(m_grant)
        assert {r["org_id"] for r in m_calls if r["org_id"]} <= {a.org} and any(r["ai_rule"] == "off" for r in m_calls)

        # Revoke: B's admin view cannot end a connection made in A (only turn AI off there); from A it is marked revoked.
        assert as_person(api, b.org, b.manager, "pulse.ai_access_revoke(%s,%s)", (b.org, k_grant)) is False
        refused(api, a.org, a.editor2, "pulse.ai_access_revoke(%s,%s)", (a.org, k_grant))
        assert as_person(api, b.org, b.manager, "pulse.ai_access_revoke(%s,%s)", (a.org, k_grant)) is True
        row = owner_do(owner, "select revoked_at, revoked_reason from pulse_priv.oauth_grant where id=%s", (k_grant,), a.org)[0]
        assert row["revoked_at"] and row["revoked_reason"] == "admin_revoked"
        assert owner_do(owner, "select count(*) n from pulse_priv.oauth_grant where id=%s", (k_grant,), a.org)[0]["n"] == 1, "never deleted"
        three = runner("three", cfg, tmp_path)
        assert three["checks"] >= 1
    finally:
        if was:
            install_org(owner, was)
