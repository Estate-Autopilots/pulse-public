"""KAZUK-REST slice 7 (1709): Learn → Training. A company's own courses (videos linked or uploaded, a short quiz with a
pass mark), assigned to a person, a side of the company (channel partners and dealers, staff …) or a work role; progress
per person per video, quiz attempts scored in the database, and who has and hasn't finished. Every table has forced row
security with the tenant policy and no grant to pulse_api: the training_* functions decide. Synthetic tenants, people,
links (video.example.test) and clips only."""
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
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, one, person

LINK = "https://video.example.test/synthetic/intro"
QUIZ = [{"prompt": "Which synthetic cable goes first?", "options": ["Red", "Blue", "Green"], "answer": 1},
        {"prompt": "Synthetic kit: how many screws?", "options": ["Two", "Four"], "answer": 0}]


def partner(worker, w, name):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'channel_partner')", (pid, w.org, name))
    return pid


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    w.founder = person(worker, w, "Synthetic Founder", "leadership")
    w.hr = person(worker, w, "Synthetic HR", "hr")
    w.member = person(worker, w, "Synthetic Member")
    w.dealer = partner(worker, w, "Synthetic Dealer One")
    w.dealer2 = partner(worker, w, "Synthetic Dealer Two")
    return w


def course(api, w, who, title="Synthetic dealer onboarding", status="draft"):
    return one(api, w, who, "select pulse.training_course_save(null,%s,'Fake course for tests',75,%s) id", (title, status))["id"]


def setup_course(api, w):
    c = course(api, w, w.founder)
    v1 = one(api, w, w.founder, "select pulse.training_video_add(%s,'Synthetic intro',%s,'web',4) id", (c, LINK))["id"]
    v2 = one(api, w, w.founder, "select pulse.training_video_add(%s,'Synthetic clip',null,null,null,'clip.mp4','video/mp4',%s) id", (c, b"synthetic-bytes"))["id"]
    assert one(api, w, w.founder, "select pulse.training_quiz_set(%s,%s) n", (c, Jsonb(QUIZ)))["n"] == 2
    return c, v1, v2


def mine(api, w, who):
    return one(api, w, who, "select pulse.training_mine() m")["m"]


def test_managers_make_courses_and_learners_see_only_published_assigned_ones(api, world):
    w = world
    c, _, _ = setup_course(api, w)
    one(api, w, w.founder, "select pulse.training_assign(%s,'side',null,'channel_partner','2026-12-01')", (c,))
    # A draft is invisible to the people it is assigned to.
    assert mine(api, w, w.dealer) == []
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.dealer, "select pulse.training_course_get(%s)", (c,))
    one(api, w, w.hr, "select pulse.training_course_save(%s,'Synthetic dealer onboarding','Fake course for tests',75,'published')", (c,))
    # Published: every channel partner gets it; a staff member does not.
    assert [x["title"] for x in mine(api, w, w.dealer)] == ["Synthetic dealer onboarding"]
    assert mine(api, w, w.dealer)[0]["dueOn"] == "2026-12-01"
    assert [x["id"] for x in mine(api, w, w.dealer2)] == [str(c)]
    assert mine(api, w, w.member) == []
    # A role assignment reaches staff holding that role.
    one(api, w, w.founder, "select pulse.training_assign(%s,'role',null,'member',null)", (c,))
    assert [x["id"] for x in mine(api, w, w.member)] == [str(c)]
    # The learner reads the questions but never the right answers; the manager reads both.
    g = one(api, w, w.dealer, "select pulse.training_course_get(%s) c", (c,))["c"]
    assert g["manage"] is False and g["assigned"] is True and g["assignments"] is None and g["people"] is None
    assert [q["prompt"] for q in g["questions"]] == [q["prompt"] for q in QUIZ] and all("answer" not in q for q in g["questions"])
    m = one(api, w, w.founder, "select pulse.training_course_get(%s) c", (c,))["c"]
    assert [q["answer"] for q in m["questions"]] == [1, 0] and m["manage"] is True and len(m["assignments"]) == 2
    assert {"Synthetic Dealer One", "Synthetic Member"} <= {p["name"] for p in m["people"]}
    # Archived: gone from everyone's training.
    one(api, w, w.founder, "select pulse.training_course_save(%s,'Synthetic dealer onboarding','',75,'archived')", (c,))
    assert mine(api, w, w.dealer) == []


def test_only_admins_leadership_and_hr_manage(api, world):
    w = world
    c, v1, _ = setup_course(api, w)
    for sql, args in (("select pulse.training_courses()", ()), ("select pulse.training_report(%s)", (c,)),
                      ("select pulse.training_course_save(null,'Synthetic x','',70,'draft')", ()), ("select pulse.training_video_remove(%s)", (v1,)),
                      ("select pulse.training_quiz_set(%s,'[]')", (c,)), ("select pulse.training_assign(%s,'side',null,'staff',null)", (c,))):
        for who in (w.member, w.dealer):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                as_(api, w, who, sql, args)
    # pulse_api has no grant on the tables themselves: the functions are the only way in.
    for t in ("training_course", "training_question", "training_progress", "training_attempt", "training_video_file"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, w.founder, f"select count(*) from pulse.{t}")
    # Bad quizzes are refused.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.founder, "select pulse.training_quiz_set(%s,%s)", (c, Jsonb([{"prompt": "a", "options": ["x"], "answer": 0}])))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.founder, "select pulse.training_quiz_set(%s,%s)", (c, Jsonb([{"prompt": "a", "options": ["x", "y"], "answer": 3}])))
    # A link must be https.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.founder, "select pulse.training_video_add(%s,'x','http://video.example.test/a','web',null)", (c,))


def test_progress_quiz_and_who_has_finished(api, world):
    w = world
    c, v1, v2 = setup_course(api, w)
    one(api, w, w.founder, "select pulse.training_course_save(%s,'Synthetic dealer onboarding','',75,'published')", (c,))
    one(api, w, w.founder, "select pulse.training_assign(%s,'side',null,'channel_partner',null)", (c,))
    # Someone the course isn't assigned to keeps nothing.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.member, "select pulse.training_video_seen(%s,50)", (v1,))
    # The highest share is kept; 90 % counts as watched.
    assert one(api, w, w.dealer, "select pulse.training_video_seen(%s,50) r", (v1,))["r"]["percent"] == 50
    assert one(api, w, w.dealer, "select pulse.training_video_seen(%s,25) r", (v1,))["r"]["percent"] == 50
    s = one(api, w, w.dealer, "select pulse.training_video_seen(%s,90) r", (v1,))["r"]["standing"]
    assert (s["videos"], s["watched"], s["done"]) == (2, 1, False)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.dealer, "select pulse.training_video_seen(%s,101)", (v1,))
    # The uploaded clip: the learner reads it, someone else doesn't.
    assert bytes(one(api, w, w.dealer, "select bytes from pulse.training_video_file_read(%s)", (v2,))["bytes"]) == b"synthetic-bytes"
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.member, "select * from pulse.training_video_file_read(%s)", (v2,))
    one(api, w, w.dealer, "select pulse.training_video_seen(%s,100)", (v2,))
    # Quiz: half right is 50 %, below the 75 % pass mark; then all right passes and the course is done.
    r = one(api, w, w.dealer, "select pulse.training_attempt(%s,%s) r", (c, [1, 1]))["r"]
    assert (r["score"], r["passed"], r["wrong"], r["standing"]["done"]) == (50, False, [2], False)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.dealer, "select pulse.training_attempt(%s,%s)", (c, [1]))
    r = one(api, w, w.dealer, "select pulse.training_attempt(%s,%s) r", (c, [1, 0]))["r"]
    assert (r["score"], r["passed"], r["standing"]["done"], r["standing"]["best"], r["standing"]["tries"]) == (100, True, True, 100, 2)
    # HR sees who has and hasn't finished, not-done first; each learner sees only their own attempts.
    rep = one(api, w, w.hr, "select pulse.training_report(%s) r", (c,))["r"]
    assert [(p["name"], p["standing"]["done"]) for p in rep] == [("Synthetic Dealer Two", False), ("Synthetic Dealer One", True)]
    assert mine(api, w, w.dealer2)[0]["standing"]["tries"] == 0
    rows = one(api, w, w.founder, "select pulse.training_courses() c")["c"]
    assert [(x["people"], x["done"], x["videos"], x["questions"]) for x in rows] == [(2, 1, 2, 2)]
    # Five tries a minute at most.
    for _ in range(3):
        one(api, w, w.dealer, "select pulse.training_attempt(%s,%s)", (c, [0, 0]))
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        as_(api, w, w.dealer, "select pulse.training_attempt(%s,%s)", (c, [0, 0]))


def test_training_is_kept_within_its_company(api, worker, owner, world):
    w = world
    c, v1, _ = setup_course(api, w)
    one(api, w, w.founder, "select pulse.training_course_save(%s,'Synthetic dealer onboarding','',75,'published')", (c,))
    one(api, w, w.founder, "select pulse.training_assign(%s,'side',null,'channel_partner',null)", (c,))
    other = build_world(worker, owner, api)
    other.founder = person(worker, other, "Synthetic Other Founder", "leadership")
    other.dealer = partner(worker, other, "Synthetic Other Dealer")
    # Another company's leader and dealers see none of it, by id or in their lists.
    assert one(api, other, other.founder, "select pulse.training_courses() c")["c"] == []
    assert mine(api, other, other.dealer) == []
    for sql in ("select pulse.training_course_get(%s)", "select pulse.training_report(%s)"):
        with pytest.raises(psycopg.errors.NoDataFound):
            as_(api, other, other.founder, sql, (c,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, other, other.dealer, "select pulse.training_video_seen(%s,100)", (v1,))
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, other, other.founder, "select pulse.training_video_remove(%s)", (v1,))
    # Under forced row security even the schema owner reads only the tenant set on the transaction.
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, other.org)
        for t in ("training_course", "training_video", "training_video_file", "training_question", "training_assignment"):
            assert owner.execute(f"select count(*) n from pulse.{t}").fetchone()["n"] == 0, t
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse.training_course").fetchone()["n"] == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            owner.execute("insert into pulse.training_course(org_id,title) values(%s,'Synthetic smuggled')", (other.org,))


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_training_in_the_browser(api, worker, world):
    """services/api/test/kazuk-rest-training-browser-runner.mjs: managing a course (new course, a linked video, the quiz,
    who has finished) and taking it (My training, the course, I watched it, the quiz), at 1440 and 390, light and dark
    (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = world
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in ((w.founder, "founder"), (w.member, "member")):
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    c, _, _ = setup_course(api, w)
    one(api, w, w.founder, "select pulse.training_course_save(%s,'Synthetic dealer onboarding','A fake course: the starter kit, step by step.',75,'published')", (c,))
    one(api, w, w.founder, "select pulse.training_assign(%s,'side',null,'channel_partner','2026-12-01')", (c,))
    one(api, w, w.founder, "select pulse.training_assign(%s,%s,%s,null,null)", (c, "person", w.member))
    one(api, w, w.dealer, "select pulse.training_video_seen(v.id,100) from (select (x->>'id')::uuid id from jsonb_array_elements(pulse.training_course_get(%s)->'videos') x) v", (c,))
    one(api, w, w.dealer, "select pulse.training_attempt(%s,%s)", (c, [1, 0]))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"org": str(w.org), "course": str(c)}),
           "TEST_EMAILS": json.dumps({"founder": f"founder@{w.domain}", "member": f"member@{w.domain}"})}
    p = subprocess.run(["node", "test/kazuk-rest-training-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    # What the walk did is kept: the member's quiz pass and the manager's new course.
    assert one(api, w, w.member, "select pulse.training_mine() m")["m"][0]["standing"]["passed"] is True
    assert any(x["title"] == "Synthetic safety refresher" for x in one(api, w, w.founder, "select pulse.training_courses() c")["c"])
