"""WORK-SPINE (1990): one project type that every field agrees with, the per-organisation backfill that 1640's could not
do under forced row security, and projects started by AI kept apart until a person keeps them. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from conftest import dsn
from pulse_sdk.db import set_tenant
from test_goals import goal, link
from test_tasks_rt1 import as_, new_task, one


def _lead(owner, w):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership',current_date)", (w.org, w.editor))


def _kinds(owner, w, pid):
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute("""select wp.project_type t,wp.kind k,p.kind pk,wp.started_by s from pulse.work_project wp join pulse.project p on p.id=wp.project_id
          where wp.project_id=%s""", (pid,)).fetchone()


def test_the_type_and_both_kinds_follow_each_other(api, worker, owner):
    w = build_world(worker, owner, api)
    _lead(owner, w)
    pid = one(api, w, w.editor, "select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": "Synthetic Incorporation"}),))["id"]
    assert tuple(_kinds(owner, w, pid).values())[:3] == ("internal", "internal", "internal")
    # Client delivery: all three say client.
    one(api, w, w.editor, "select pulse.work_project_type_set(%s,'client_delivery')", (pid,))
    assert tuple(_kinds(owner, w, pid).values())[:3] == ("client_delivery", "fulfilment", "client_work")
    # Back to internal: all three say internal (1640's trigger forced a fulfilment back to client delivery).
    one(api, w, w.editor, "select pulse.work_project_type_set(%s,'internal')", (pid,))
    assert tuple(_kinds(owner, w, pid).values())[:3] == ("internal", "internal", "internal")
    # A writer that changes only work_project.kind (an import) moves the type with it, and the package row too.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.work_project set kind='fulfilment' where project_id=%s", (pid,))
    assert tuple(_kinds(owner, w, pid).values())[:3] == ("client_delivery", "fulfilment", "client_work")
    # And one that changes only project.kind (the Drive index) does the same.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.project set kind='internal' where id=%s", (pid,))
    assert tuple(_kinds(owner, w, pid).values())[:3] == ("internal", "internal", "internal")


def test_the_backfill_decides_each_project_once_per_organisation(api, worker, owner):
    w = build_world(worker, owner, api)
    client = uuid.uuid4()
    rows = {}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic Skyline Developers')", (client, w.org))
        for key, kind, client_id, root in [("folder", "client_work", None, "index-path:/Synthetic/Shoots/Lakeview"), ("client", "client_work", client, None),
                                           ("bare", "client_work", None, None), ("own", "internal", None, None)]:
            pid = uuid.uuid4(); rows[key] = pid
            owner.execute("""insert into pulse.project(id,org_id,registry_no,name,title,kind,status,client_id,storage_root)
              values(%s,%s,(select coalesce(max(registry_no),0)+1 from pulse.project where org_id=%s),%s,%s,%s,'active',%s,%s)""",
                          (pid, w.org, w.org, f"Synthetic {key}", f"Synthetic {key}", kind, client_id, root))
        # The state production was left in: every project 'internal' by default (1640's update matched no row).
        owner.execute("alter table pulse.work_project disable trigger work_project_type_follow")
        owner.execute("alter table pulse.work_project disable trigger work_project_kind_to_project")
        owner.execute("update pulse.work_project set project_type='internal' where org_id=%s", (w.org,))
        owner.execute("alter table pulse.work_project enable trigger work_project_type_follow")
        owner.execute("alter table pulse.work_project enable trigger work_project_kind_to_project")
    assert _kinds(owner, w, rows["folder"])["t"] == "internal" and _kinds(owner, w, rows["folder"])["k"] == "fulfilment"
    with owner.transaction():
        owner.execute("select set_config('pulse.org_id','',true)")
        done = owner.execute("select pulse.work_project_type_backfill(%s) r", ([w.org],)).fetchone()["r"]
    assert done["typed"] >= 3
    # A client folder and a project with a client are client delivery; a "fulfilment" with no client, no folder and
    # nothing it delivers is the company's own work; an internal one stays internal. All three fields agree.
    assert tuple(_kinds(owner, w, rows["folder"]).values())[:3] == ("client_delivery", "fulfilment", "client_work")
    assert tuple(_kinds(owner, w, rows["client"]).values())[:3] == ("client_delivery", "fulfilment", "client_work")
    assert tuple(_kinds(owner, w, rows["bare"]).values())[:3] == ("internal", "internal", "internal")
    assert tuple(_kinds(owner, w, rows["own"]).values())[:3] == ("internal", "internal", "internal")
    # Run again: nothing left to change.
    with owner.transaction():
        again = owner.execute("select pulse.work_project_type_backfill(%s) r", ([w.org],)).fetchone()["r"]
    assert again == {"typed": 0, "kinds": 0, "packages": 0, "ai": 0}


def test_projects_started_by_ai_are_kept_apart_until_a_person_keeps_them(api, worker, owner):
    w = build_world(worker, owner, api)
    _lead(owner, w)
    mine = one(api, w, w.editor, "select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": "Synthetic Office Move"}),))["id"]
    assert _kinds(owner, w, mine)["s"] == "person"
    # An approved automation (actor "<lane> · approver: …") or an AI employee ("agent:…") starts one: it is marked.
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select set_config('pulse.actor_account','synthetic-import · approver: Synthetic Owner',true)")
        auto = api.execute("select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": "Synthetic Drive storage"}),)).fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select set_config('pulse.actor_account','agent:synthetic-bot',true)")
        bot = api.execute("select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": "Synthetic sending domain"}),)).fetchone()["id"]
    assert _kinds(owner, w, auto)["s"] == "ai" and _kinds(owner, w, bot)["s"] == "ai"
    # A person keeps one; it moves to the main list, and the change is in its history.
    assert one(api, w, w.editor, "select pulse.work_project_started_set(%s,'person') r", (auto,))["r"]["startedBy"] == "person"
    assert _kinds(owner, w, auto)["s"] == "person"
    hist = as_(api, w, w.editor, "select old_value,new_value from pulse.record_change where entity_id=%s and field='started_by'", (auto,))
    assert [(h["old_value"], h["new_value"]) for h in hist] == [("ai", "person")]
    # Only who may manage the project moves it; and only person or ai.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.work_project_started_set(%s,'person')", (bot,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.work_project_started_set(%s,'ramis')", (bot,))


def test_a_change_to_the_work_tells_the_open_pages_with_ids_only(api, worker, owner):
    """Round 2 (2070, owner 10 Nov 2026: "open screens update within ~1-2 s with no reload"): a task, the person it moves
    from and to, a checklist step, a project and a goal each NOTIFY pulse_work "<org>:<t|p|g>:<project or goal>:<person>:
    <task>" when the change commits (and nothing before), with no title or other words."""
    w = build_world(worker, owner, api)
    _lead(owner, w)
    with psycopg.connect(dsn("api"), autocommit=True) as ear:
        ear.execute("listen pulse_work")

        def heard():
            return [n.payload for n in ear.notifies(timeout=1.5)]

        pid = one(api, w, w.editor, "select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": "Synthetic live"}),))["id"]
        assert f"{w.org}:p:{pid}::" in heard()
        tid = new_task(api, w, w.editor, title="Synthetic secret title", projectId=str(pid), assigneeId=str(w.editor))
        notes = heard()
        assert f"{w.org}:t:{pid}:{w.editor}:{tid}" in notes
        assert not any("Synthetic" in n for n in notes), "a note carries ids, never words"
        # Handed to someone else: both people's pages hear it.
        one(api, w, w.editor, "select pulse.task_save(%s,%s) id", (tid, Jsonb({"assigneeId": str(w.editor2)})))
        notes = heard()
        assert f"{w.org}:t:{pid}:{w.editor}:{tid}" in notes and f"{w.org}:t:{pid}:{w.editor2}:{tid}" in notes
        # A checklist step (task_check) names its task's project and the task.
        one(api, w, w.editor, "select pulse.task_check_set(%s,'s1','Book the name',true) r", (tid,))
        assert any(n.startswith(f"{w.org}:t:{pid}:") and n.endswith(f":{tid}") for n in heard())
        # A goal and its link to the project.
        g = goal(api, w, w.editor, "company", "Synthetic live goal")
        link(api, w, w.editor, g, project=pid)
        assert f"{w.org}:g:{g}::" in heard()
        # Nothing is told before the change commits.
        with api.transaction():
            as_(api, w, w.editor, "select pulse.task_save(%s,%s) id", (tid, Jsonb({"title": "Synthetic renamed"})))
            assert heard() == []
        assert f"{w.org}:t:{pid}:{w.editor2}:{tid}" in heard()
