"""PR-PIPELINE (1620): work events, milestones, proof-of-work scores, ideas, creatives, approvals and the weekly report,
enforced by the database under forced row security. One company's work never reaches another; one client brand never
reaches another client brand's people. Synthetic tenants and obviously fake values only."""
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

TABLES = ["pr_brand", "pr_brand_member", "pr_creative", "pr_milestone", "pr_pipeline", "pr_post_metric", "pr_pow_score",
          "pr_work_event", "pr_work_report"]


def ingest(worker, org, events):
    with worker.transaction():
        set_tenant(worker, org)
        return worker.execute("select pulse.pr_work_ingest(%s) n", (Jsonb(events),)).fetchone()["n"]


def tick(worker, org, force=True):
    with worker.transaction():
        set_tenant(worker, org)
        return worker.execute("select pulse.pr_pipeline_tick(%s) r", (force,)).fetchone()["r"]


def admin(worker, w):
    """The world's manager gets the admin role (PR Studio is for admins, leadership and AI employees)."""
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (w.org, w.manager))


def setup_brand(api, w, **p):
    body = {"name": "Synthetic Brand", "kind": "company", "industry": "software", **p}
    return one(api, w, w.manager, "select pulse.pr_brand_setup(%s) id", (Jsonb(body),))["id"]


def commits(n, prefix="SYNTH-LANE", day=None):
    at = day or datetime.now(timezone.utc) - timedelta(days=2)
    return [{"source": "commit", "key": f"git:exmp{i:04d}", "at": (at + timedelta(minutes=i)).isoformat(), "title": f"{prefix}: synthetic change {i}",
             "proof": f"git:exmp{i:04d}", "repo": "example-repo", "topic": f"lane:{prefix}", "actor": "Synthetic Bot"} for i in range(n)]


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (TABLES,)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_one_companys_work_never_reaches_another(api, worker, owner, team):
    a = team
    b = build_world(worker, owner, api)
    for w in (a, b):
        admin(worker, w)
        setup_brand(api, w, name=f"Synthetic {w.code}")
    def release(tag):
        return {"source": "release", "key": f"release:{tag}", "at": datetime.now(timezone.utc).isoformat(), "title": f"{tag} synthetic release",
                "proof": "/story", "topic": f"release:{tag}"}
    assert ingest(worker, a.org, commits(3, "ALPHA") + [release("ALPHA-v0.0.1")]) == 4
    assert ingest(worker, b.org, commits(2, "BETA") + [release("BETA-v0.0.1")]) == 3
    with worker.transaction():
        set_tenant(worker, a.org)
        titles = {r["title"] for r in worker.execute("select title from pulse.pr_work_event").fetchall()}
    assert titles and all(t.startswith("ALPHA") for t in titles)
    # The same source keys in another company are that company's own events, never merged across companies.
    assert {r["title"][:4] for r in as_(api, b, b.manager, "select title from pulse.pr_work_event")} == {"BETA"}
    # A viewer of company A, even its admin, reads nothing of B by naming B's ids.
    b_ids = [r["id"] for r in as_(api, b, b.manager, "select id from pulse.pr_work_event")]
    assert as_(api, a, a.manager, "select id from pulse.pr_work_event where id = any(%s)", (b_ids,)) == []
    tick(worker, a.org)
    tick(worker, b.org)
    for t in ("pr_milestone", "pr_brief", "pr_draft", "pr_creative", "pr_pow_score"):
        mine = as_(api, a, a.manager, f"select org_id from pulse.{t}")
        assert mine and {r["org_id"] for r in mine} == {a.org}, t
    # People outside PR Studio read nothing.
    for who in (a.editor, a.lead):
        for t in TABLES:
            assert as_(api, a, who, f"select 1 from pulse.{t}") == [], t


def test_ingest_dedupes_skips_private_and_needs_proof(api, worker, team):
    w = team
    admin(worker, w)
    # Nothing is collected while the pipeline is off.
    assert ingest(worker, w.org, commits(1)) == 0
    setup_brand(api, w)
    base = commits(2)
    assert ingest(worker, w.org, base) == 2
    rebased = [{**e, "key": e["key"] + "-rebased", "proof": e["proof"] + "-rebased"} for e in base]
    assert ingest(worker, w.org, rebased) == 0, "a rebased commit is the same work"
    bad = [{"source": "commit", "key": "git:exmp9001", "at": datetime.now(timezone.utc).isoformat(), "title": "Salary sheet for October", "proof": "git:exmp9001"},
           {"source": "commit", "key": "git:exmp9002", "at": datetime.now(timezone.utc).isoformat(), "title": "Call +91 00000 00000 back", "proof": "git:exmp9002"},
           {"source": "commit", "key": "git:exmp9003", "at": datetime.now(timezone.utc).isoformat(), "title": "No proof here", "proof": ""}]
    assert ingest(worker, w.org, bad) == 0
    with pytest.raises(psycopg.errors.CheckViolation):
        ingest(worker, w.org, [{"source": "commit", "key": "git:exmp9004", "at": datetime.now(timezone.utc).isoformat(), "title": "Bad link", "proof": "javascript:alert(1)"}])


def test_pipeline_turns_shipped_work_into_ideas_drafts_and_creatives(api, worker, team):
    w = team
    admin(worker, w)
    brand = setup_brand(api, w, postsPerWeek=2)
    done = new_task(api, w, w.editor, title="Ship the synthetic onboarding flow")
    one(api, w, w.editor, "select pulse.task_move(%s,'done') r", (done,))
    report = {"source": "lane_report", "key": "report:SYNTH-LANE:DONE", "at": datetime.now(timezone.utc).isoformat(),
              "title": "SYNTH-LANE done: a synthetic feature shipped", "detail": "DONE synthetic", "proof": "report:SYNTH-LANE.md", "topic": "lane:SYNTH-LANE", "status": "DONE"}
    ingest(worker, w.org, commits(6) + [report])
    r = tick(worker, w.org)
    assert r["enabled"] and r["collected"] >= 1 and r["ideas"] >= 1
    ideas = as_(api, w, w.manager, "select hook,angle,format,proof,brand_id from pulse.pr_brief where kind='idea'")
    assert ideas and all(i["hook"] and i["angle"] and i["format"] and i["proof"] for i in ideas)
    assert all(p["url"] for i in ideas for p in i["proof"]), "every claim links to its proof"
    drafts = as_(api, w, w.manager, "select id,plan_on,status,approval,pipeline from pulse.pr_draft where brand_id=%s", (brand,))
    assert drafts and all(d["pipeline"] and d["approval"] == "draft" for d in drafts)
    # Two posts a week land on Tuesdays and Thursdays, one a day per brand.
    planned = [d["plan_on"] for d in drafts if d["plan_on"]]
    assert planned and all(d.isoweekday() in (2, 4) for d in planned) and len(planned) == len(set(planned))
    assert as_(api, w, w.manager, "select count(*)::int n from pulse.pr_creative where status='queued'")[0]["n"] >= 1
    assert as_(api, w, w.manager, "select score from pulse.pr_pow_score where brand_id is null and person_id is null")[0]["score"] > 0
    # A second run makes nothing new.
    assert tick(worker, w.org)["ideas"] == 0


def test_approval_flow_and_client_ok_gate(api, worker, team):
    w = team
    admin(worker, w)
    setup_brand(api, w)
    ingest(worker, w.org, [{"source": "outcome", "key": "outcome:exmp1", "at": datetime.now(timezone.utc).isoformat(), "title": "Approved by the client: synthetic film",
                             "proof": "/clients/exmp", "topic": "client:exmp", "client": "Example Client Co"}])
    tick(worker, w.org)
    d = as_(api, w, w.manager, "select id,needs_client_ok from pulse.pr_draft where pipeline")[0]
    assert d["needs_client_ok"]
    # Not posted before approval, by any path.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "update pulse.pr_draft set status='posted' where id=%s", (d["id"],))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.pr_draft_move(%s,'approved')", (d["id"],))
    assert one(api, w, w.manager, "select pulse.pr_draft_move(%s,'review') a", (d["id"],))["a"] == "review"
    assert one(api, w, w.manager, "select pulse.pr_draft_move(%s,'approved') a", (d["id"],))["a"] == "approved"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.pr_draft_move(%s,'posted')", (d["id"],))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.pr_draft_move(%s,'client_ok','')", (d["id"],))
    one(api, w, w.manager, "select pulse.pr_draft_move(%s,'client_ok','Synthetic: OK by e-mail') a", (d["id"],))
    assert one(api, w, w.manager, "select pulse.pr_draft_move(%s,'posted',null,'https://example.com/post/1') a", (d["id"],))["a"] == "posted"
    one(api, w, w.manager, "insert into pulse.pr_post_metric(org_id,draft_id,recorded_on,impressions,reactions) values(pulse.current_org(),%s,current_date,1234,56) returning id", (d["id"],))


def test_an_ai_employee_cannot_approve(api, worker, team):
    w = team
    admin(worker, w)
    setup_brand(api, w)
    bot = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic PR Bot','agent')", (bot, w.org))
    ingest(worker, w.org, commits(6, "GAMMA") + [{"source": "release", "key": "release:exmp", "at": datetime.now(timezone.utc).isoformat(), "title": "Synthetic v0.0.1",
                                                  "proof": "/story", "topic": "release:v0.0.1"}])
    tick(worker, w.org)
    d = as_(api, w, bot, "select id from pulse.pr_draft where pipeline limit 1")[0]["id"]
    assert one(api, w, bot, "select pulse.pr_draft_move(%s,'review') a", (d,))["a"] == "review"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, bot, "select pulse.pr_draft_move(%s,'approved')", (d,))


def test_client_brands_never_see_each_other(api, worker, team):
    w = team
    admin(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        c1 = worker.execute("insert into pulse.client(org_id,display_name) values(%s,'Example Client One') returning id", (w.org,)).fetchone()["id"]
        c2 = worker.execute("insert into pulse.client(org_id,display_name) values(%s,'Example Client Two') returning id", (w.org,)).fetchone()["id"]
    x = setup_brand(api, w, name="Client One Brand", kind="client", clientId=str(c1), approvers=[str(w.editor)])
    y = setup_brand(api, w, name="Client Two Brand", kind="client", clientId=str(c2), approvers=[str(w.editor2)])
    ingest(worker, w.org, [{**e, "brand": str(x)} for e in commits(6, "ONE")] + [{**e, "key": e["key"] + "y", "brand": str(y)} for e in commits(6, "TWO")])
    tick(worker, w.org)
    for who, mine, other in ((w.editor, x, y), (w.editor2, y, x)):
        for t in ("pr_brand", "pr_milestone", "pr_creative", "pr_draft"):
            col = "id" if t == "pr_brand" else "brand_id"
            seen = {r[col] for r in as_(api, w, who, f"select {col} from pulse.{t}")}
            assert seen == {mine}, (t, seen)
        assert as_(api, w, who, "select id from pulse.pr_brief where brand_id=%s", (other,)) == []
    # An approver approves, but never edits the brand's settings.
    assert as_(api, w, w.editor, "update pulse.pr_brand set name='Changed' where id=%s returning id", (x,)) == []
    # Someone on no brand sees none.
    assert as_(api, w, w.lead, "select id from pulse.pr_brand") == []


def test_plan_limits_brands(api, worker, owner, team):
    w = team
    admin(worker, w)
    with owner.transaction():
        owner.execute("insert into pulse_priv.platform_plan(for_org,plan) values(%s,'trial')", (w.org,))
    lim = one(api, w, w.manager, "select pulse.pr_limits() l")["l"]
    for i in range(lim["brands"] - lim["used"]["brands"]):
        setup_brand(api, w, name=f"Synthetic {i}")
    with pytest.raises(psycopg.errors.ConfigurationLimitExceeded):
        setup_brand(api, w, name="One too many")


def test_weekly_report_is_a_draft_until_shared_by_hand(api, worker, owner, team):
    w = team
    admin(worker, w)
    setup_brand(api, w, name="Synthetic Personal", kind="personal", ownerPersonId=str(w.manager))
    last_week = datetime.now(timezone.utc) - timedelta(days=7)
    ingest(worker, w.org, [{**e, "person": str(w.manager)} for e in commits(5, "DELTA", last_week)]
           + [{"source": "release", "key": "release:exmp2", "at": last_week.isoformat(), "title": "Synthetic v0.0.2", "proof": "/story", "topic": "release:v0.0.2", "person": str(w.manager)}])
    tick(worker, w.org)
    with worker.transaction():
        set_tenant(worker, w.org)
        rid = worker.execute("select pulse.pr_weekly_report(true) id").fetchone()["id"]
    rep = one(api, w, w.manager, "select status,body,proof from pulse.pr_work_report where id=%s", (rid,))
    assert rep["status"] == "draft" and "## Shipped" in rep["body"]
    # Another person in the company does not change it.
    assert as_(api, w, w.editor, "update pulse.pr_work_report set title='x' where id=%s returning id", (rid,)) == []
    # Share with a colleague in another company where the person's account has a seat and leads.
    other = build_world(worker, owner, api)
    admin(worker, other)
    acct = uuid.uuid4()
    with owner.transaction():
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,'Synthetic Person')", (acct, f"synth{acct.hex[:10]}"))
        owner.execute("insert into pulse_priv.account_member(account_id,member_org,person_id,kind) values(%s,%s,%s,'staff'),(%s,%s,%s,'staff')",
                      (acct, w.org, w.manager, acct, other.org, other.manager))
    with worker.transaction():
        set_tenant(worker, other.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')", (other.org, other.lead))
    targets = one(api, w, w.manager, "select pulse.pr_report_share_targets() t")["t"]
    assert [t["orgId"] for t in targets] == [str(other.org)] and {p["id"] for p in targets[0]["people"]} == {str(other.lead)}
    # Only colleagues of that company; nobody else.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.pr_report_share(%s,%s,%s)", (rid, other.org, [w.editor]))
    assert one(api, w, w.manager, "select pulse.pr_report_share(%s,%s,%s) r", (rid, other.org, [other.lead]))["r"]["shared"] == 1
    assert one(api, w, w.manager, "select status from pulse.pr_work_report where id=%s", (rid,))["status"] == "shared"
    got = as_(api, other, other.lead, "select title,kind from pulse.pr_brief where kind='report'")
    assert len(got) == 1 and got[0]["title"].startswith("What ")
    assert as_(api, other, other.editor, "select 1 from pulse.pr_brief where kind='report'") == []
