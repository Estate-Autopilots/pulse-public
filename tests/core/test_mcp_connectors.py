"""CONNECTORS-CONTRACTS (1584): a company's connected apps (remote MCP servers). Admins add and change them, every change
lands on the admins' ledger, secrets stay sealed in pulse_priv behind one function, who may use a connector (people by
role, AI employees by name) is decided here, and every tool call is recorded. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world

SEALED = {"k": "synthetic-key", "w": "d3JhcHBlZA==", "d": "c2VhbGVk"}


def as_(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute(sql, args).fetchall()


def one(api, w, who, sql, args=()):
    rows = as_(api, w, who, sql, args)
    return rows[0] if rows else None


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')", (w.org, w.lead))
        w.agent, w.agent2 = uuid.uuid4(), uuid.uuid4()
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic AI helper','agent'),(%s,%s,'Synthetic AI other','agent')", (w.agent, w.org, w.agent2, w.org))
    return w


def add(api, w, who, url="https://mcp.example.com/mcp", auth="bearer"):
    return one(api, w, who, "insert into pulse.mcp_connector(org_id,label,url,auth_kind,created_by) values(pulse.current_org(),'Synthetic app',%s,%s,pulse.current_viewer()) returning id",
               (url, auth))["id"]


TOOLS = [{"name": "list_things", "title": "List things", "description": "", "inputSchema": {"type": "object"}, "readOnly": True, "destructive": False},
         {"name": "add_thing", "title": "Add a thing", "description": "", "inputSchema": {"type": "object"}, "readOnly": False, "destructive": False}]


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select n.nspname||'.'||c.relname t,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where (n.nspname,c.relname) in (('pulse','mcp_connector'),('pulse','mcp_connector_event'),('pulse','mcp_tool_call'),
        ('pulse_priv','mcp_connector_secret'),('pulse_priv','mcp_connector_attempt')) order by 1""").fetchall()
    assert len(rows) == 5 and all(r["relrowsecurity"] and r["relforcerowsecurity"] and r["tenant"] for r in rows)


def test_only_admins_connect_and_every_change_is_on_their_ledger(api, world):
    w = world
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        add(api, w, w.lead)
    with pytest.raises(psycopg.errors.CheckViolation):
        add(api, w, w.manager, url="http://mcp.example.com/mcp")
    cid = add(api, w, w.manager)
    as_(api, w, w.manager, "update pulse.mcp_connector set tools=%s,status='connected',enabled_tools='{list_things,add_thing}' where id=%s returning id", (Jsonb(TOOLS), cid))
    as_(api, w, w.manager, "update pulse.mcp_connector set people_access='staff' where id=%s returning id", (cid,))
    # Leadership cannot change it; the ledger is the admins' alone and names who did what.
    assert as_(api, w, w.lead, "update pulse.mcp_connector set people_access='admins' where id=%s returning id", (cid,)) == []
    events = [r["action"] for r in as_(api, w, w.manager, "select action from pulse.mcp_connector_event where connector_id=%s order by at,action", (cid,))]
    assert events[0] == "added" and "tools" in events and "access" in events
    assert as_(api, w, w.editor, "select id from pulse.mcp_connector_event where connector_id=%s", (cid,)) == []
    assert one(api, w, w.manager, "select actor_name from pulse.mcp_connector_event where connector_id=%s and action='access'", (cid,))["actor_name"] == "Pod Manager"


def test_secrets_stay_behind_one_function(api, world):
    w = world
    cid = add(api, w, w.manager)
    as_(api, w, w.manager, "select pulse.mcp_connector_secret('bearer',%s,%s)", (cid, Jsonb({"bearer": SEALED})))
    # pulse_api never reads the table; the function opens it to admins, and to whoever may use a connected connector.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "select * from pulse_priv.mcp_connector_secret")
    assert one(api, w, w.manager, "select pulse.mcp_connector_secret('read',%s) s", (cid,))["s"]["bearer"] == SEALED
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.mcp_connector_secret('read',%s)", (cid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.mcp_connector_secret('bearer',%s,%s)", (cid, Jsonb({"bearer": SEALED})))
    assert one(api, w, w.manager, "select count(*)::int n from pulse.mcp_connector_event where connector_id=%s and action='secret'", (cid,))["n"] == 1
    # A sign-in attempt is used once, by the admin who started it.
    state = "a" * 64
    as_(api, w, w.manager, "select pulse.mcp_connector_secret('begin',%s,%s)", (cid, Jsonb({"stateHash": state, "verifier": "v" * 43, "redirectUri": "https://x.example/cb"})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.mcp_connector_take(%s)", (state,))
    assert one(api, w, w.manager, "select pulse.mcp_connector_take(%s) a", (state,))["a"]["connectorId"] == str(cid)
    assert one(api, w, w.manager, "select pulse.mcp_connector_take(%s) a", (state,))["a"] is None


def test_who_may_use_it_and_every_call_is_recorded(api, world):
    w = world
    cid = add(api, w, w.manager)
    as_(api, w, w.manager, "update pulse.mcp_connector set tools=%s,status='connected',enabled_tools='{list_things}' where id=%s returning id", (Jsonb(TOOLS), cid))
    can = lambda who: one(api, w, who, "select pulse.mcp_can_use(%s) ok", (cid,))["ok"]  # noqa: E731
    assert (can(w.manager), can(w.lead), can(w.editor), can(w.agent)) == (True, False, False, False)
    as_(api, w, w.manager, "update pulse.mcp_connector set people_access='leadership',ai_access='chosen',ai_agents=%s where id=%s returning id", ([w.agent], cid))
    assert (can(w.lead), can(w.editor), can(w.agent), can(w.agent2)) == (True, False, True, False)
    # Someone who may not use it does not even see it.
    assert as_(api, w, w.editor, "select id from pulse.mcp_connector where id=%s", (cid,)) == []
    assert one(api, w, w.agent, "select label from pulse.mcp_connector where id=%s", (cid,))["label"] == "Synthetic app"
    call = one(api, w, w.agent, "select pulse.mcp_tool_call_log(%s,'list_things','api',false,false,'ok',42,null) id", (cid,))["id"]
    one(api, w, w.lead, "select pulse.mcp_tool_call_log(%s,'add_thing','screen',true,false,'needs_confirm',null,null) id", (cid,))
    rows = as_(api, w, w.manager, "select id,actor_kind,writes,outcome from pulse.mcp_tool_call where connector_id=%s order by at", (cid,))
    assert [(r["actor_kind"], r["writes"], r["outcome"]) for r in rows] == [("ai", False, "ok"), ("person", True, "needs_confirm")]
    # A person reads their own calls only; nobody writes the record directly.
    assert [r["id"] for r in as_(api, w, w.agent, "select id from pulse.mcp_tool_call")] == [call]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "insert into pulse.mcp_tool_call(org_id,connector_id,tool,actor_kind,via,writes,outcome) values(pulse.current_org(),%s,'x','person','api',false,'ok')", (cid,))
    # Auto-run tools must be switched on; removed connectors stop working.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.manager, "update pulse.mcp_connector set auto_tools='{add_thing}' where id=%s returning id", (cid,))
    as_(api, w, w.manager, "update pulse.mcp_connector set status='removed' where id=%s returning id", (cid,))
    assert can(w.agent) is False
