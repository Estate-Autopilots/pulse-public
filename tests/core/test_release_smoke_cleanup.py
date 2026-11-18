"""The release smoke's cleanup() removes its validation people after they used the screens of 0144–0159 (UX-TASKS,
CHATS-2, PRESENCE-ONBOARD, UX-TASKS-2, LIFECYCLE). A staging smoke once failed there: chat receipts kept a foreign key to them (10 Oct 2026).
Runs the real cleanup() source from tools/release-smoke.py, as the database owner with only the organisation set."""
import ast
import uuid
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (fixture)


def _cleanup_from_script(conn):
    path = Path(__file__).resolve().parents[2] / "tools/release-smoke.py"
    tree = ast.parse(path.read_text())
    fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("purge", "cleanup")]
    scope = {"conn": conn, "sql": sql}
    exec(compile(ast.Module(body=fns, type_ignores=[]), str(path), "exec"), scope)
    return scope["cleanup"]


def test_release_smoke_cleanup_removes_validation_people(worker, owner, api, team):  # noqa: F811
    w = team
    pid, mate = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for p, role in ((pid, "person"), (mate, "manager")):
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (p, w.org, "Release validation " + role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence,accounts) values(%s,%s,%s,'Pod 1',%s,"
                           "'Release verification; delete after validation','{}')", (w.org, p, role, f"release.abcd1234.{role}"))
    # What opening the release's pages does for them: chat membership, a direct chat, delivered receipts, presence and a
    # status, the onboarding state (seen), plus an optional reference (a group they made: chat_channel.created_by).
    for who in (pid, mate):
        with api.transaction():
            set_tenant(api, w.org, who)
            api.execute("select pulse.chat_refresh()")
            api.execute("select pulse.presence_touch()")
            api.execute("select pulse.onboarding_state(%s)", (who,))
    with api.transaction():
        set_tenant(api, w.org, pid)
        api.execute("select pulse.chat_direct(%s)", (mate,))
        api.execute("select pulse.presence_set('Validation',null,now()+interval '1 hour',null)")
    for who in (pid, mate):
        with api.transaction():
            set_tenant(api, w.org, who)
            api.execute("select pulse.chat_delivered()")
    task = new_task(api, w, w.editor, title="Validation credit")
    # PROMOTE-4B: the review check's work. One of them makes a task, it is finished and waits for the other's review
    # (a task.done notification, task events); Pulse never deletes a task, so cleanup() purges it with them.
    review = new_task(api, w, mate, title="Release validation review", reviewerId=str(pid))
    one(api, w, mate, "select pulse.task_move(%s,'done',null) r", (review,))
    with owner.transaction():
        set_tenant(owner, w.org)
        # An optional reference to one of them (the column CHATS-2 added for groups people make).
        owner.execute("update pulse.chat_channel set created_by=%s where id=(select id from pulse.chat_channel where org_id=%s and kind='pod' limit 1)", (pid, w.org))
        # A phone paired by one of them, as the smoke's own device checks leave it (native_pair.person_id is optional,
        # so it must be deleted before optional references are cleared).
        device = owner.execute("insert into pulse.native_device(org_id,person_id,name,platform) values(%s,%s,'Validation phone','android') returning id", (w.org, pid)).fetchone()["id"]
        owner.execute("insert into pulse_priv.native_pair(org_id,code,poll_hash,platform,name,status,person_id,device_id) values(%s,'ABCD-EFGH',%s,'android','Validation phone','redeemed',%s,%s)",
                      (w.org, "a" * 64, pid, device))
        # The desktop smoke's one-day working pattern, the same statement: today becomes a working day for them.
        owner.execute("""insert into pulse.hr_work_pattern(org_id,person_id,work_days,valid_from,valid_to,reason,changed_by)
            select pulse.current_org(),%s,array[extract(isodow from d)::int],d,d,'Release validation: today is a working day',%s
            from (select (now() at time zone 'Asia/Kolkata')::date d) t""", (pid, pid))
        assert owner.execute("select pulse.hr_working(%s,(now() at time zone 'Asia/Kolkata')::date,'{1,2,3,4,5,6}') w", (pid,)).fetchone()["w"]
        # UX-TASKS-2 (0153): a responsibility domain proposed for one of them by the other.
        owner.execute("insert into pulse.work_domain(org_id,person_id,title,basis,tags,proposed_by,proposed_side) values(%s,%s,'Validation edits','agreement','{video}',%s,'company')",
                      (w.org, pid, mate))
        # (No credit row: since INTEGRITY 0910 none can be written; the cleanup still clears legacy ones.)
        # LIFECYCLE (0157–0159): a pod change is a dated move, a thank-you between them, HR's review of one of them, and
        # the role seat each holds (seat_sync runs whenever leadership opens seats or staffing gaps).
        owner.execute("update pulse.people_profile set pod='Pod 2' where person_id=%s", (pid,))
        owner.execute("insert into pulse.kudos(org_id,from_person,to_person,note) values(%s,%s,%s,'Validation thanks')", (w.org, pid, mate))
        owner.execute("insert into pulse.lifecycle_review(org_id,person_id,confidence) values(%s,%s,'low')", (w.org, pid))
        owner.execute("select pulse.seat_sync()")
        assert owner.execute("select count(*) n from pulse.kudos where from_person=%s", (pid,)).fetchone()["n"] == 1
        # Delivered receipts for their chats (as the staging smoke left them; written as tests/core/test_chats_browser.py does).
        owner.execute("insert into pulse.chat_receipt(org_id,channel_id,person_id,delivered_through) select org_id,channel_id,person_id,now() "
                      "from pulse.chat_member where person_id=any(%s) on conflict do nothing", ([pid, mate],))
        counts = {t: owner.execute(f"select count(*) n from {t} where person_id=any(%s)", ([pid, mate],)).fetchone()["n"]
                  for t in ("pulse.chat_receipt", "pulse.person_status", "pulse_priv.person_onboarding", "pulse.chat_member", "pulse.work_domain",
                            "pulse.person_lifecycle_event", "pulse.lifecycle_review", "pulse.seat_holding")}
        counts["review notice"] = owner.execute("select count(*) n from pulse.notification where person_id=%s and event_type='task.done' and subject_id=%s", (pid, review)).fetchone()["n"]
    assert all(counts.values()), counts  # the scenario really created the rows that blocked the delete
    # The smoke runs cleanup() as the database owner with only the organisation set.
    owner_role = owner.execute("select pg_get_userbyid(nspowner) o from pg_namespace where nspname='pulse'").fetchone()["o"]
    owner.execute(sql.SQL("set role {}").format(sql.Identifier(owner_role)))
    owner.execute("select set_config('pulse.org_id',%s,false)", (str(w.org),))
    try:
        _cleanup_from_script(owner)([str(pid), str(mate)])
        assert owner.execute("select count(*) n from pulse.person where id=any(%s)", ([pid, mate],)).fetchone()["n"] == 0
        # Only their rows went: the team's own people and channels are still there.
        assert owner.execute("select count(*) n from pulse.person where org_id=%s", (w.org,)).fetchone()["n"] > 0
        assert owner.execute("select count(*) n from pulse.chat_channel where org_id=%s and kind='pod' and created_by is null", (w.org,)).fetchone()["n"] >= 1
        assert owner.execute("select count(*) n from pulse.task where id=%s", (task,)).fetchone()["n"] == 1
        # Their review task, its events and every notification to them or about it are gone.
        assert owner.execute("select count(*) n from pulse.task where id=%s", (review,)).fetchone()["n"] == 0
        assert owner.execute("select count(*) n from pulse.task_event where task_id=%s", (review,)).fetchone()["n"] == 0
        assert owner.execute("select count(*) n from pulse.notification where person_id=any(%s) or subject_id=%s", ([pid, mate], review)).fetchone()["n"] == 0
    finally:
        owner.execute("reset role")


def test_release_smoke_companion_check_lights_and_leaves_nothing(owner, api, team):  # noqa: F811
    """RELEASE-5: the staging smoke's companion check. HR's own task with the signal "Office Wi-Fi and IP saved" (ask
    first); as the database owner, in one transaction that is rolled back, a synthetic office with Wi-Fi and an IP is
    saved as HR: the companion's attention names the task; afterwards no office, event or hit remains."""
    w = team
    task = new_task(api, w, w.lead, title="Add the office Wi-Fi and IP in Office presence (release validation)", assigneeId=str(w.lead))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.task_companion_set(%s,%s)", (task, Jsonb({"signals": [{"event": "office.network.saved", "label": "Office Wi-Fi and IP saved",
                                                                                         "need": 1, "where": {"ip_count": {"gte": 1}}}], "autoDone": False})))
    events_before = None
    owner.autocommit = True
    try:
        with owner.transaction():
            owner.execute("select set_config('pulse.org_id',%s,true),set_config('pulse.viewer_id',%s,true)", (str(w.org), str(w.lead)))
            events_before = owner.execute("select count(*) n from pulse.event where type like 'office.%%'").fetchone()["n"]
            owner.execute("""insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,active,updated_by,public_ip_ranges)
              values(%s,'Release validation office (synthetic)',12.9716,77.5946,150,'[{"ssid":"Release-Validation"}]'::jsonb,true,%s,'{203.0.113.10/32}'::cidr[])""", (str(w.org), str(w.lead)))
            lit = owner.execute("select pulse.task_companion_attention() d").fetchone()["d"]
            raise psycopg.Rollback()
    finally:
        owner.autocommit = False
    hit = next(h for h in lit["hits"] if h["task"] == str(task))
    assert hit["event"] == "office.network.saved" and hit["mine"] is True and hit["met"] is True
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.presence_office where name='Release validation office (synthetic)'").fetchone()["n"] == 0
        assert owner.execute("select count(*) n from pulse.event where type like 'office.%%'").fetchone()["n"] == events_before
        assert owner.execute("select count(*) n from pulse.task_signal_hit where task_id=%s", (task,)).fetchone()["n"] == 0
