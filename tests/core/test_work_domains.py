"""UX-TASKS-2: the company's work settings, responsibility domains and the assignment rule they change, the task pool
(first claim wins), value and credit, and the links between a client project and the projects that deliver it,
enforced by the database under row-level security. Synthetic tenants only."""
import threading
import uuid

import psycopg
import pytest
from conftest import dsn
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)
from test_work_structure import client_project, save_project

# RELEASE-5: the owner's task, read as client service (its "check-in with") until setup and admin had a kind.
OFFICE_TASK = "Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people"


def propose(api, w, who, person, **fields):
    return one(api, w, who, "select pulse.work_domain_propose(%s,%s) id", (person, Jsonb(fields)))["id"]


def answer(api, w, who, domain, accept, note=None):
    return one(api, w, who, "select pulse.work_domain_answer(%s,%s,%s) r", (domain, accept, note))["r"]


def mode(api, w, who, person, project=None, category=None, tags=None):
    return one(api, w, who, "select pulse.work_assign_mode(%s,%s,%s,%s) m", (person, project, category, tags or []))["m"]


def pod_project(api, w, name="Pod 1 client work", pod="Pod 1"):
    return uuid.UUID(save_project(api, w, w.manager, name=name, type="internal", pod=pod)["id"])


def test_settings_and_categories(api, worker, team):
    w = team
    s = one(api, w, w.editor, "select pulse.work_settings_get() s")["s"]
    assert s["businessModel"] == "agency" and s["aiAutoAcceptMax"] is None and s["canEdit"] is False
    assert one(api, w, w.manager, "select pulse.work_settings_get() s")["s"]["canEdit"] is True
    for who in (w.editor, w.lead):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.work_settings_set(%s)", (Jsonb({"businessModel": "product"}),))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.work_settings_set(%s)", (Jsonb({"businessModel": "shop"}),))
    s = one(api, w, w.manager, "select pulse.work_settings_set(%s) s", (Jsonb({"businessModel": "product", "aiAutoAcceptMax": 3}),))["s"]
    assert s["businessModel"] == "product" and s["aiAutoAcceptMax"] == 3
    # A new company gets the shared vocabulary on first use (not when it is created); titles are read into a kind of work.
    assert one(api, w, w.editor, "select count(*) n from pulse.work_category")["n"] == 0
    t = new_task(api, w, w.editor, title="Colour grade the teaser")
    keys = {r["key"] for r in as_(api, w, w.editor, "select key from pulse.work_category")}
    assert {"video_edit", "video_shoot", "meta_ads", "engineering"} <= keys
    guess = {t: one(api, w, w.editor, "select pulse.work_category_guess(%s) k", (t,))["k"]
             for t in ("Cut the teaser", "Drone permit for Sunrise", "Plan the campaign", "Weekly lead review", "Leadership offsite", "Fix the login bug",
                       OFFICE_TASK, "Check-in with Northstar on the approval")}
    assert guess == {"Cut the teaser": "video_edit", "Drone permit for Sunrise": "video_shoot", "Plan the campaign": "meta_ads",
                     "Weekly lead review": "sales", "Leadership offsite": None, "Fix the login bug": "engineering",
                     OFFICE_TASK: "setup_admin", "Check-in with Northstar on the approval": "client_service"}
    assert one(api, w, w.editor, "select category from pulse.task where id=%s", (t,))["category"] == "video_edit"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_category_save(%s)", (Jsonb({"key": "drone_ops", "label": "Drone operations"}),))
    as_(api, w, w.lead, "select pulse.work_category_save(%s)", (Jsonb({"key": "drone_ops", "label": "Drone operations", "words": ["fpv", "gimbal (x)"], "position": 5}),))
    assert one(api, w, w.editor, "select pulse.work_category_guess('FPV fly-through') k")["k"] == "drone_ops"
    assert one(api, w, w.editor, "select pulse.work_category_guess('a gimbal (x) rig') k")["k"] == "drone_ops"


def test_domains_are_agreed_or_set_by_policy(api, worker, team):
    w = team
    # The pod head proposes for their member; the member agrees, with a date.
    d = propose(api, w, w.editor2, w.editor, title="Video editing for Pod 1 clients", categories=["video_edit"], pod="Pod 1")
    row = one(api, w, w.editor, "select status,proposed_side,basis from pulse.work_domain where id=%s", (d,))
    assert row == {"status": "proposed", "proposed_side": "company", "basis": "agreement"}
    assert [n["subject_id"] for n in notes(worker, w, w.editor, "domain.proposed")] == [d]
    assert one(api, w, w.outsider, "select count(*) n from pulse.work_domain where id=%s", (d,))["n"] == 0  # proposals stay between the sides
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        answer(api, w, w.editor2, d, True)  # the side that proposed does not answer
    assert answer(api, w, w.editor, d, True)["status"] == "active"
    agreed = one(api, w, w.outsider, "select status,agreed_on,person_agreed_at,company_agreed_by from pulse.work_domain where id=%s", (d,))
    assert agreed["status"] == "active" and agreed["agreed_on"] and agreed["person_agreed_at"] and agreed["company_agreed_by"] == w.editor2
    assert notes(worker, w, w.editor2, "domain.answered")
    # The person proposes their own; their head hears and declines it.
    mine = propose(api, w, w.editor, w.editor, title="Meta ads for Pod 1", categories=["meta_ads"], pod="Pod 1")
    assert [n["subject_id"] for n in notes(worker, w, w.editor2, "domain.proposed")] == [mine]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        answer(api, w, w.outsider, mine, True)
    assert answer(api, w, w.editor2, mine, False, "Pod 2 runs ads")["status"] == "declined"
    # Nobody proposes for someone outside their reach; only HR, leadership and admins set policy.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        propose(api, w, w.outsider, w.editor, title="Design for Pod 2", categories=["design"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        propose(api, w, w.editor2, w.editor, title="Editing policy", categories=["video_edit"], basis="policy")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        propose(api, w, w.lead, w.outsider, title="Nothing at all")
    policy = propose(api, w, w.lead, w.outsider, title="Design for Pod 2 clients", categories=["design"], pod="Pod 2", basis="policy")
    assert one(api, w, w.outsider, "select status,basis from pulse.work_domain where id=%s", (policy,)) == {"status": "active", "basis": "policy"}
    assert notes(worker, w, w.outsider, "domain.policy")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.work_domain_end(%s,'not mine')", (policy,))  # mandatory for the person
    as_(api, w, w.lead, "select pulse.work_domain_end(%s,'Pod 2 merged')", (policy,))
    assert one(api, w, w.lead, "select status from pulse.work_domain where id=%s", (policy,))["status"] == "ended"
    # Either side ends an agreement.
    as_(api, w, w.editor, "select pulse.work_domain_end(%s,'moving to shoots')", (d,))
    assert notes(worker, w, w.editor2, "domain.ended")


def test_assignment_follows_domains(api, worker, team):
    w = team
    pid = pod_project(api, w)
    d = propose(api, w, w.editor2, w.editor, title="Video editing for Pod 1 clients", categories=["video_edit"], pod="Pod 1")
    answer(api, w, w.editor, d, True)
    # Inside the domain: anyone who may ask them assigns directly (here a Pod 2 member), and they are told.
    m = mode(api, w, w.outsider, w.editor, pid, "video_edit")
    assert m["mode"] == "direct" and m["why"] == "in_domain" and m["domainTitle"] == "Video editing for Pod 1 clients"
    t = new_task(api, w, w.outsider, title="Cut the teaser", projectId=str(pid), assigneeId=str(w.editor))
    assert one(api, w, w.editor, "select assignee_person_id a,category c from pulse.task where id=%s", (t,)) == {"a": w.editor, "c": "video_edit"}
    assert any(n["subject_id"] == t for n in notes(worker, w, w.editor, "task.assigned"))
    # Outside the domain it is a request to join, even from their pod head.
    assert mode(api, w, w.editor2, w.editor, pid, "design") == {"mode": "request", "why": "outside_domains"}
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="outside Editor"):
        new_task(api, w, w.editor2, title="Design the brochure", projectId=str(pid), assigneeId=str(w.editor))
    assert mode(api, w, w.editor2, w.editor, None, "video_edit")["mode"] == "request"  # not Pod 1 client work
    # Heads assigning inside their reports' domains are always direct, whatever HR narrowed.
    as_(api, w, w.lead, "select pulse.work_rule_set('pod_head','task.assign','self')")
    as_(api, w, w.lead, "select pulse.work_rule_set('pod_head','task.ask','none')")
    assert mode(api, w, w.editor2, w.editor, pid, "video_edit")["why"] == "head_domain"
    assert new_task(api, w, w.editor2, title="Edit the reel", projectId=str(pid), assigneeId=str(w.editor))
    # Tags narrow a domain; the project's tags count too.
    tagged = propose(api, w, w.lead, w.outsider, title="Drone shoots", categories=["video_shoot"], tags=["drone"], basis="policy")
    assert tagged and mode(api, w, w.manager, w.outsider, None, "video_shoot", ["drone"])["mode"] == "direct"
    assert mode(api, w, w.manager, w.outsider, None, "video_shoot", ["studio"])["mode"] == "request"
    # Someone with no domains yet: Who can do what decides, as before.
    assert mode(api, w, w.manager, w.lead, pid, "design") == {"mode": "direct", "why": "matrix"}
    assert mode(api, w, w.editor, w.lead, None, "design") == {"mode": "request", "why": "matrix"}


def test_pool_claim_first_wins(api, worker, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set department='Creative' where person_id in (%s,%s,%s)", (w.editor, w.editor2, w.outsider))
    d = propose(api, w, w.lead, w.editor, title="Video editing", categories=["video_edit"], basis="policy")
    assert d
    # Members do not pool; a pod head pools in their own pod only; HR anywhere.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        new_task(api, w, w.editor, title="Members cannot pool", pool={"scope": "pod", "ref": "Pod 1"})
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        new_task(api, w, w.editor2, title="Not my pod", pool={"scope": "pod", "ref": "Pod 2"})
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        new_task(api, w, w.lead, title="Pool and person", pool={"scope": "company"}, assigneeId=str(w.editor))
    t = new_task(api, w, w.lead, title="Edit the launch reel", pool={"scope": "pod", "ref": "Pod 1"}, urgency="high", estimateMinutes=180)
    one(api, w, w.lead, "select pulse.task_value_set(%s,%s) r", (t, Jsonb({"importance": "high"})))
    row = one(api, w, w.lead, "select pool_scope,pool_ref,pooled_by,assignee_person_id,urgency,estimate_minutes,value_points,priority,review_owner_id from pulse.task where id=%s", (t,))
    assert row == {"pool_scope": "pod", "pool_ref": "Pod 1", "pooled_by": w.lead, "assignee_person_id": None, "urgency": "high", "estimate_minutes": 180,
                   "value_points": None, "priority": "high", "review_owner_id": w.lead}
    # The person whose domain it fits hears; the pool is seen by Pod 1 only.
    assert [n["subject_id"] for n in notes(worker, w, w.editor, "pool.match")] == [t]
    assert one(api, w, w.editor, "select count(*) n from pulse.task where id=%s", (t,))["n"] == 1
    assert one(api, w, w.outsider, "select count(*) n from pulse.task where id=%s", (t,))["n"] == 0
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.outsider, "select pulse.work_pool_claim(%s)", (t,))
    # Eligible people may not edit a pool task (they claim it); whoever pooled it may.
    assert one(api, w, w.editor, "select pulse.task_can_edit(%s) ok", (t,))["ok"] is False
    assert one(api, w, w.lead, "select pulse.task_can_edit(%s) ok", (t,))["ok"] is True
    # Two people claim at the same moment: the first commits, the second is told someone was first.
    first = psycopg.connect(dsn("api"), row_factory=dict_row)
    second = psycopg.connect(dsn("api"), row_factory=dict_row, autocommit=True)
    try:
        set_tenant(first, w.org, w.editor)
        first.execute("select pulse.work_pool_claim(%s)", (t,))
        outcome = {}

        def late():
            try:
                with second.transaction():
                    set_tenant(second, w.org, w.editor2)
                    second.execute("select pulse.work_pool_claim(%s)", (t,))
                outcome["r"] = "claimed"
            except psycopg.errors.UniqueViolation as e:
                outcome["r"] = str(e)
        th = threading.Thread(target=late)
        th.start()
        th.join(1.5)
        assert th.is_alive(), "the second claim waits for the first"
        first.commit()
        th.join(10)
        assert "Someone claimed it first" in outcome["r"]
    finally:
        first.close()
        second.close()
    got = one(api, w, w.lead, "select assignee_person_id a,claimed_by c,review_owner_id r from pulse.task where id=%s", (t,))
    assert got == {"a": w.editor, "c": w.editor, "r": w.lead}
    assert notes(worker, w, w.lead, "pool.claimed")
    # The claimant may hand it back before finishing; a department pool is for that department.
    as_(api, w, w.editor, "select pulse.work_pool_release(%s,'No time this week')", (t,))
    assert one(api, w, w.lead, "select assignee_person_id a from pulse.task where id=%s", (t,))["a"] is None
    dep = new_task(api, w, w.editor2, title="Creative brief template", pool={"scope": "department", "ref": "Creative"})
    assert one(api, w, w.outsider, "select count(*) n from pulse.task where id=%s", (dep,))["n"] == 1
    assert one(api, w, w.outsider, "select pulse.work_pool_claim(%s) r", (dep,))["r"]["status"] == "claimed"
    co = new_task(api, w, w.manager, title="Company offsite deck", pool={"scope": "company"})
    assert one(api, w, w.outsider, "select count(*) n from pulse.task where id=%s", (co,))["n"] == 1


def test_task_value_retired(api, worker, owner, team):
    """INTEGRITY (owner, 22 Oct 2026: "Remove the Pip value per task: the value assignment is easily riggable"): no
    path sets a task's value or credits points: not the value form, not Pip's suggestion (even with automatic
    acceptance on), not acceptance, not a pool claim, not a help rating, not a direct write."""
    w = team
    own = new_task(api, w, w.editor, title="Rough cut for the Lakeview reel")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_value_set(%s,%s)", (own, Jsonb({"importance": "high"})))  # nobody sets their own
    # Pip's suggestion keeps importance and effort; a value in it is dropped, and automatic acceptance applies nothing.
    as_(api, w, w.manager, "select pulse.work_settings_set(%s)", (Jsonb({"aiAutoAcceptMax": 50}),))
    r = one(api, w, w.editor, "select pulse.task_suggestion_save(%s,%s) r", (own, Jsonb({"importance": "normal", "valuePoints": 3, "effortMinutes": 90, "reason": "Like 4 past reels",
        "breakdown": [{"signal": "size", "points": 3}]})))["r"]
    assert r["applied"] is False
    t = one(api, w, w.editor, "select value_points v,value_source s,ai_suggestion ? 'valuePoints' pv,ai_suggestion ? 'breakdown' pb,ai_suggestion->>'reason' why from pulse.task where id=%s", (own,))
    assert t == {"v": None, "s": None, "pv": False, "pb": False, "why": "Like 4 past reels"}
    # The head may still set importance and the estimate; value points sent with it change nothing.
    big = new_task(api, w, w.editor, title="Brand film for Northstar")
    r = one(api, w, w.editor2, "select pulse.task_value_set(%s,%s) r", (big, Jsonb({"valuePoints": 30, "importance": "high", "estimateMinutes": 240})))["r"]
    assert "valuePoints" not in r and r["importance"] == "high"
    assert one(api, w, w.editor2, "select value_points v,priority p,estimate_minutes e from pulse.task where id=%s", (big,)) == {"v": None, "p": "high", "e": 240}
    # Accepted work credits nothing, rated or the old effort x impact way, and a credit preview says nothing.
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (big,))
    assert one(api, w, w.editor2, "select pulse.task_credit_preview(%s) p", (big,))["p"] is None
    as_(api, w, w.editor2, "select pulse.task_accept(%s,4,4,'Great')", (big,))
    p = new_task(api, w, w.lead, title="Caption the reels", pool={"scope": "company"})
    as_(api, w, w.lead, "select pulse.task_value_set(%s,%s)", (p, Jsonb({"valuePoints": 8})))
    assert one(api, w, w.outsider, "select pulse.work_pool_claim(%s) r", (p,))["r"]["valuePoints"] is None
    as_(api, w, w.outsider, "select pulse.task_move(%s,'done')", (p,))
    as_(api, w, w.lead, "select pulse.task_accept(%s,3,3)", (p,))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.work_credit where task_id in (%s,%s)", (big, p)).fetchone()["n"] == 0
        # Not even a direct write: a value never sticks, and a credit row is never kept.
        worker.execute("update pulse.task set value_points=40,value_source='leadership' where id=%s", (big,))
        assert worker.execute("select value_points v from pulse.task where id=%s", (big,)).fetchone()["v"] is None
    with owner.transaction():
        set_tenant(owner, w.org)
        o = owner
        o.execute("insert into pulse.work_credit(org_id,task_id,person_id,points,basis,via,work_day) values(%s,%s,%s,50,'value','assigned',current_date)", (w.org, big, w.editor))
        assert o.execute("select count(*) n from pulse.work_credit where task_id=%s", (big,)).fetchone()["n"] == 0
    # Work units (people value, seats) count one per task someone else made or accepted: a task a person makes and
    # finishes alone counts nothing.
    solo = new_task(api, w, w.editor, title="My own little task")
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (solo,))
    with owner.transaction():
        set_tenant(owner, w.org)
        u = owner.execute("select coalesce(sum(units),0)::int u from pulse.value_units(current_date-30,current_date+1,%s)", (w.editor,)).fetchone()["u"]
        made = owner.execute("select count(*) n from pulse.task where coalesce(assignee_person_id,owner_id)=%s and status='done' and created_by<>%s", (w.editor, w.editor)).fetchone()["n"]
        alone = owner.execute("select count(*) n from pulse.task where coalesce(assignee_person_id,owner_id)=%s and status='done' and created_by=%s", (w.editor, w.editor)).fetchone()["n"]
    assert alone >= 1 and u == made


def test_links_detected_reviewed_and_captured(api, worker, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        client = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Northstar Developers','developer') returning id", (w.org,)).fetchone()["id"]
    pkg = client_project(worker, w, title="Northstar Heights", client=client)
    other = client_project(worker, w, title="Lakeview Villas")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set storage_root='index-path:Client Video Shoot/2026/#1 - Northstar Heights' where id=%s", (pkg,))
    inside = pod_project(api, w, name="Video Editing Details")
    named = pod_project(api, w, name="Northstar Heights Meta ads")
    unrelated = pod_project(api, w, name="Website relaunch")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set storage_root='index-path:Client Video Shoot/2026/#1 - Northstar Heights/1) Video Editing Details' where id=%s", (inside,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.work_link_suggest()")
    # A name alone is not enough; the Drive folder is.
    found = one(api, w, w.manager, "select pulse.work_link_suggest() r")["r"]
    assert found["suggested"] == 1
    # Tracker rows that name the package add a second signal to the name.
    with worker.transaction():
        set_tenant(worker, w.org)
        for k in range(2):
            worker.execute("insert into pulse.task(org_id,title,status,project_id,project_key,source) values(%s,%s,'open',%s,'Northstar Heights','tracker')", (w.org, f"Ad set {k}", named))
    assert one(api, w, w.manager, "select pulse.work_link_suggest() r")["r"]["suggested"] == 1
    rows = {r["project_id"]: r for r in as_(api, w, w.lead, "select project_id,client_project_id,source,confidence,evidence from pulse.work_project_link where status='suggested'")}
    assert set(rows) == {inside, named} and {r["client_project_id"] for r in rows.values()} == {pkg}
    assert rows[inside]["source"] == "drive" and float(rows[inside]["confidence"]) >= 0.9 and "1) Video Editing Details" in rows[inside]["evidence"][0]["detail"]
    assert rows[named]["source"] == "tracker" and {e["kind"] for e in rows[named]["evidence"]} == {"tracker", "name"}
    assert one(api, w, w.manager, "select pulse.work_link_suggest() r")["r"]["suggested"] == 0  # idempotent
    # Suggestions wait for leadership; members see only what was linked.
    assert one(api, w, w.editor, "select count(*) n from pulse.work_project_link")["n"] == 0
    ids = {r["project_id"]: r["id"] for r in as_(api, w, w.manager, "select id,project_id from pulse.work_project_link")}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.work_link_decide(%s,'link')", (ids[inside],))
    as_(api, w, w.manager, "select pulse.work_link_decide(%s,'link')", (ids[inside],))
    as_(api, w, w.manager, "select pulse.work_link_decide(%s,'dismiss')", (ids[named],))
    assert one(api, w, w.manager, "select pulse.work_link_suggest() r")["r"]["pending"] == 0  # a dismissed pair is not suggested again
    assert [r["project_id"] for r in as_(api, w, w.editor, "select project_id from pulse.work_project_link")] == [inside]
    # By hand: leadership or the project's owner.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_link_set(%s,%s,true)", (other, unrelated))
    as_(api, w, w.manager, "select pulse.work_link_set(%s,%s,true)", (other, unrelated))
    # The capture seam (admin Google connection): a suggestion with evidence, never a link by itself.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.work_link_capture(%s)", (Jsonb({"clientProjectId": str(pkg), "projectId": str(unrelated), "evidence": [{"text": "x"}]}),))
    cid = one(api, w, w.manager, "select pulse.work_link_capture(%s) id", (Jsonb({"clientProjectId": str(pkg), "projectId": str(unrelated), "confidence": 0.7,
                                                                                "evidence": [{"text": "Shared in the Northstar Heights Drive folder", "ref": "drive:abc"}]}),))["id"]
    assert one(api, w, w.manager, "select status,source from pulse.work_project_link where id=%s", (cid,)) == {"status": "suggested", "source": "google"}
    # A domain on the client project covers the projects linked under it.
    d = propose(api, w, w.lead, w.outsider, title="Editing for Northstar Heights", categories=["video_edit"], projectId=str(pkg), basis="policy")
    assert d and mode(api, w, w.manager, w.outsider, inside, "video_edit")["mode"] == "direct"
    assert mode(api, w, w.manager, w.outsider, named, "video_edit")["mode"] == "request"


def test_client_folders_under_one_package(api, worker, team):
    """EA files a two-project package as a folder that says "2 Projects" and the next project as "Project 2"."""
    w = team
    folders = {}
    with worker.transaction():
        set_tenant(worker, w.org)
        anil = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Adas Sonom','developer') returning id", (w.org,)).fetchone()["id"]
        for key, title, month, seg in (("pkg", "Adas Sonom", "2024-11-01", "#13 - Mr. Adas Sonom | Moshi | Nov | R | 2 Projects"),
                                       ("second", "ROHE KINEMUH ONE", "2024-12-01", "#4 - Mr. Adas Sonom | ROHE KINEMUH ONE | Moshi | Dec | R | Project 2"),
                                       ("later", "Adas Sonom Towers", "2025-06-01", "#2 - Mr. Adas Sonom | Towers | June | R"),
                                       ("same", "Adas Sonom Riverside", "2024-11-01", "#14 - Mr. Adas Sonom | Riverside | Nov | R")):
            no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
            folders[key] = worker.execute("insert into pulse.project(org_id,registry_no,name,title,client_id,start_month,storage_root) values(%s,%s,%s,%s,%s,%s,%s) returning id",
                                          (w.org, no, title, title, anil, month, f"index-path:Client Video Shoot/2024/#5 - Nov 2024/{seg}")).fetchone()["id"]
    one(api, w, w.manager, "select pulse.work_link_suggest() r")
    rows = as_(api, w, w.manager, "select client_project_id,project_id,source,confidence,evidence from pulse.work_project_link where status='suggested' and retired_at is null")
    # The "Project 2" folder joins the "2 Projects" package (one more project, so the same-month folder is not added too).
    assert [(r["client_project_id"], r["project_id"]) for r in rows] == [(folders["pkg"], folders["second"])]
    texts = [e["text"] for e in rows[0]["evidence"]]
    assert "Its folder says “Project 2”" in texts and "The package’s folder says “2 Projects”" in texts and "Same client: Adas Sonom" in texts
    assert any(t.startswith("A month apart") for t in texts) and float(rows[0]["confidence"]) >= 0.7
    lid = one(api, w, w.manager, "select id from pulse.work_project_link where project_id=%s", (folders["second"],))["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.work_link_set(%s,%s,true)", (folders["later"], folders["same"]))  # client folders are leadership's call
    as_(api, w, w.manager, "select pulse.work_link_decide(%s,'link')", (lid,))
    # One level only: a package inside another holds nothing, and a package with folders under it joins no other.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="sits inside another"):
        as_(api, w, w.manager, "select pulse.work_link_set(%s,%s,true)", (folders["second"], folders["later"]))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already holds projects"):
        as_(api, w, w.manager, "select pulse.work_link_set(%s,%s,true)", (folders["later"], folders["pkg"]))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already part of another"):
        as_(api, w, w.manager, "select pulse.work_link_set(%s,%s,true)", (folders["later"], folders["second"]))


def test_pool_visibility_matches_the_row_rule(api, worker, team):
    """Pool tasks join task_visible_ids(); it still answers exactly as task_visible_row() for every role."""
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set department='Creative' where person_id=%s", (w.outsider,))
    new_task(api, w, w.lead, title="Pod 1 pool", pool={"scope": "pod", "ref": "Pod 1"})
    new_task(api, w, w.lead, title="Pod 2 pool", pool={"scope": "pod", "ref": "Pod 2"})
    new_task(api, w, w.lead, title="Creative pool", pool={"scope": "department", "ref": "Creative"})
    new_task(api, w, w.manager, title="Company pool", pool={"scope": "company"})
    claimed = new_task(api, w, w.manager, title="Claimed already", pool={"scope": "company"})
    as_(api, w, w.editor, "select pulse.work_pool_claim(%s)", (claimed,))
    for who in (w.editor, w.editor2, w.outsider, w.lead, w.manager):
        with worker.transaction():
            set_tenant(worker, w.org, who)
            rows = {r["id"] for r in worker.execute("select id from pulse.task t where pulse.task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id)")}
            sets = {r["id"] for r in worker.execute("select pulse.task_visible_ids() id")}
        seen = {r["id"] for r in as_(api, w, who, "select id from pulse.task")}
        assert rows == sets == seen, who
    titles = {r["title"] for r in as_(api, w, w.outsider, "select title from pulse.task where pool_scope is not null")}
    assert titles == {"Pod 2 pool", "Creative pool", "Company pool"}


WORK2_API = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (url, email, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.json() }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 1200)); process.exit(1); } };
const member = process.env.TEST_MEMBER, head = process.env.TEST_HEAD, outsider = process.env.TEST_OUTSIDER_EMAIL, admin = 'admin@estateautopilots.com', hr = 'hr@estateautopilots.com';
const E = JSON.parse(process.env.TEST_IDS);
// Create's options: kinds of work, where the viewer may pool, the labels of the business model.
let r = await call('/api/v0/work/options', member);
ok(r.status === 200 && r.body.categories.some((c) => c.key === 'video_edit') && r.body.pools.length === 0 && r.body.labels.clientProjects === 'Client projects', 'member options', r);
r = await call('/api/v0/work/options', head);
ok(r.status === 200 && r.body.pools.some((p) => p.scope === 'pod' && p.ref === 'Pod 1') && !r.body.pools.some((p) => p.scope === 'company'), 'pod head pools in the pod', r.body.pools);
// Preview while typing: the kind of work, direct or a request, and Pip's suggestion with its reason.
r = await call('/api/v0/work/tasks/preview', head, { title: 'Cut the teaser', assigneeId: E.member, dueOn: E.soon });
ok(r.status === 200 && r.body.category === 'video_edit' && r.body.mode.mode === 'direct' && r.body.mode.why === 'matrix', 'preview before domains', r);
const s = r.body.suggestion;
ok(s.valuePoints === undefined && s.breakdown === undefined && s.effortMinutes >= 5 && ['high', 'urgent'].includes(s.importance) && /video editing/i.test(s.reason) && s.model === 'pip-heuristic', 'Pip suggests with a reason', s);
// Domains: HR sets a policy; everyone sees the active domain, only the sides see the buttons.
r = await call('/api/v0/work/domains', hr, { personId: E.member, title: 'Video editing for Pod 1 clients', categories: ['video_edit'], pod: 'Pod 1', basis: 'policy' });
ok(r.status === 200 && r.body.id, 'HR sets policy', r);
r = await call('/api/v0/work/domains', member);
ok(r.status === 200 && r.body.self && r.body.domains.length === 1 && r.body.domains[0].basis === 'policy' && r.body.domains[0].actions.length === 0 && r.body.can.propose, 'own domains', r);
r = await call(`/api/v0/work/domains?person=${E.member}`, outsider);
ok(r.status === 200 && r.body.domains.length === 1 && !r.body.can.propose && r.body.options === null, 'colleague sees the domain only', r);
r = await call('/api/v0/work/domains', head, { personId: E.member, title: 'Design for Pod 1', categories: ['design'] });
const proposal = r.body.id; ok(r.status === 200 && proposal, 'head proposes', r);
r = await call('/api/v0/work/notices', member);
const dcard = r.body.rows.find((n) => n.eventType === 'domain.proposed');
ok(dcard && dcard.actions.map((a) => a.label).join() === 'Agree,Decline' && dcard.subject.title === 'Design for Pod 1', 'domain card in the panel', r.body.rows);
r = await call(dcard.actions[0].path, member, {});
ok(r.status === 200 && r.body.status === 'active', 'agreed from the card', r);
// Inside the domain the head assigns directly; outside it the same button asks.
const pid = E.pod1Project;
r = await call('/api/v0/work/tasks', head, { title: 'Edit the Northstar reel', assigneeId: E.member, projectId: pid });
ok(r.status === 200 && r.body.assigned === true && r.body.mode.why === 'head_domain' && r.body.suggestion.valuePoints === undefined, 'in the domain: direct', r);
const edit = r.body.id;
r = await call('/api/v0/work/tasks', head, { title: 'Plan the Lakeview campaign', assigneeId: E.member, projectId: pid });
ok(r.status === 200 && r.body.assigned === false && r.body.asked?.id && r.body.mode.why === 'outside_domains', 'outside: a request to join', r);
r = await call(`/api/v0/tasks/${edit}`, member);
ok(r.status === 200 && r.body.task.inDomain?.title === 'Video editing for Pod 1 clients' && r.body.task.category === 'video_edit', 'In your domain on the task', r.body.task);
// The pool: HR throws a task in (value points sent are ignored: INTEGRITY); it fits the member's domain, who hears and claims it first.
r = await call('/api/v0/work/tasks', hr, { title: 'Edit the testimonial cutdown', pool: { scope: 'company' }, projectId: pid, valuePoints: 9, urgency: 'high', estimateMinutes: 120 });
ok(r.status === 200 && r.body.pooled?.scope === 'company' && !r.body.valued?.valuePoints && !r.body.assigned, 'pooled, no value', r);
const pooled = r.body.id;
r = await call('/api/v0/work/pool?fits=1', member);
ok(r.status === 200 && r.body.rows.some((t) => t.id === pooled && t.inDomain && t.valuePoints === undefined && t.suggestedPoints === undefined && t.canClaim) && r.body.fits >= 1, 'pool fits my domains', r.body);
r = await call('/api/v0/work/notices', member);
const pcard = r.body.rows.find((n) => n.eventType === 'pool.match' && n.subject?.id === pooled);
ok(pcard && pcard.actions[0].label === 'Claim', 'pool card offers Claim', r.body.rows);
r = await call(pcard.actions[0].path, member, {});
ok(r.status === 200 && r.body.status === 'claimed' && !('valuePoints' in r.body), 'claimed', r);
r = await call(`/api/v0/work/pool/${pooled}/claim`, head, {});
ok(r.status === 409 && /claimed it first/.test(r.body.error), 'second claim refused', r);
r = await call(`/api/v0/work/pool/${pooled}/claim`, outsider, {});
ok(r.status === 404, 'a claimed task leaves the pool for others', r);
// The reviewer (who pooled it) accepts; value points sent with it are ignored and nothing is credited.
r = await call(`/api/v0/tasks/${pooled}/move`, member, { status: 'done' });
ok(r.status === 200, 'done', r);
r = await call(`/api/v0/tasks/${pooled}/accept`, hr, { effort: 3, impact: 4, valuePoints: 11 });
ok(r.status === 200 && r.body.credit === null && !('points' in r.body), 'accepted, nothing credited', r);
r = await call('/api/v0/tasks/home', member);
ok(r.status === 200 && r.body.summary.weekValue === undefined && r.body.summary.weekAccepted >= 1 && r.body.domains.length === 2, 'my week shows accepted work and domains, no value', r.body.summary);
r = await call(`/api/v0/work/tasks/${edit}/value`, member, { importance: 'urgent' });
ok(r.status === 403, 'nobody sets their own importance', r);
r = await call(`/api/v0/work/tasks/${edit}/value`, head, { valuePoints: 50 });
ok(r.status === 400, 'value points are refused', r);
r = await call(`/api/v0/work/tasks/${edit}/value`, head, { useSuggestion: true });
ok(r.status === 200 && r.body.valuePoints === undefined && r.body.importance, 'head takes Pip’s importance and estimate', r);
r = await call(`/api/v0/tasks/${edit}/credit`, head);
ok(r.status === 200 && r.body.mode && r.body.points === undefined, 'how it is accepted, no points', r);
// Settings: the business model renames things; only leadership and admins change it.
r = await call('/api/v0/work/settings', member, { businessModel: 'product' });
ok(r.status === 403, 'member cannot rename', r);
r = await call('/api/v0/work/settings', admin, { businessModel: 'product' });
ok(r.status === 200 && r.body.labels.clientProjects === 'Releases' && r.body.labels.clients === 'Customers', 'product labels', r);
r = await call('/api/v0/work/settings', admin, { businessModel: 'agency' });
// Links: leadership detects and reviews; HR reads; members are refused the review.
r = await call('/api/v0/work/links/detect', admin, {});
ok(r.status === 200 && typeof r.body.pending === 'number', 'detect', r);
r = await call('/api/v0/work/links/review', member);
ok(r.status === 403, 'review is for leadership', r);
r = await call(`/api/v0/work/package/${E.project}`, member);
ok(r.status === 200 && Array.isArray(r.body.links.linked) && r.body.links.suggestions.length === 0 && r.body.combined, 'package with links', r);
// The leader's view: hours, value, people, pods and departments; drill-down to a person.
r = await call('/api/v0/work/dashboard?group=department', admin);
ok(r.status === 200 && r.body.group === 'department' && Array.isArray(r.body.groups.department) && r.body.groups.pod.length >= 1 && typeof r.body.totals.value === 'number'
  && r.body.workload.every((w) => typeof w.minutes === 'number' && typeof w.value === 'number') && r.body.groups.department[0].weeks.length === 8, 'leader view', r.body);
r = await call(`/api/v0/work/people/${E.member}`, head);
ok(r.status === 200 && r.body.weeks.length === 8 && r.body.domains.length === 2 && r.body.credits === undefined && r.body.weeks.every((x) => x.value === undefined), 'person view for the head, no value', r);
r = await call(`/api/v0/work/people/${E.member}`, outsider);
ok(r.status === 403, 'not for colleagues', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_work_two_api(worker, owner, api, team):
    import json
    import os
    import subprocess
    from datetime import date, timedelta
    from pathlib import Path
    from psycopg.conninfo import conninfo_to_dict
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"outsider@{w.domain}", w.outsider))
    pid = pod_project(api, w)

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}",
           "TEST_IDS": json.dumps({"member": str(w.editor), "head": str(w.editor2), "outsider": str(w.outsider), "project": str(w.project), "pod1Project": str(pid),
                                   "soon": (date.today() + timedelta(days=1)).isoformat()})}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", WORK2_API], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
    # The older effort × impact accept above still works, for old clients only, and the API logs each use (PROMOTE-4B).
    legacy = [json.loads(line) for line in p.stdout.splitlines() if 'legacy effort/impact accept' in line]
    assert len(legacy) == 1 and legacy[0]["level"] == 40 and legacy[0]["task"] and legacy[0]["person"], p.stdout[-2000:]


def _seed_work_two(api, worker, w):
    """The UX-TASKS showcase agency, plus what UX-TASKS-2 adds: departments, domains (policy, agreed, one waiting), a pool
    with value, Pip's suggestions, eight weeks of hours and credits, and client folders filed under one package. Synthetic."""
    from datetime import date, timedelta
    from test_work_structure import _seed_showcase
    ids = _seed_showcase(api, worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        people = {r["display_name"]: r["id"] for r in worker.execute("select id,display_name from pulse.person where org_id=%s", (w.org,))}
        for name, dept in (("Kabir Shah", "Creative"), ("Ahoro Rao", "Creative"), ("Dev Panab", "Creative"), ("Sana Khan", "Creative"), ("Meera Iyer", "Performance"),
                           ("Ishaan Vivim", "Performance"), ("Tara Nair", "Creative"), ("Vikram Seduh", "Performance"), ("Neha Jivop", "Leadership"), ("Rila Kapoor", "Leadership")):
            worker.execute("update pulse.people_profile set department=%s where person_id=%s", (dept, people[name]))
        pkgs = {r["title"]: r["id"] for r in worker.execute("select id,title from pulse.project where org_id=%s and kind='client_work'", (w.org,))}
        north_client = worker.execute("select client_id from pulse.project where id=%s", (pkgs["Northstar Heights"],)).fetchone()["client_id"]
        month = date.today().replace(day=1)
        worker.execute("update pulse.project set storage_root=%s where id=%s",
                       (f"index-path:Client Video Shoot/2026/#3 - {month:%b %Y}/#4 - Northstar Developers | Northstar Heights | {month:%b %Y} | R | 2 Projects", pkgs["Northstar Heights"]))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        lake_client = worker.execute("select client_id from pulse.project where id=%s", (pkgs["Lakeview Villas"],)).fetchone()["client_id"]
        worker.execute("update pulse.project set storage_root=%s where id=%s",
                       (f"index-path:Client Video Shoot/2026/#3 - {month:%b %Y}/#2 - Lakeview Homes | Lakeview Villas | {month:%b %Y} | R | 2 Projects", pkgs["Lakeview Villas"]))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        worker.execute("insert into pulse.project(org_id,registry_no,name,title,client_id,start_month,storage_root) values(%s,%s,'Lakeview Gardens','Lakeview Gardens',%s,%s,%s)",
                       (w.org, no, lake_client, month, f"index-path:Client Video Shoot/2026/#3 - {month:%b %Y}/#11 - Lakeview Homes | Lakeview Gardens | {month:%b %Y} | R | 2nd Project"))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        skyline = worker.execute("insert into pulse.project(org_id,registry_no,name,title,client_id,start_month,storage_root) values(%s,%s,'Northstar Skyline','Northstar Skyline',%s,%s,%s) returning id",
                                 (w.org, no, north_client, month, f"index-path:Client Video Shoot/2026/#3 - {month:%b %Y}/#9 - Northstar Developers | Northstar Skyline | {month:%b %Y} | R | Project 2")).fetchone()["id"]
    hr, lead, head = people["Neha Jivop"], people["Rila Kapoor"], people["Ahoro Rao"]
    # Domains: company policy for Dev, an agreement for Meera, and Tara's own proposal waiting for her head.
    propose(api, w, hr, people["Dev Panab"], title="Video editing for Pod 1 clients", categories=["video_edit"], pod="Pod 1", basis="policy")
    d = propose(api, w, people["Vikram Seduh"], people["Meera Iyer"], title="Meta ads for Pod 2 clients", categories=["meta_ads"], pod="Pod 2")
    answer(api, w, people["Meera Iyer"], d, True)
    propose(api, w, people["Tara Nair"], people["Tara Nair"], title="Design for Lakeview Villas", categories=["design"], projectId=str(pkgs["Lakeview Villas"]), note="I have done every Lakeview creative since launch")
    propose(api, w, head, people["Sana Khan"], title="Scripts and copy for Creative", categories=["scripting"])
    # The pool: HR and the pod head throw work in with value and urgency.
    north = uuid.UUID(ids["fulfilment"])
    pool = []
    for title, by, scope, ref, points, urgency, minutes, project in (
            ("Edit the testimonial cutdown", hr, "company", None, 9, "high", 120, north), ("Refresh the agency pitch deck", lead, "company", None, 15, "normal", 360, None),
            ("Caption the Sunrise reels", head, "department", "Creative", 4, "normal", 60, None), ("Storyboard the Skyline teaser", head, "pod", "Pod 1", 6, "low", 150, None)):
        t = new_task(api, w, by, title=title, pool={"scope": scope, **({"ref": ref} if ref else {})}, urgency=urgency, estimateMinutes=minutes, projectId=str(project) if project else None)
        one(api, w, by, "select pulse.task_value_set(%s,%s) r", (t, Jsonb({"valuePoints": points})))
        pool.append(t)
    # Pip's suggestions beside a few open tasks (as the API keeps them), and eight weeks of hours and credits.
    with worker.transaction():
        set_tenant(worker, w.org)
        open_tasks = worker.execute("select id,title from pulse.task where org_id=%s and status in ('open','in_progress') and assignee_person_id is not null order by created_at limit 6", (w.org,)).fetchall()
    for k, t in enumerate(open_tasks):
        one(api, w, lead, "select pulse.task_suggestion_save(%s,%s) r", (t["id"], Jsonb({"importance": "high" if k % 2 else "normal", "valuePoints": 4 + 3 * k, "effortMinutes": 60 + 45 * k,
            "reason": f"About {1 + k * 0.75:g} h like {2 + k} past tasks of this kind; client work.", "basis": ["Similar finished work", "Client work"], "confidence": "medium", "model": "pip-heuristic", "version": "1"})))
    rnd = __import__("random").Random(11)
    with worker.transaction():
        # With a viewer set, so the tracker lock (task_manual_wins) does not revert the status change.
        set_tenant(worker, w.org, lead)
        finished = worker.execute("select id,coalesce(assignee_person_id,owner_id) who from pulse.task where org_id=%s and status='done' and coalesce(assignee_person_id,owner_id) is not null", (w.org,)).fetchall()
        for k, t in enumerate(finished):
            worker.execute("update pulse.task set value_points=%s,value_source='leadership',effort=3,impact=3,status='accepted',accepted_at=now(),accepted_by=%s where id=%s", (rnd.choice([3, 5, 6, 8, 10, 12]), lead, t["id"]))
            worker.execute("update pulse.work_credit set work_day=current_date-%s where task_id=%s and reversed_at is null", (rnd.randint(0, 52), t["id"]))
        for name in ("Kabir Shah", "Dev Panab", "Sana Khan", "Meera Iyer", "Tara Nair", "Ishaan Vivim", "Vikram Seduh", "Ahoro Rao"):
            for back in range(0, 56, 1):
                if rnd.random() < 0.55:
                    worker.execute("insert into pulse.time_entry(org_id,person_id,work_date,minutes,source,status) values(%s,%s,current_date-%s,%s,'manual','confirmed')",
                                   (w.org, people[name], back, rnd.choice([60, 90, 120, 180, 240])))
        worker.execute("insert into pulse.time_entry(org_id,person_id,work_date,minutes,source,status) values(%s,%s,current_date,150,'commit','proposed')", (w.org, people["Kabir Shah"]))
    found = one(api, w, w.manager, "select pulse.work_link_suggest() r")["r"]
    assert found["pending"] >= 2
    return {**ids, "pool": [str(x) for x in pool], "dev": str(people["Dev Panab"]), "tara": str(people["Tara Nair"]), "kabir": str(people["Kabir Shah"]), "meera": str(people["Meera Iyer"]),
            "northstar": str(pkgs["Northstar Heights"]), "skyline": str(skyline), "head": str(head)}


@pytest.mark.skipif(__import__("os").environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_work_two_screens_in_the_browser(worker, owner, api, team, tmp_path):
    import json
    import os
    import subprocess
    from pathlib import Path
    from psycopg.conninfo import conninfo_to_dict
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"outsider@{w.domain}", w.outsider))
    ids = _seed_work_two(api, worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        for key, email in (("dev", f"dev@{w.domain}"), ("tara", f"tara@{w.domain}")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, email, ids[key]))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_DEV": f"dev@{w.domain}", "TEST_TARA": f"tara@{w.domain}",
           "TEST_IDS": json.dumps(ids), "PULSE_WORK_REPORT": str(tmp_path / "work2.json")}
    p = subprocess.run(["node", "test/work2-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "work2.json").read_text())
    assert report["browserChecks"] >= 30
