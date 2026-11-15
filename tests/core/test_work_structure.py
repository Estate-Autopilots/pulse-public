"""UX-TASKS: client projects and their fulfilment, internal projects, the rule matrix, asks, mentions and watchers,
enforced by the database under row-level security. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)


def save_project(api, w, who, project_id=None, **fields):
    return one(api, w, who, "select pulse.work_project_save(%s,%s) r", (project_id, Jsonb(fields)))["r"]


def ask(api, w, who, kind, to=None, task=None, project=None, note=None):
    return one(api, w, who, "select pulse.work_ask_create(%s,%s,%s,%s,%s) id", (kind, task, project, to, note))["id"]


def answer(api, w, who, ask_id, accept, note=None):
    return one(api, w, who, "select pulse.work_ask_answer(%s,%s,%s) r", (ask_id, accept, note))["r"]


def client_project(worker, w, title="Northstar launch", client=None):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,client_id) values(%s,%s,%s,%s,%s,%s)", (pid, w.org, no, title, title, client))
    return pid


def test_every_client_project_has_one_fulfilment_and_rules_have_safe_defaults(api, worker, team):
    w = team
    # The world's project and any new package get their fulfilment automatically, sharing the package's id.
    pkg = client_project(worker, w)
    rows = as_(api, w, w.editor, "select project_id,kind from pulse.work_project where project_id in (%s,%s) order by kind", (w.project, pkg))
    assert {r["project_id"] for r in rows} == {w.project, pkg} and {r["kind"] for r in rows} == {"fulfilment"}
    rules = one(api, w, w.editor, "select pulse.work_rules() r")["r"]
    assert rules["role"] == "member" and rules["canEdit"] is False
    assert rules["scopes"] == {"task.assign": "self", "task.ask": "anyone", "project.create": "none"}
    assert one(api, w, w.editor2, "select pulse.work_role() r")["r"] == "pod_head"
    assert one(api, w, w.lead, "select pulse.work_role() r")["r"] == "hr"
    assert one(api, w, w.manager, "select pulse.work_role() r")["r"] == "leadership"
    assert one(api, w, w.lead, "select pulse.work_rules() r")["r"]["canEdit"] is True
    # Leadership's row cannot be narrowed and nobody is widened past the limits; members cannot change the matrix.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="safe limits"):
        as_(api, w, w.lead, "select pulse.work_rule_set('pod_head','task.assign','anyone')")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.work_rule_set('leadership','task.assign','self')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_rule_set('member','task.assign','pod')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.work_rule_set('member','task.assign','pod')")


def test_assignment_follows_the_matrix(api, worker, team):
    w = team
    mine = new_task(api, w, w.editor, title="Colour grade the teaser")
    # Default: a member gives work only to themselves (RT1), a pod head to the pod, HR and leadership to anyone.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (mine, Jsonb({"assigneeId": str(w.editor2)})))
    # HR widens members to their own pod: now the member assigns inside Pod 1, never to Pod 2.
    as_(api, w, w.lead, "select pulse.work_rule_set('member','task.assign','pod')")
    as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (mine, Jsonb({"assigneeId": str(w.editor2)})))
    assert one(api, w, w.editor2, "select assignee_person_id a from pulse.task where id=%s", (mine,))["a"] == w.editor2
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        new_task(api, w, w.editor, title="Outside the pod", assigneeId=str(w.outsider))
    # HR narrows pod heads to themselves: the pod head can no longer assign to the pod.
    as_(api, w, w.lead, "select pulse.work_rule_set('pod_head','task.assign','self')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        new_task(api, w, w.editor2, title="Cut the reel", assigneeId=str(w.editor))
    # Leadership is fixed: an admin still assigns to anyone.
    assert new_task(api, w, w.manager, title="Anyone, anywhere", assigneeId=str(w.outsider))
    changed = one(api, w, w.editor, "select pulse.work_rules() r")["r"]["cells"]
    assert {(c["role"], c["action"]): c["scope"] for c in changed}[("pod_head", "task.assign")] == "self"


def test_projects_internal_and_fulfilment(api, worker, team):
    w = team
    # Members create no projects by default; a pod head creates in their own pod; leadership anywhere.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save_project(api, w, w.editor, name="Brand refresh", type="internal")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save_project(api, w, w.editor2, name="Pod 2 clean-up", type="internal", pod="Pod 2")
    r = save_project(api, w, w.editor2, name="Pod 1 playbook", type="internal", memberIds=[str(w.editor), str(w.outsider)],
                     startsOn="2026-10-12", dueOn="2026-10-30", templateKey="initiative")
    pid = uuid.UUID(r["id"])
    # Inside the pod people join at once and are told; the outsider is invited and decides.
    assert (r["added"], r["invited"], r["steps"]) == (1, 1, 4)
    wp = one(api, w, w.editor, "select kind,owner_id,pod,status,set_up_at is not null up from pulse.work_project where project_id=%s", (pid,))
    assert wp == {"kind": "internal", "owner_id": w.editor2, "pod": "Pod 1", "status": "active", "up": True}
    assert one(api, w, w.editor, "select kind,registry_no>0 ok from pulse.project where id=%s", (pid,)) == {"kind": "internal", "ok": True}
    assert [n["subject_id"] for n in notes(worker, w, w.editor, "project.added")] == [pid]
    steps = as_(api, w, w.editor, "select title,position,(due_at at time zone 'Asia/Kolkata')::date::text due from pulse.task where project_id=%s order by position", (pid,))
    assert [s["title"] for s in steps] == ["Scope", "Build", "Review", "Launch"] and steps[-1]["due"] == "2026-10-30"
    # A member of the project sees its tasks; the outsider does not until they accept the invitation.
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.task where project_id=%s", (pid,))["n"] == 0
    invite = one(api, w, w.outsider, "select id from pulse.work_ask where project_id=%s and to_id=%s", (pid, w.outsider))["id"]
    assert notes(worker, w, w.outsider, "project.ask")[-1]["subject_id"] == invite
    answer(api, w, w.outsider, invite, True)
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.task where project_id=%s", (pid,))["n"] == 4
    assert notes(worker, w, w.editor2, "ask.answered")[-1]["subject_id"] == invite
    # Setting up a client project's fulfilment: once. The member cannot; the pod head can, claiming it into the pod.
    pkg = client_project(worker, w, "Riverside villas")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save_project(api, w, w.editor, type="fulfilment", clientProjectId=str(pkg))
    r = save_project(api, w, w.editor2, type="fulfilment", clientProjectId=str(pkg), dueOn="2026-11-15", templateKey="video")
    assert r["id"] == str(pkg) and r["steps"] == 4
    assert one(api, w, w.editor, "select pod,owner_id from pulse.work_project where project_id=%s", (pkg,)) == {"pod": "Pod 1", "owner_id": w.editor2}
    with pytest.raises(psycopg.errors.UniqueViolation):
        save_project(api, w, w.manager, type="fulfilment", clientProjectId=str(pkg))
    # Tasks given a client project live in its fulfilment (same id), so nothing about deliveries or Drive moves.
    t = new_task(api, w, w.editor, title="Drone shots", projectId=str(pkg))
    assert one(api, w, w.editor, "select project_id from pulse.task where id=%s", (t,))["project_id"] == pkg
    # Only the owner, the pod's head or leadership changes a project.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        save_project(api, w, w.outsider, pid, dueOn="2026-12-01")
    save_project(api, w, w.manager, pid, dueOn="2026-12-01")


def test_asks_take_decline_and_join(api, worker, team):
    w = team
    t = new_task(api, w, w.editor, title="Write the voice-over script", dueOn="2026-10-20")
    # The member cannot assign a pod-mate, but asks them; the person asked sees the task while the ask is open.
    a = ask(api, w, w.editor, "take", to=w.editor2, task=t, note="You know this client")
    n = notes(worker, w, w.editor2, "task.ask")
    assert n[-1]["subject_id"] == a and n[-1]["title"] == "Editor asks you to take “Write the voice-over script”" and n[-1]["href"] == f"/tasks/{t}?ask={a}"
    with pytest.raises(psycopg.errors.UniqueViolation):
        ask(api, w, w.editor, "take", to=w.editor2, task=t)
    # Only the person asked answers. Accepting makes it theirs (consent replaces the assignment rule) and the asker reviews.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        answer(api, w, w.outsider, a, True)
    assert answer(api, w, w.editor2, a, True)["status"] == "accepted"
    row = one(api, w, w.editor, "select assignee_person_id,owner_id,review_owner_id from pulse.task where id=%s", (t,))
    assert row == {"assignee_person_id": w.editor2, "owner_id": w.editor2, "review_owner_id": w.editor}
    assert notes(worker, w, w.editor, "ask.answered")[-1]["title"].startswith("Editor said yes")
    assert all(x["subject_id"] != t for x in notes(worker, w, w.editor2, "task.assigned"))   # they took it themselves
    # A decline keeps the task where it was and says why.
    t2 = new_task(api, w, w.editor, title="Book the studio")
    a2 = ask(api, w, w.editor, "take", to=w.outsider, task=t2)
    assert one(api, w, w.outsider, "select title from pulse.task where id=%s", (t2,))["title"] == "Book the studio"
    answer(api, w, w.outsider, a2, False, "On leave this week")
    assert one(api, w, w.editor, "select assignee_person_id a from pulse.task where id=%s", (t2,))["a"] == w.editor
    assert notes(worker, w, w.editor, "ask.answered")[-1]["title"].endswith("On leave this week")
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.task where id=%s", (t2,))["n"] == 0   # no longer asked
    # HR narrows members' asks to their pod: asking Pod 2 is refused.
    as_(api, w, w.lead, "select pulse.work_rule_set('member','task.ask','pod')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ask(api, w, w.editor, "take", to=w.outsider, task=t2)
    # Asking to join a project goes to its owner, who accepts.
    pid = uuid.UUID(save_project(api, w, w.manager, name="Website relaunch", type="internal", ownerId=str(w.lead))["id"])
    j = ask(api, w, w.outsider, "join", project=pid)
    assert one(api, w, w.outsider, "select to_id from pulse.work_ask where id=%s", (j,))["to_id"] == w.lead
    assert notes(worker, w, w.lead, "project.ask")[-1]["title"] == "Pod asks to join the project Website relaunch"
    answer(api, w, w.lead, j, True)
    assert one(api, w, w.outsider, "select pulse.work_project_person(%s,%s) ok", (pid, w.outsider))["ok"] is True
    # A sent ask can be withdrawn by its sender only.
    t3 = new_task(api, w, w.editor, title="Proof the brochure")
    a3 = ask(api, w, w.editor, "take", to=w.editor2, task=t3)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor2, "select pulse.work_ask_withdraw(%s)", (a3,))
    as_(api, w, w.editor, "select pulse.work_ask_withdraw(%s)", (a3,))
    assert one(api, w, w.editor, "select status from pulse.work_ask where id=%s", (a3,))["status"] == "withdrawn"


def test_mentions_comments_and_watchers(api, worker, team):
    w = team
    t = new_task(api, w, w.editor, title="Cut the reel")
    # The outsider cannot see Pod 1's task, so cannot comment on it.
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.outsider, "select pulse.work_comment_add(%s,null,'hello',%s)", (t, []))
    # A mention shares the task: the person mentioned follows it, sees it and is told.
    c = one(api, w, w.editor, "select pulse.work_comment_add(%s,null,%s,%s) id", (t, "Can you check the music rights?", [w.outsider]))["id"]
    m = notes(worker, w, w.outsider, "task.mention")
    assert m[-1]["subject_id"] == c and m[-1]["title"].startswith("Editor mentioned you on “Cut the reel”: Can you check")
    assert one(api, w, w.outsider, "select body from pulse.work_comment where id=%s", (c,))["body"] == "Can you check the music rights?"
    assert one(api, w, w.outsider, "select role from pulse.task_member where task_id=%s and person_id=%s", (t, w.outsider))["role"] == "watcher"
    # The reviewer (pod head) hears about the comment once; the author hears nothing.
    assert [x["subject_id"] for x in notes(worker, w, w.editor2, "task.comment")] == [c]
    assert notes(worker, w, w.editor, "task.comment") == []
    # Watchers hear when the task is done; the person doing it does not hear about their own work.
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (t,))
    assert notes(worker, w, w.outsider, "task.update")[-1]["title"] == "Done: Cut the reel"
    as_(api, w, w.outsider, "select pulse.work_watch(%s,null,false)", (t,))
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.task where id=%s", (t,))["n"] == 0
    # A removed comment disappears for everyone; only its author or leadership removes it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.work_comment_remove(%s)", (c,))
    as_(api, w, w.editor, "select pulse.work_comment_remove(%s)", (c,))
    assert one(api, w, w.editor2, "select count(*)::int n from pulse.work_comment where id=%s", (c,))["n"] == 0
    # Project comments need you on the project (or able to see its work).
    pid = uuid.UUID(save_project(api, w, w.editor2, name="Pod 1 rituals", type="internal")["id"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.work_comment_add(null,%s,'hi',%s)", (pid, []))
    pc = one(api, w, w.editor2, "select pulse.work_comment_add(null,%s,'Weekly demo on Fridays',%s) id", (pid, [w.editor]))["id"]
    assert notes(worker, w, w.editor, "project.mention")[-1]["subject_id"] == pc


def test_review_of_unplaced_projects_and_package_value(api, worker, team):
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        basil = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Borup Group','developer') returning id", (w.org,)).fetchone()["id"]
        company = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,'Synthetic (internal)','internal') returning id", (w.org,)).fetchone()["id"]
    no_client = client_project(worker, w, "Borup Group Maximus")
    unknown = client_project(worker, w, "Mystery folder")
    mislabelled = client_project(worker, w, "Our own website", client=company)
    first = one(api, w, w.manager, "select pulse.work_structure_backfill() r")["r"]
    again = one(api, w, w.manager, "select pulse.work_structure_backfill() r")["r"]
    assert first["noClient"] >= 2 and first["kindMismatch"] == 1 and again["noClient"] == again["kindMismatch"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_structure_backfill()")
    review = {r["project_id"]: r for r in as_(api, w, w.manager, "select id,project_id,reason,detail from pulse.work_review where status='pending'")}
    assert review[no_client]["detail"]["suggestedClient"] == "Borup Group" and "suggestedClientId" not in review[unknown]["detail"]
    assert review[mislabelled]["reason"] == "client_kind"
    # Only leadership and HR see the review list; only leadership decides, in one click each.
    assert as_(api, w, w.editor, "select id from pulse.work_review") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.work_review_decide(%s,'internal')", (review[unknown]["id"],))
    as_(api, w, w.manager, "select pulse.work_review_decide(%s,'client',%s)", (review[no_client]["id"], basil))
    as_(api, w, w.manager, "select pulse.work_review_decide(%s,'internal')", (review[mislabelled]["id"],))
    assert one(api, w, w.editor, "select client_id from pulse.project where id=%s", (no_client,))["client_id"] == basil
    assert one(api, w, w.editor, "select p.kind,wp.kind wk from pulse.project p join pulse.work_project wp on wp.project_id=p.id where p.id=%s", (mislabelled,)) == {"kind": "internal", "wk": "internal"}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.work_review_decide(%s,'internal')", (review[no_client]["id"],))
    # The package value is for leadership only.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.client_project_save(%s,%s)", (no_client, Jsonb({"valueAmount": "250000"})))
    as_(api, w, w.manager, "select pulse.client_project_save(%s,%s)", (no_client, Jsonb({"valueAmount": "250000", "scope": "4 videos a month", "startsOn": "2026-10-01", "endsOn": "2027-03-31"})))
    assert one(api, w, w.manager, "select pulse.client_project_value(%s) v", (no_client,))["v"] == {"amount": 250000, "currency": "INR"}
    assert one(api, w, w.lead, "select pulse.client_project_value(%s) v", (no_client,))["v"] is None
    assert one(api, w, w.editor, "select scope from pulse.project where id=%s", (no_client,))["scope"] == "4 videos a month"


def test_set_visibility_matches_the_row_rule_for_every_role(api, worker, team):
    """0145's task_visible_ids() (one set per query) answers exactly as task_visible_row() (one call per row)."""
    w = team
    a = new_task(api, w, w.editor, title="Mine")
    b = new_task(api, w, w.lead, title="Pod Two work", assigneeId=str(w.outsider))
    as_(api, w, w.lead, "select pulse.task_block(%s,%s)", (a, b))
    new_task(api, w, w.outsider, title="Sub of Pod Two work", parentId=str(b))
    new_task(api, w, w.manager, title="Nobody's yet", assigneeId=None)
    pid = uuid.UUID(save_project(api, w, w.manager, name="Shared work", type="internal", ownerId=str(w.outsider), memberIds=[str(w.editor2)])["id"])
    new_task(api, w, w.outsider, title="Project step", projectId=str(pid))
    asked = new_task(api, w, w.editor2, title="Asked across pods")
    ask(api, w, w.editor2, "take", to=w.outsider, task=asked)
    watched = new_task(api, w, w.editor2, title="Watched")
    one(api, w, w.editor2, "select pulse.work_comment_add(%s,null,'fyi',%s) id", (watched, [w.outsider]))
    for who in (w.editor, w.editor2, w.outsider, w.lead, w.manager):
        with worker.transaction():
            set_tenant(worker, w.org, who)
            rows = {r["id"] for r in worker.execute("select id from pulse.task t where pulse.task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id)")}
            sets = {r["id"] for r in worker.execute("select pulse.task_visible_ids() id")}
        seen = {r["id"] for r in as_(api, w, who, "select id from pulse.task")}
        assert rows == sets == seen, who


WORK_API = r'''
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const call = async (url, email, payload) => { const r = await app.inject({ url, method: payload ? 'POST' : 'GET', headers: { 'cf-access-authenticated-user-email': email }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, body: r.json() }; };
const ok = (cond, label, extra) => { if (!cond) { console.error('FAILED', label, JSON.stringify(extra ?? '').slice(0, 800)); process.exit(1); } };
const member = process.env.TEST_MEMBER, head = process.env.TEST_HEAD, outsider = process.env.TEST_OUTSIDER_EMAIL, admin = 'admin@estateautopilots.com', hr = 'hr@estateautopilots.com';
const E = JSON.parse(process.env.TEST_IDS);
// The Create dialog: who you can assign at once, projects, templates, rules.
let r = await call('/api/v0/work/options', member);
ok(r.status === 200 && r.body.roleLabel === 'Members' && r.body.canCreateProject === false && r.body.templates.length === 5, 'member options', r);
ok(r.body.people.find((p) => p.id === E.head).canAssign === false && r.body.people.find((p) => p.id === E.member).canAssign === true, 'member assigns only themselves', r.body.people);
r = await call('/api/v0/work/options', head);
ok(r.status === 200 && r.body.people.find((p) => p.id === E.member).canAssign === true && r.body.people.find((p) => p.id === E.outsider).canAssign === false && r.body.canCreateProject, 'pod head options', r);
// Three fields and Enter: assigned when allowed (and the assignee is told), asked when not.
r = await call('/api/v0/work/tasks', head, { title: 'Cut the teaser', assigneeId: E.member, dueOn: '2026-10-16', priority: 'high' });
ok(r.status === 200 && r.body.assigned === true && r.body.asked === null, 'pod head assigns', r);
r = await call('/api/v0/work/tasks', member, { title: 'Check the music licence', assigneeId: E.outsider });
ok(r.status === 200 && r.body.assigned === false && r.body.asked?.id, 'member asks instead', r); const ask = r.body.asked.id, asked = r.body.id;
r = await call('/api/v0/work/asks', outsider);
ok(r.status === 200 && r.body.incoming.length === 1 && r.body.incoming[0].actions.map((a) => a.key).join() === 'accept,decline' && r.body.incoming[0].title.includes('asks you to take'), 'incoming ask with actions', r);
r = await call('/api/v0/work/notices', outsider);
const card = r.body.rows.find((n) => n.eventType === 'task.ask');
ok(r.status === 200 && card && card.actions[0].path === `/api/v0/work/asks/${ask}/accept` && card.from.id === E.member, 'notification card contract', r);
r = await call(card.actions[0].path, outsider, {});
ok(r.status === 200 && r.body.status === 'accepted', 'accept from the card', r);
r = await call(`/api/v0/tasks/${asked}`, member);
ok(r.status === 200 && r.body.task.assigneeId === E.outsider && r.body.task.reviewerId === E.member, 'taken, asker reviews', r);
// Projects: create with a template, list, open, people.
r = await call('/api/v0/work/projects', member, { type: 'internal', name: 'Not allowed' });
ok(r.status === 403, 'member cannot create a project', r);
r = await call('/api/v0/work/projects', head, { type: 'internal', name: 'Pod 1 playbook', templateKey: 'initiative', memberIds: [E.member], dueOn: '2026-10-31' });
ok(r.status === 200 && r.body.steps === 4 && r.body.added === 1, 'pod head creates a project', r); const pid = r.body.id;
r = await call('/api/v0/work/projects?kind=internal', member);
ok(r.status === 200 && r.body.rows.some((p) => p.id === pid && p.open === 4 && p.kind === 'internal'), 'project list', r);
r = await call(`/api/v0/tasks/projects/${pid}`, member);
ok(r.status === 200 && r.body.work.kind === 'internal' && r.body.work.members.length === 1 && r.body.tasks.length === 4, 'project page data', r);
r = await call(`/api/v0/work/projects/${pid}/people`, member, { add: [E.outsider] });
ok(r.status === 200 && r.body.invited === 1, 'a member invites, does not add', r);
// Comments with mentions, watching.
r = await call('/api/v0/work/comments', member, { taskId: asked, body: 'Thanks! Loop in the head', mentions: [E.head] });
ok(r.status === 200, 'comment', r);
r = await call(`/api/v0/work/comments?task=${asked}`, head);
ok(r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].people[0].id === E.head, 'mentioned person reads it', r);
r = await call('/api/v0/work/watch', head, { taskId: asked, on: false });
ok(r.status === 200, 'unwatch', r);
// Rules: readable by all, set by HR within limits.
r = await call('/api/v0/work/rules', member);
ok(r.status === 200 && r.body.canEdit === false && r.body.cells.length === 9, 'rules read', r);
r = await call('/api/v0/work/rules', member, { role: 'member', action: 'task.assign', scope: 'pod' });
ok(r.status === 403, 'member cannot set rules', r);
r = await call('/api/v0/work/rules', hr, { role: 'pod_head', action: 'task.assign', scope: 'anyone' });
ok(r.status === 400 && /safe limits/.test(r.body.error), 'outside the limits', r);
r = await call('/api/v0/work/rules', hr, { role: 'member', action: 'task.assign', scope: 'pod' });
ok(r.status === 200, 'HR widens members to their pod', r);
// Dashboard: leadership and pod heads; members are refused.
r = await call('/api/v0/work/dashboard', member);
ok(r.status === 403, 'member has no dashboard', r);
r = await call('/api/v0/work/dashboard', head);
ok(r.status === 200 && r.body.workload.some((w) => w.id === E.member) && !r.body.workload.some((w) => w.id === E.outsider) && Array.isArray(r.body.act), 'pod head dashboard is the pod', r);
r = await call('/api/v0/work/dashboard', admin);
ok(r.status === 200 && r.body.workload.some((w) => w.id === E.outsider) && r.body.throughput.length === 8, 'leadership dashboard', r);
// Review and package: leadership only.
r = await call('/api/v0/work/review', member);
ok(r.status === 403, 'review is for leadership', r);
r = await call('/api/v0/work/review', admin);
ok(r.status === 200 && Array.isArray(r.body.rows), 'review list', r);
r = await call(`/api/v0/work/package/${E.project}`, member);
ok(r.status === 200 && r.body.value === null && r.body.canEdit === false, 'package without value for members', r);
r = await call(`/api/v0/work/package/${E.project}`, admin, { scope: 'Four videos a month', valueAmount: '120000', startsOn: '2026-10-01' });
ok(r.status === 200, 'leadership edits the package', r);
r = await call(`/api/v0/work/package/${E.project}`, admin);
ok(r.status === 200 && r.body.value.amount === 120000 && r.body.scope === 'Four videos a month', 'package value for leadership', r);
console.log(JSON.stringify({ ok: true }));
await app.close(); await pool.end();
'''


def test_work_api(worker, owner, api, team):
    import json
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        for email, who in ((f"outsider@{w.domain}", w.outsider),):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, email, who))

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}",
           "TEST_IDS": json.dumps({"member": str(w.editor), "head": str(w.editor2), "outsider": str(w.outsider), "project": str(w.project)})}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "--input-type=module", "-e", WORK_API], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]


def _seed_showcase(api, worker, w):
    """A small, believable synthetic agency for the browser checks and screenshots: two pods, three clients, a client
    package without a client, internal work, a week of history, a blocker, asks and a mention. No real data."""
    from datetime import date
    import random
    rnd = random.Random(7)
    names = {w.editor: "Kabir Shah", w.editor2: "Ahoro Rao", w.outsider: "Meera Iyer", w.lead: "Neha Jivop", w.manager: "Rila Kapoor"}
    extra = {"Dev Panab": "Pod 1", "Sana Khan": "Pod 1", "Ishaan Vivim": "Pod 2", "Tara Nair": "Pod 2", "Vikram Seduh": "Pod 2"}
    ids = {}
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name in names.items():
            worker.execute("update pulse.person set display_name=%s where id=%s", (name, pid))
        for n, (name, pod) in enumerate(extra.items(), start=20):
            pid = uuid.uuid4(); ids[name] = pid
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,'Editor','test',%s,%s,%s)", (w.org, pid, n, f"user{n}x", pod))
        worker.execute("update pulse.people_profile set pod='Leadership' where person_id in (%s,%s)", (w.manager, w.lead))
        clients = {}
        for cname in ("Northstar Developers", "Lakeview Homes", "Sunrise Realty"):
            clients[cname] = worker.execute("insert into pulse.client(org_id,display_name,client_type) values(%s,%s,'developer') returning id", (w.org, cname)).fetchone()["id"]
        pkgs = {}
        for title, cname in (("Northstar Heights", "Northstar Developers"), ("Lakeview Villas", "Lakeview Homes"), ("Sunrise Towers", "Sunrise Realty"), ("Harbour Point", None)):
            no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
            pkgs[title] = worker.execute("insert into pulse.project(org_id,registry_no,name,title,client_id,start_month) values(%s,%s,%s,%s,%s,date_trunc('month',now())::date) returning id",
                                         (w.org, no, title, title, clients.get(cname))).fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.hr_pod_set('Pod 2',%s,%s)", (ids["Vikram Seduh"], [w.outsider, ids["Ishaan Vivim"], ids["Tara Nair"], ids["Vikram Seduh"]]))
        api.execute("select pulse.hr_pod_set('Pod 1',%s,%s)", (w.editor2, [w.editor, w.editor2, ids["Dev Panab"], ids["Sana Khan"]]))
    soon = lambda d: (date.today().toordinal() + d)  # noqa: E731
    day = lambda d: date.fromordinal(soon(d)).isoformat()  # noqa: E731
    north = save_project(api, w, w.editor2, type="fulfilment", clientProjectId=str(pkgs["Northstar Heights"]), startsOn=day(-10), dueOn=day(12), templateKey="video",
                         memberIds=[str(w.editor), str(ids["Dev Panab"])])
    save_project(api, w, w.manager, type="fulfilment", clientProjectId=str(pkgs["Lakeview Villas"]), ownerId=str(ids["Vikram Seduh"]), startsOn=day(-20), dueOn=day(3), templateKey="campaign",
                 memberIds=[str(w.outsider), str(ids["Tara Nair"])])
    web = uuid.UUID(save_project(api, w, w.manager, type="internal", name="Website relaunch", ownerId=str(w.manager), dueOn=day(30), memberIds=[str(ids["Sana Khan"])])["id"])
    sun = pkgs["Sunrise Towers"]
    steps = {r["title"]: r["id"] for r in as_(api, w, w.manager, "select title,id from pulse.task where project_id=%s", (pkgs["Northstar Heights"],))}
    as_(api, w, w.editor2, "select pulse.task_save(%s,%s)", (steps["Shoot"], Jsonb({"assigneeId": str(w.editor)})))
    as_(api, w, w.editor2, "select pulse.task_save(%s,%s)", (steps["Edit"], Jsonb({"assigneeId": str(ids["Dev Panab"])})))
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (steps["Shoot"],))
    as_(api, w, ids["Dev Panab"], "select pulse.task_move(%s,'in_progress')", (steps["Edit"],))
    lake = {r["title"]: r["id"] for r in as_(api, w, w.manager, "select title,id from pulse.task where project_id=%s", (pkgs["Lakeview Villas"],))}
    for title, who in (("Plan the campaign", w.outsider), ("Creatives ready", ids["Tara Nair"]), ("Set up the ads", ids["Ishaan Vivim"])):
        as_(api, w, w.manager, "select pulse.task_save(%s,%s)", (lake[title], Jsonb({"assigneeId": str(who), "dueOn": day(-2) if title == "Creatives ready" else day(1)})))
    as_(api, w, w.outsider, "select pulse.task_move(%s,'done')", (lake["Plan the campaign"],))
    # Ordinary work across both pods, some late, some due this week, some finished in earlier weeks.
    work = [("Sunrise brochure copy", ids["Sana Khan"], 2, sun), ("Drone permit for Sunrise", w.editor, -3, sun), ("Model video: Sunrise lobby", ids["Dev Panab"], 4, sun),
            ("Homepage hero video", ids["Sana Khan"], 6, web), ("New pricing page", w.manager, 9, web), ("Reels for Lakeview launch", ids["Tara Nair"], 0, None),
            ("Weekly lead review", ids["Vikram Seduh"], 1, None), ("Client call notes", ids["Ishaan Vivim"], -1, None), ("Colour grade the teaser", w.editor, 2, None)]
    made = {}
    for title, who, due, project in work:
        made[title] = new_task(api, w, w.manager, title=title, assigneeId=str(who), dueOn=day(due), projectId=str(project) if project else None, priority="high" if due < 0 else "normal")
    for k in range(18):
        t = new_task(api, w, w.manager, title=f"{rnd.choice(['Edit', 'Cut', 'Design', 'Review', 'Post'])} {rnd.choice(['reel', 'carousel', 'teaser', 'ad set', 'banner'])} #{k + 1}",
                     assigneeId=str(rnd.choice([w.editor, ids['Dev Panab'], ids['Sana Khan'], w.outsider, ids['Tara Nair'], ids['Ishaan Vivim']])))
        as_(api, w, w.manager, "select pulse.task_move(%s,'done')", (t,))
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.task set done_at=now()-make_interval(days=>%s) where id=%s", (rnd.randint(0, 50), t))
    blocker = new_task(api, w, w.manager, title="Approve the Sunrise music licence", assigneeId=str(w.lead), dueOn=day(1))
    as_(api, w, w.manager, "select pulse.task_block(%s,%s,'needs the licence')", (made["Model video: Sunrise lobby"], blocker))
    new_task(api, w, w.manager, title="Location scout for Sunrise", assigneeId=None, dueOn=day(1), projectId=str(sun))
    # Asks and a mention, so My tasks, notifications and the task page have something to answer.
    ask(api, w, w.outsider, "join", project=web)
    talk = made["Drone permit for Sunrise"]
    one(api, w, w.manager, "select pulse.work_comment_add(%s,null,%s,%s) id", (talk, "The permit office wants the site plan. @Kabir Shah can you send it today?", [w.editor]))
    one(api, w, w.editor, "select pulse.work_comment_add(%s,null,%s,%s) id", (talk, "On it. Sending before lunch.", []))
    review = one(api, w, w.manager, "select pulse.work_structure_backfill() r")["r"]
    assert review["noClient"] >= 1
    harbour = one(api, w, w.manager, "select id from pulse.work_review where project_id=%s", (pkgs["Harbour Point"],))["id"]
    return {"member": str(w.editor), "head": str(w.editor2), "outsider": str(w.outsider), "project": str(w.project), "review": str(harbour),
            "fulfilment": north["id"], "task": str(talk)}


@pytest.mark.skipif(__import__("os").environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_work_screens_in_the_browser(worker, owner, api, team, tmp_path):
    import json
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"outsider@{w.domain}", w.outsider))
    ids = _seed_showcase(api, worker, w)

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_IDS": json.dumps(ids), "PULSE_WORK_REPORT": str(tmp_path / "work.json")}
    p = subprocess.run(["node", "test/work-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1500, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "work.json").read_text())
    assert report["browserChecks"] >= 30
