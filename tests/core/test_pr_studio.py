"""PR-STUDIO (1597): the Story, briefs, audiences and drafts, enforced by the database under forced row security (admins,
leadership and AI employees use PR Studio; a person reads briefs written for them), and the collector that turns the
company's records into Story lines. Synthetic tenants only."""
import psycopg
import pytest
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

TABLES = ["pr_audience", "pr_brief", "pr_chapter", "pr_draft", "pr_story"]
TODAY = "(now() at time zone pulse.org_time_zone())::date"


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (TABLES,)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_only_admins_leadership_and_ai_use_pr_studio(api, worker, team):
    w = team
    assert one(api, w, w.manager, "select pulse.pr_can() v")["v"] is True
    for who in (w.editor, w.lead, w.outsider):
        assert one(api, w, who, "select pulse.pr_can() v")["v"] is False
    aud = one(api, w, w.manager, "insert into pulse.pr_audience(org_id,name,tone,channel,ratio,created_by) values(pulse.current_org(),'Synthetic testers','bold','telegram','9:16',pulse.current_viewer()) returning id")["id"]
    line = one(api, w, w.manager, f"insert into pulse.pr_story(org_id,happened_on,kind,title,created_by) values(pulse.current_org(),{TODAY},'feature','Synthetic feature landed',pulse.current_viewer()) returning id")["id"]
    one(api, w, w.manager, "insert into pulse.pr_draft(org_id,audience_id,entry_ids,headline,created_by) values(pulse.current_org(),%s,%s,'New: synthetic feature',pulse.current_viewer()) returning id", (aud, [line]))
    # Everyone else reads nothing and writes nothing.
    for who in (w.editor, w.lead):
        for t in TABLES:
            assert as_(api, w, who, f"select 1 from pulse.{t}") == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, f"insert into pulse.pr_story(org_id,happened_on,kind,title) values(pulse.current_org(),{TODAY},'note','x') returning id")
        assert as_(api, w, who, "update pulse.pr_story set title='changed' where id=%s returning id", (line,)) == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.pr_collect(current_date - 1, current_date)")
    # Values outside the lists are refused by the table itself.
    with pytest.raises(psycopg.errors.CheckViolation):
        as_(api, w, w.manager, "insert into pulse.pr_audience(org_id,name,channel) values(pulse.current_org(),'Bad','fax') returning id")


def test_a_person_reads_the_briefs_written_for_them(api, worker, team):
    w = team
    mine = one(api, w, w.manager, f"""insert into pulse.pr_brief(org_id,kind,person_id,day,title,body,written_by,author_id)
        values(pulse.current_org(),'morning',%s,{TODAY},'Good morning','*Since yesterday:* 3 tasks done.','person',pulse.current_viewer()) returning id""", (w.editor,))["id"]
    company = one(api, w, w.manager, f"""insert into pulse.pr_brief(org_id,kind,day,title,body) values(pulse.current_org(),'evening',{TODAY},'Today','Done today') returning id""")["id"]
    assert {r["id"] for r in as_(api, w, w.editor, "select id from pulse.pr_brief")} == {mine}
    assert as_(api, w, w.outsider, "select id from pulse.pr_brief") == []
    assert {r["id"] for r in as_(api, w, w.manager, "select id from pulse.pr_brief")} >= {mine, company}
    # Only PR Studio's users write briefs, even for themselves.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, f"insert into pulse.pr_brief(org_id,kind,person_id,day,title,body) values(pulse.current_org(),'update',%s,{TODAY},'x','y') returning id", (w.editor,))


def test_the_collector_tells_tasks_done_once_and_keeps_edits(api, worker, team):
    w = team
    a = new_task(api, w, w.editor, title="Cut the synthetic reel")
    b = new_task(api, w, w.editor, title="Colour the synthetic reel")
    p = new_task(api, w, w.editor, title="Salary sheet for October")  # private-looking: never told
    for t in (a, b, p):
        one(api, w, w.editor, "select pulse.task_move(%s,'done') r", (t,))
    rng = f"{TODAY} - 1, {TODAY}"
    assert one(api, w, w.manager, f"select pulse.pr_collect({rng}) n")["n"] >= 1
    rows = as_(api, w, w.manager, "select id,title,body,kind from pulse.pr_story where kind='task'")
    assert len(rows) == 1 and rows[0]["title"].startswith("2 tasks done")
    assert "Cut the synthetic reel" in rows[0]["body"] and "Salary" not in rows[0]["body"]
    # Running again adds nothing; an edited line is kept as written even when more work is done that day.
    assert one(api, w, w.manager, f"select pulse.pr_collect({rng}) n")["n"] == 0
    one(api, w, w.manager, "update pulse.pr_story set title='Two reels finished',edited=true where id=%s returning id", (rows[0]["id"],))
    c = new_task(api, w, w.editor, title="Export the synthetic reel")
    one(api, w, w.editor, "select pulse.task_move(%s,'done') r", (c,))
    one(api, w, w.manager, f"select pulse.pr_collect({rng}) n")
    assert one(api, w, w.manager, "select title from pulse.pr_story where id=%s", (rows[0]["id"],))["title"] == "Two reels finished"
    # At most 92 days at a time.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, f"select pulse.pr_collect({TODAY} - 200, {TODAY})")
