"""PR-STUDIO-2 (1680): PR Studio's flow (strategy, files, the creative library, posts on the calendar and the board),
enforced by the database under forced row security. One company's brands never reach another company; inside a company,
a person on one brand sees that brand only; nothing that needs someone's OK is posted before it; a posted item stays.
Synthetic tenants and obviously fake values only."""
import hashlib

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from helpers import build_world
from test_pr_pipeline import admin
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

TABLES = ["pr_asset", "pr_file", "pr_post", "pr_strategy"]
PNG = b"\x89PNG\r\n\x1a\n" + b"EXAMPLE-SYNTHETIC-IMAGE" * 4


def new_brand(owner, w, name):  # as the database owner: pulse_worker only reads pr_brand (1620)
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute("insert into pulse.pr_brand(org_id,kind,name,created_by) values(%s,'company',%s,%s) returning id",
                              (w.org, name, w.manager)).fetchone()["id"]


def strategy(api, w, brand, who=None):
    one(api, w, who or w.manager, """insert into pulse.pr_strategy(org_id,brand_id,positioning,pillars,channels,kpis,updated_by)
        values (pulse.current_org(),%s,'Example positioning (synthetic)',%s,%s,%s,pulse.current_viewer()) returning brand_id""",
        (brand, Jsonb([{"key": "build-log", "name": "Build log", "about": "Synthetic"}]),
         Jsonb([{"key": "linkedin", "perWeek": 2, "days": [2, 4], "times": ["08:30"]}]),
         Jsonb([{"label": "Posts a week", "metric": "posts_per_week", "target": 2}])))


def asset(api, w, brand, ok_state="ready", who=None, key="exmp-1"):
    f = one(api, w, who or w.manager, """insert into pulse.pr_file(org_id,brand_id,name,mime,bytes,sha256,added_by)
        values (pulse.current_org(),%s,'example-slide.png','image/png',%s,%s,pulse.current_viewer()) returning id""",
            (brand, PNG + key.encode(), hashlib.sha256(PNG + key.encode()).hexdigest()))["id"]
    return one(api, w, who or w.manager, """insert into pulse.pr_asset(org_id,brand_id,source_key,title,kind,caption,slides,ok_state,ok_who,created_by)
        values (pulse.current_org(),%s,%s,'Example creative (synthetic)','single','Example caption #Synthetic',%s,%s,'Example Partner',pulse.current_viewer()) returning id""",
               (brand, key, Jsonb([{"file": str(f), "name": "slide-1", "alt": "Example alt text"}]), ok_state))["id"]


def post(api, w, brand, asset_id=None, stage="scheduled", who=None, title="Example post (synthetic)"):
    return one(api, w, who or w.manager, """insert into pulse.pr_post(org_id,brand_id,asset_id,title,stage,channel,slot_at,created_by)
        values (pulse.current_org(),%s,%s,%s,%s,'linkedin',now()+interval '2 days',pulse.current_viewer()) returning id""",
               (brand, asset_id, title, stage))["id"]


def move(api, w, who, p, to, url=None, metrics=None):
    return one(api, w, who, "select pulse.pr_post_move(%s,%s,%s,%s) s", (p, to, url, Jsonb(metrics) if metrics is not None else None))["s"]


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pulse' and c.relname = any(%s) order by 1""", (TABLES,)).fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [(t, True, True, True) for t in TABLES]


def test_one_companys_brands_never_reach_another(api, worker, owner, team):
    a = team
    b = build_world(worker, owner, api)
    made = {}
    for w in (a, b):
        admin(worker, w)
        br = new_brand(owner, w, f"Synthetic {w.code}")
        strategy(api, w, br)
        x = asset(api, w, br)
        made[w.code] = (br, x, post(api, w, br, x))
    a_brand, a_asset, a_post = made[a.code]
    b_brand, b_asset, b_post = made[b.code]
    for t in TABLES:
        mine = as_(api, a, a.manager, f"select org_id from pulse.{t}")
        assert mine and {r["org_id"] for r in mine} == {a.org}, t
    # A's admin names B's ids and reads nothing, changes nothing.
    assert as_(api, a, a.manager, "select id from pulse.pr_post where id=%s", (b_post,)) == []
    assert as_(api, a, a.manager, "select id from pulse.pr_asset where id=%s", (b_asset,)) == []
    assert as_(api, a, a.manager, "select id from pulse.pr_file where brand_id=%s", (b_brand,)) == []
    assert as_(api, a, a.manager, "update pulse.pr_post set title='EXMP takeover' where id=%s returning id", (b_post,)) == []
    with pytest.raises(psycopg.Error):
        move(api, a, a.manager, b_post, "posted")
    with pytest.raises(psycopg.Error):
        one(api, a, a.manager, "select pulse.pr_brand_switch(%s,true)", (b_brand,))
    # Writing into another company's brand is refused.
    with pytest.raises(psycopg.Error):
        post(api, a, b_brand)
    # People outside PR Studio (no admin or leadership role, on no brand) read nothing.
    for who in (a.editor, a.lead):
        for t in TABLES:
            assert as_(api, a, who, f"select 1 from pulse.{t}") == [], t


def test_a_person_on_one_brand_sees_that_brand_only(api, worker, owner, team):
    w = team
    admin(worker, w)
    mine, other = new_brand(owner, w, "Synthetic Mine"), new_brand(owner, w, "Synthetic Other")
    for br in (mine, other):
        strategy(api, w, br)
        post(api, w, br, asset(api, w, br, key=f"exmp-{br}"[:40]))
    with owner.transaction():  # pulse_worker may not write pr_brand_member (1620)
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.pr_brand_member(org_id,brand_id,person_id,role) values(%s,%s,%s,'editor')", (w.org, mine, w.editor))
    for t in TABLES:
        seen = {r["brand_id"] for r in as_(api, w, w.editor, f"select brand_id from pulse.{t}")}
        assert seen == {mine}, t
    # An editor writes on their brand, never on the other one, and never adds an already-scheduled post.
    assert post(api, w, mine, stage="idea", who=w.editor)
    with pytest.raises(psycopg.Error):
        post(api, w, other, stage="idea", who=w.editor)
    with pytest.raises(psycopg.Error, match="manages the brand"):
        post(api, w, mine, stage="scheduled", who=w.editor)
    # An editor does not approve, and does not switch the brand on.
    p = post(api, w, mine, stage="idea", who=w.editor, title="Example idea (synthetic)")
    assert move(api, w, w.editor, p, "review") == "review"
    with pytest.raises(psycopg.Error, match="approves"):
        move(api, w, w.editor, p, "approved")
    assert move(api, w, w.manager, p, "approved") == "approved"
    with pytest.raises(psycopg.Error, match="switches it on"):
        one(api, w, w.editor, "select pulse.pr_brand_switch(%s,true)", (mine,))
    assert one(api, w, w.manager, "select pulse.pr_brand_switch(%s,true) s", (mine,))["s"] == "on"
    # The strategy's status changes only through the switch.
    with pytest.raises(psycopg.Error):
        as_(api, w, w.manager, "update pulse.pr_strategy set status='draft' where brand_id=%s", (mine,))


def test_nothing_is_posted_before_its_ok_and_a_posted_item_stays(api, worker, owner, team):
    w = team
    admin(worker, w)
    br = new_brand(owner, w, "Synthetic Gates")
    strategy(api, w, br)
    needs = asset(api, w, br, ok_state="needs_ok", key="exmp-needs")
    p = post(api, w, br, needs)
    # Stage moves go through the function: the API role cannot write a stage directly.
    with pytest.raises(psycopg.Error):
        as_(api, w, w.manager, "update pulse.pr_post set stage='posted' where id=%s", (p,))
    with pytest.raises(psycopg.Error, match="OK first"):
        move(api, w, w.manager, p, "posted", "https://example.invalid/post/1")
    with pytest.raises(psycopg.Error, match="how they gave"):
        one(api, w, w.manager, "select pulse.pr_asset_ok(%s,'')", (needs,))
    assert one(api, w, w.manager, "select pulse.pr_asset_ok(%s,'by e-mail on 1 Jan (synthetic)') at", (needs,))["at"]
    with pytest.raises(psycopg.Error, match="https"):
        move(api, w, w.manager, p, "posted", "http://example.invalid/post/1")
    assert move(api, w, w.manager, p, "posted", "https://example.invalid/post/1") == "posted"
    with pytest.raises(psycopg.Error, match="whole numbers"):
        move(api, w, w.manager, p, "measured", metrics={"impressions": "-5"})
    assert move(api, w, w.manager, p, "measured", metrics={"impressions": 1200, "reactions": 34}) == "measured"
    row = one(api, w, w.manager, "select stage,posted_at,posted_url,metrics from pulse.pr_post where id=%s", (p,))
    assert row["stage"] == "measured" and row["posted_at"] and row["metrics"] == {"impressions": 1200, "reactions": 34}
    # Posted stays posted: not moved back, not rescheduled, not removed.
    with pytest.raises(psycopg.Error, match="posted already"):
        move(api, w, w.manager, p, "draft")
    with pytest.raises(psycopg.Error, match="posted already"):
        as_(api, w, w.manager, "update pulse.pr_post set slot_at=now() where id=%s", (p,))
    assert as_(api, w, w.manager, "delete from pulse.pr_post where id=%s returning id", (p,)) == []
    # An idea is not posted without approval; a scheduled slot needs a time.
    idea = post(api, w, br, stage="idea", title="Example unapproved (synthetic)")
    with pytest.raises(psycopg.Error, match="Approve it"):
        move(api, w, w.manager, idea, "posted")
    with pytest.raises(psycopg.Error):
        one(api, w, w.manager, "insert into pulse.pr_post(org_id,brand_id,title,stage) values (pulse.current_org(),%s,'Example no slot','scheduled') returning id", (br,))
    # A creative from another brand's library cannot be attached.
    other = new_brand(owner, w, "Synthetic Elsewhere")
    with pytest.raises(psycopg.Error, match="library"):
        post(api, w, other, needs)
