"""PEOPLE-LIVE: work evidence links, automatic and reviewed decisions with receipts and undo, and who sees them.
Synthetic tenants, people, tasks and roster rows only; the EA index is a stand-in that returns nothing."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_gdrive_snapshot.people_work import refresh_people_work
from pulse_sdk.db import set_tenant
from test_hr_suite import _staff


class Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchall(self):
        return self.rows


class Index:
    """The read-only EA index, empty: no Workspace directory, Drive files or mail."""

    def execute(self, sql, _params=()):
        assert not sql.lstrip().lower().startswith(("insert", "update", "delete"))
        return Rows()


def as_(conn, w, who, sql, args=()):
    with conn.transaction():
        set_tenant(conn, w.org, who)
        return conn.execute(sql, args).fetchall()


def one(conn, w, who, sql, args=()):
    rows = as_(conn, w, who, sql, args)
    return rows[0] if rows else None


def task(worker, w, title, label, owner=None, project=True):
    tid = uuid.uuid4()
    worker.execute("insert into pulse.task(id,org_id,title,project_id,status,source,source_key,owner_label,owner_id,assignee_person_id,source_period) "
                   "values(%s,%s,%s,%s,'done','imported',%s,%s,%s,%s,'VOV Mar 2026')",
                   (tid, w.org, title, w.project if project else None, f"synthetic:{tid}", label, owner, owner))
    return tid


@pytest.fixture
def team(worker, owner, api, tmp_path):
    """Editor One (pod1@), Editor Two (creative@ only), Project Lead (HR; pod set by hand), Meera (one-word roster name)."""
    w = build_world(worker, owner, api)
    _staff(worker, w)
    w.meera = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.unit(org_id,kind,name) values(%s,'pod','Shared'),(%s,'pod','Pod 2')", (w.org, w.org))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Meera','staff')", (w.meera, w.org))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'Graphic Designer','test',20,'meera20')", (w.org, w.meera))
        worker.execute("update pulse.people_profile set pod='Pod 1',locked='{pod}' where person_id=%s", (w.lead,))
        w.t_alias = task(worker, w, "VOV — Pilot project", "Edtor One")           # a configured full-name alias: exact
        w.t_word = task(worker, w, "Creative — Pilot project", "meera")           # one word: a suggestion
        w.t_private = task(worker, w, "Salary for editors", "Editor One")         # never listed
        w.t_owned = task(worker, w, "Model Video — Pilot project", "Editor Two", owner=w.editor2)
    roster = tmp_path / "groups.csv"
    roster.write_text("group,role,name,email\npod1@x,member,Editor One,\ncreative@x,member,Editor Two (Video Editor),\npod2@x,member,Project Lead,\n")
    w.roster, w.config = roster, {"name_aliases": {"Editor One": ["Edtor One"]}}
    return w


def run(worker, w):
    return refresh_people_work(Index(), worker, w.org, sheets=False, config=w.config, groups_path=str(w.roster))


def link(worker, w, **where):
    keys = " and ".join(f"{k}=%s" for k in where)
    return one(worker, w, None, f"select * from pulse.people_work_link where {keys} order by created_at limit 1", tuple(where.values()))


def test_deterministic_matches_are_accepted_with_receipts_and_nothing_is_notified(worker, api, team):
    w = team
    first = run(worker, w)
    assert first["auto_accepted_now"] >= 4 and first["retired"] == 0
    pods = {r["person_id"]: r["pod"] for r in as_(worker, w, None, "select person_id,pod from pulse.people_profile where person_id=any(%s)", ([w.editor, w.editor2, w.lead],))}
    assert pods == {w.editor: "Pod 1", w.editor2: "Shared", w.lead: "Pod 1"}                     # the hand-set pod is kept
    lead = link(worker, w, person_id=w.lead, kind="pod")
    assert lead["status"] == "suggested" and lead["group_key"] == "pod:groups_vs_record" and lead["pod"] == "Pod 2"
    receipt = one(worker, w, None, "select r.* from pulse.people_work_receipt r join pulse.people_work_link l on l.id=r.link_id where l.person_id=%s and l.kind='pod'", (w.editor,))
    assert receipt["action"] == "auto_accept" and receipt["before_state"]["pod"] is None and receipt["after_state"] == {"status": "accepted", "pod": "Pod 1"}
    assert one(worker, w, None, "select count(*) n from pulse.record_change where entity_id=%s and field='pod' and new_value='Pod 1'", (w.editor,))["n"] == 1
    # An exact alias on a task row: the task gets its owner, the project link follows, the task history says why.
    t = one(worker, w, None, "select owner_id,assignee_person_id,locked from pulse.task where id=%s", (w.t_alias,))
    assert t["owner_id"] == w.editor == t["assignee_person_id"] and "owner_id" not in t["locked"]
    assert link(worker, w, task_id=w.t_alias)["auto_accepted"] is True
    assert link(worker, w, person_id=w.editor, kind="project", project_id=w.project)["status"] == "accepted"
    assert one(worker, w, None, "select kind,actor_id from pulse.task_event where task_id=%s", (w.t_alias,)) == {"kind": "assigned", "actor_id": None}
    assert link(worker, w, person_id=w.editor2, kind="project", project_id=w.project)["auto_accepted"] is True   # from the task they own
    # One word stays a suggestion; a private title is never listed; nobody was notified about old work.
    word = link(worker, w, task_id=w.t_word)
    assert word["status"] == "suggested" and float(word["confidence"]) == .9 and word["person_id"] == w.meera
    assert one(worker, w, None, "select owner_id from pulse.task where id=%s", (w.t_word,))["owner_id"] is None
    assert link(worker, w, task_id=w.t_private) is None
    assert one(worker, w, None, "select count(*) n from pulse.notification where person_id=any(%s)", ([w.editor, w.editor2, w.meera],))["n"] == 0
    assert one(worker, w, None, "select count(*) n from pulse.audit_event where resource='people_work_link' and action='auto_accept'")["n"] == first["auto_accepted_now"]
    # Running again changes nothing.
    second = run(worker, w)
    assert second["auto_accepted_now"] == 0 and second["retired"] == 0 and second["totals"] == first["totals"]


def test_review_decisions_undo_and_survive_the_next_import(worker, api, team):
    w = team
    run(worker, w)
    word = link(worker, w, task_id=w.t_word)
    # Only HR, admins and leadership decide.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.people_work_decide(%s::uuid[],'accept')", ([word["id"]],))
    done = one(api, w, w.lead, "select pulse.people_work_decide_group(%s,null,'accept') r", (word["group_key"],))["r"]
    assert done["count"] == 2 and done["skipped"] == 0                                     # the task and its project link
    t = one(worker, w, None, "select owner_id,locked from pulse.task where id=%s", (w.t_word,))
    assert t["owner_id"] == w.meera and "owner_id" in t["locked"]
    assert one(worker, w, None, "select count(*) n from pulse.notification where person_id=%s", (w.meera,))["n"] == 0
    with pytest.raises(psycopg.errors.SerializationFailure):
        as_(api, w, w.lead, "select pulse.people_work_decide_group(%s,null,'accept')", (word["group_key"],))
    # Undo restores the task as it was, from the receipt; the next import never re-accepts an undone link.
    as_(api, w, w.manager, "select pulse.people_work_decide(%s::uuid[],'undo')", ([word["id"]],))
    assert one(worker, w, None, "select owner_id,locked from pulse.task where id=%s", (w.t_word,)) == {"owner_id": None, "locked": []}
    pod = link(worker, w, person_id=w.editor2, kind="pod")
    as_(api, w, w.manager, "select pulse.people_work_decide(%s::uuid[],'undo')", ([pod["id"]],))
    assert one(worker, w, None, "select pod from pulse.people_profile where person_id=%s", (w.editor2,))["pod"] is None
    run(worker, w)
    assert link(worker, w, task_id=w.t_word)["status"] == "undone" and link(worker, w, person_id=w.editor2, kind="pod")["status"] == "undone"
    assert one(worker, w, None, "select pod from pulse.people_profile where person_id=%s", (w.editor2,))["pod"] is None
    actions = [r["action"] for r in as_(worker, w, None, "select action from pulse.people_work_receipt where link_id=%s order by at", (pod["id"],))]
    assert actions == ["auto_accept", "undo"]
    # A dismissal can be undone back to a suggestion; a suggestion no source supports any more retires.
    lead = link(worker, w, person_id=w.lead, kind="pod")
    as_(api, w, w.lead, "select pulse.people_work_decide(%s::uuid[],'dismiss')", ([lead["id"]],))
    as_(api, w, w.lead, "select pulse.people_work_decide(%s::uuid[],'undo')", ([lead["id"]],))
    assert link(worker, w, id=lead["id"])["status"] == "suggested"
    w.roster.write_text("group,role,name,email\npod1@x,member,Editor One,\n")
    assert run(worker, w)["retired"] >= 1 and link(worker, w, id=lead["id"])["retired_at"] is not None


def test_work_links_are_visible_to_the_person_their_managers_hr_and_leadership_only(worker, api, team):
    w = team
    run(worker, w)
    mine = as_(api, w, w.editor, "select distinct person_id from pulse.people_work_link")
    assert {r["person_id"] for r in mine} == {w.editor}
    assert as_(api, w, w.editor2, "select 1 from pulse.people_work_link where person_id=%s", (w.editor,)) == []
    everyone = {r["person_id"] for r in as_(api, w, w.lead, "select distinct person_id from pulse.people_work_link")}
    assert {w.editor, w.editor2, w.meera, w.lead} <= everyone
    assert {r["person_id"] for r in as_(api, w, w.manager, "select distinct person_id from pulse.people_work_link")} == everyone
    assert as_(api, w, w.editor2, "select 1 from pulse.people_work_receipt r join pulse.people_work_link l on l.id=r.link_id where l.person_id=%s", (w.editor,)) == []


SCRIPT = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool,pool);
const call = async(url,email,payload) => {
 const r=await app.inject({url,method:payload?'POST':'GET',headers:{'cf-access-authenticated-user-email':email},...(payload?{payload}:{})});
 return {status:r.statusCode,body:r.json()};
};
const hr='hr@estateautopilots.com', admin='admin@estateautopilots.com', me=process.env.TEST_MEMBER, other=process.env.TEST_OTHER;
const out={};
out.self=await call(`/api/v0/people/${process.env.TEST_MEMBER_ID}/work`,me);
out.other=await call(`/api/v0/people/${process.env.TEST_MEMBER_ID}/work`,other);
out.hr=await call(`/api/v0/people/${process.env.TEST_MEERA_ID}/work`,hr);
out.groups=await call('/api/v0/review-data/groups?kind=people_work',hr);
out.groupsMember=await call('/api/v0/review-data/groups?kind=people_work',me);
const group=out.groups.body.work?.find(g=>g.label.includes('meera'));
out.decideMember=await call('/api/v0/people/work/group',me,{group:group?.key??'none',action:'accept'});
out.decide=await call('/api/v0/people/work/group',hr,{group:group?.key??'none',action:'accept'});
out.after=await call(`/api/v0/people/${process.env.TEST_MEERA_ID}/work`,admin);
console.log('RESULT:'+JSON.stringify(out)); await app.close(); await pool.end();
'''


def test_person_work_and_group_review_through_the_api(worker, owner, api, team):
    w = team
    run(worker, w)
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_MEMBER": w.editor_handle, "TEST_MEMBER_ID": str(w.editor),
           "TEST_OTHER": f"editor2@{w.domain}", "TEST_MEERA_ID": str(w.meera)}
    p = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-2000:]
    r = json.loads(next(line[7:] for line in p.stdout.splitlines() if line.startswith("RESULT:")))
    assert {k: v["status"] for k, v in r.items()} == {"self": 200, "other": 200, "hr": 200, "groups": 200, "groupsMember": 403,
                                                      "decideMember": 403, "decide": 200, "after": 200}
    me = r["self"]["body"]
    assert me["can"] == {"view": True, "review": False} and [t["title"] for t in me["tasks"]] == ["VOV — Pilot project"]
    assert me["tasks"][0]["link"]["status"] == "accepted" and me["tasks"][0]["link"]["auto"] is True and me["tasks"][0]["link"]["receiptId"]
    assert me["projects"][0]["title"] and me["projects"][0]["accepted"] is True and "Pod" not in json.dumps(me.get("missing", {}))
    assert "Salary" not in json.dumps(me)                                                         # private titles never reach Work
    assert r["other"]["body"]["can"]["view"] is False and "tasks" not in r["other"]["body"]
    meera = r["hr"]["body"]
    assert meera["can"]["review"] is True and meera["tasks"][0]["link"]["status"] == "suggested"
    assert set(meera["missing"]) >= {"deliveries", "documents"} and "Fix:" in meera["missing"]["documents"]
    assert r["decide"]["body"]["count"] == 2 and r["after"]["body"]["tasks"][0]["link"]["status"] == "accepted"


def test_an_automatic_owner_whose_row_stops_naming_them_exactly_goes_back_to_review(worker, api, team):
    w = team
    run(worker, w)
    alias = link(worker, w, task_id=w.t_alias)
    assert alias["status"] == "accepted" and alias["auto_accepted"]
    # A person's own decision is never revisited: HR accepts the one-word "meera" row.
    word = link(worker, w, task_id=w.t_word)
    as_(api, w, w.lead, "select pulse.people_work_decide(%s::uuid[],'accept')", ([word["id"]],))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task set owner_label='Editor' where id=%s", (w.t_alias,))     # now only a first name
    result = run(worker, w)
    assert result["auto_reverted_now"] >= 2                                                    # the task and its project link
    back = link(worker, w, id=alias["id"])
    assert back["status"] == "suggested" and not back["auto_accepted"] and back["decided_at"] is None
    assert one(worker, w, None, "select owner_id from pulse.task where id=%s", (w.t_alias,))["owner_id"] is None
    receipts = as_(worker, w, None, "select action,after_state from pulse.people_work_receipt where link_id=%s order by at", (alias["id"],))
    assert [r["action"] for r in receipts] == ["auto_accept", "undo"] and receipts[1]["after_state"]["status"] == "suggested"
    assert link(worker, w, task_id=w.t_word)["status"] == "accepted"
    assert one(worker, w, None, "select owner_id from pulse.task where id=%s", (w.t_word,))["owner_id"] == w.meera
    # The worker alone revisits; a person cannot call it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.people_work_auto_revert(%s::uuid[])", ([alias["id"]],))
    assert run(worker, w)["auto_reverted_now"] == 0
