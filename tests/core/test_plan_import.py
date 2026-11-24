"""AC-PLAN-TOOLS (owner, 13 Nov 2026; the AC handoff of 13 Nov, section 3): a whole plan in one call over API v1 and MCP
(apply_plan), read back in one call (get_goal_tree), external keys unique per company, decisions and open questions,
blockers and "waiting on", one digest notice per person, whoami's scopes, briefs on get_task / get_project / get_goal,
folders by path and the workflow log, on real tenant row security (services/api/test/plan-import-runner.mjs).
Synthetic people and words only."""
import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant

ALL = ["tasks.read", "tasks.write", "projects.read", "projects.write", "people.read", "docs.read", "docs.write", "workflows.read", "workflows.write"]


def token(api, org, person, scopes, label):
    t = "ppt_" + secrets.token_urlsafe(32)[:43]
    with api.transaction():
        set_tenant(api, org, person)
        api.execute("select pulse.api_token_issue('personal',%s,%s,30,null,%s)", (label, scopes, hashlib.sha256(t.encode()).hexdigest()))
    return t


def test_new_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c where c.oid in ('pulse.external_key'::regclass,'pulse.plan_item'::regclass,'pulse.plan_item_link'::regclass,'pulse.workflow_log_run'::regclass) order by 1""").fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [
        ("external_key", True, True, True), ("plan_item", True, True, True), ("plan_item_link", True, True, True), ("workflow_log_run", True, True, True)]


def test_keys_are_unique_per_company_and_kind_and_need_edit_rights(api, worker, owner):
    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.manager))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        t = api.execute("select pulse.task_save(null,'{\"title\":\"Synthetic keyed task\"}'::jsonb) id").fetchone()["id"]
        api.execute("insert into pulse.external_key(org_id,kind,key,ref_id,created_by) values(pulse.current_org(),'task','T1.1',%s,pulse.current_viewer())", (t,))
        second = api.execute("select pulse.task_save(null,'{\"title\":\"Synthetic second keyed task\"}'::jsonb) id").fetchone()["id"]
        with pytest.raises(psycopg.errors.UniqueViolation):
            with api.transaction():
                api.execute("insert into pulse.external_key(org_id,kind,key,ref_id,created_by) values(pulse.current_org(),'task','T1.1',%s,pulse.current_viewer())", (second,))
    # The same key in another company is that company's own.
    with api.transaction():
        set_tenant(api, other.org, other.manager)
        assert api.execute("select count(*) n from pulse.external_key").fetchone()["n"] == 0
        assert api.execute("select pulse.external_key_taken('task','T1.1') v").fetchone()["v"] is False
    # A member who may not change the task cannot key it.
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                api.execute("insert into pulse.external_key(org_id,kind,key,ref_id,created_by) values(pulse.current_org(),'task','T1.2',%s,pulse.current_viewer())", (t,))


def test_plan_import_end_to_end(api, worker, owner):
    w = build_world(worker, owner, api)
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.manager))
    with owner.transaction():
        set_tenant(owner, w.org)
        for pid, user, n in ((w.manager, "plan.admin", 9101), (w.editor, "plan.editor", 9102), (w.editor2, "plan.editor2", 9103)):
            owner.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence,user_no,email) values(%s,%s,'Staff',%s,'{}',%s,%s) on conflict (person_id) do update set username=excluded.username,email=excluded.email",
                          (w.org, pid, user, n, f"{user}@{w.domain}"))
    # AI-ACCESS (2536): a person's own key is governed by the company's AI rules, where "delete" (here: taking a blocker
    # off a task) is off until an admin turns it on (Settings → AI access). This company's admin turns it on.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.ai_access_policy_set(%s,null,null,%s::jsonb,null,false)", (w.org, json.dumps({"delete": "on"})))
    admin = token(api, w.org, w.manager, ALL, "Plan admin")
    narrow = token(api, w.org, w.manager, ["tasks.read", "tasks.write", "projects.read", "projects.write", "people.read"], "No docs")
    editor = token(api, w.org, w.editor, ALL, "Editor")
    excluded = token(api, w.org, w.editor2, ALL, "Excluded folder member")
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "admin": admin, "narrow": narrow, "editorToken": editor, "adminId": str(w.manager), "editorId": str(w.editor),
                                 "otherProject": str(other.project), "excludedToken": excluded, "editor2Id": str(w.editor2), "project": str(w.project)})}
    p = subprocess.run(["node", "test/plan-import-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 40, out
    assert admin not in p.stdout + p.stderr, "a token never reaches the logs"
    with owner.transaction():
        set_tenant(owner, w.org)
        # Digest: the editor got ONE notice for the plan's tasks, not one per task (and none from the dry run).
        told = owner.execute("select count(*) n from pulse.notification where org_id=%s and person_id=%s and event_type='task.assigned'", (w.org, w.editor)).fetchone()["n"]
        assert told == out["editorNotices"] == 1, (told, out)
        # One initial digest and two immediate assignments; notify=none adds no notices.
        assert owner.execute("select count(*) n from pulse.notification where org_id=%s and person_id=%s and event_type='task.assigned'", (w.org, w.editor2)).fetchone()["n"] == 3
        # The dry run left nothing: one goal with the plan's key, one doc, no stray rows.
        assert owner.execute("select count(*) n from pulse.external_key where org_id=%s and kind='goal'", (w.org,)).fetchone()["n"] == 1
        assert owner.execute("select count(*) n from pulse.goal where org_id=%s and title like 'Synthetic dry%%'", (w.org,)).fetchone()["n"] == 0
        # Re-running made nothing twice.
        assert owner.execute("select count(*) n from pulse.task where org_id=%s and title='Synthetic step one'", (w.org,)).fetchone()["n"] == 1
        assert owner.execute("select count(*) n from pulse.plan_item where org_id=%s", (w.org,)).fetchone()["n"] == 2
        assert owner.execute("select count(*) n from pulse.workflow_log_run where org_id=%s", (w.org,)).fetchone()["n"] == 1
