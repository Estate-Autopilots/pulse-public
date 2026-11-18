"""PM-BUILD-2 (18 Nov 2026; KAZUK-PM-2 phase 2, migration 2310): a delivery plan built from what was bought, by whom.
Steps with catalogue codes are made only when a line with one of them was bought (a part removed from its package is
not bought), the step that delivers a bought thing takes its per-unit tasks, the package comes from the codes; an add-on
paid later adds its steps on its own purchase day and moves no other date; who does what (a holder takes the role's
steps, "nobody" leaves them out and they come back); conditions; repeating steps one card per time; what we promised
(sales sets it, anyone else proposes and sales confirms, nobody confirms their own); date moves by the template's
reasons and only by the lead (leadership steps in, logged; a go-live move tells the heads); a restart moves only what
the pause stopped; a project's chat groups linked by the person running it. Synthetic tenants only; nothing is sent."""
import uuid
from datetime import timedelta

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_plan_clocks import ai, org_today
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

# A small company's template in format 3 with phase 2's fields (generic words; the shape of Estate Autopilots' v4).
TPL = {
    "format": 3,
    "stages": [{"n": 0, "key": "s0", "label": "Getting ready"}, {"n": 1, "key": "s1", "label": "Making"}, {"n": 2, "key": "s2", "label": "Running"}],
    "packages": [{"key": "small", "label": "Small", "lines": ["T-PKG-SMALL"]}, {"key": "full", "label": "Full", "lines": ["T-PKG-FULL"]}],
    "categories": [{"key": "big", "label": "Big", "units": 1}],
    "bandwidth": {"role": "Lead", "short": "Lead", "healthy": [3, 5], "max": 6},
    "milestones": {"adsLive": "G2"},
    "clocks": [{"key": "start", "label": "Paid", "day": -3}, {"key": "day0", "label": "Ready", "step": "G1"},
               {"key": "live", "label": "Live", "step": "G2"}, {"key": "bought", "label": "Bought on"}],
    "windows": [{"key": "claim", "label": "Claim window", "from": "live", "start": 30, "end": 45}],
    "conditions": [{"key": "realBuyers", "label": "Real buyers exist"}],
    "moveDates": "lead",
    "reasons": [{"key": "client_delay", "label": "Client delay"}, {"key": "capacity", "label": "Resource or capacity"}],
    "roles": [{"label": "Lead", "lead": True}, {"label": "Maker"}, {"label": "Coordinator"}],
    "promise": {"inputs": [{"key": "goal", "label": "Goal", "kind": "text"}, {"key": "bookings", "label": "Bookings a month", "kind": "number"},
                           {"key": "quality", "label": "Quality", "kind": "percent"}],
                "outputs": [{"key": "visits", "label": "Visits", "formula": "bookings * 10"}]},
    "steps": [
        {"id": "I1", "stage": 0, "title": "Brief received", "owner": "Lead", "type": "task", "from": "start", "start": 0, "end": 2, "packages": {"small": "yes", "full": "yes"}},
        {"id": "I2", "stage": 0, "title": "Access granted", "owner": "Coordinator", "type": "task", "from": "start", "start": 1, "end": 3, "packages": {"small": "yes", "full": "yes"}},
        {"id": "G1", "stage": 0, "title": "Ready", "owner": "Lead", "type": "gate", "from": "start", "start": 3, "end": 3, "after": ["I1"], "packages": {"small": "yes", "full": "yes"}},
        {"id": "V1", "stage": 1, "title": "Video script", "owner": "Maker", "type": "task", "from": "day0", "start": 1, "end": 3, "after": ["G1"], "packages": {"small": "yes", "full": "yes"}, "lines": ["T-VID-%"]},
        {"id": "V2", "stage": 1, "title": "Video delivered", "owner": "Maker", "type": "task", "from": "day0", "start": 3, "end": 8, "after": ["V1"], "packages": {"small": "yes", "full": "yes"}, "lines": ["T-VID-%"], "deliver": True},
        {"id": "W1", "stage": 1, "title": "Web page built", "owner": "Maker", "type": "task", "from": "day0", "start": 2, "end": 6, "packages": {"small": "yes", "full": "yes"}, "lines": ["T-WEB"], "deliver": True},
        {"id": "T1", "stage": 1, "title": "Testimonials", "owner": "Maker", "type": "task", "from": "day0", "start": 6, "end": 9, "packages": {"small": "yes", "full": "yes"}, "when": "realBuyers"},
        {"id": "G2", "stage": 2, "title": "Live", "owner": "Lead", "type": "milestone", "from": "day0", "start": 6, "end": 8, "after": ["V2"], "packages": {"small": "yes", "full": "yes"}},
        {"id": "R1", "stage": 2, "title": "Weekly review", "owner": "Lead", "type": "repeating", "from": "live", "start": 7, "end": None, "after": ["G2"], "packages": {"small": "yes", "full": "yes"}, "repeat": {"every": 7}},
        {"id": "F1", "stage": 2, "title": "Film request", "owner": "Lead", "type": "task", "from": "bought", "start": 0, "end": 2, "packages": {"small": "optional", "full": "optional"}, "lines": ["T-FILM"]},
        {"id": "F2", "stage": 2, "title": "Film delivered", "owner": "Maker", "type": "task", "from": "bought", "start": 2, "end": 20, "after": ["F1"], "packages": {"small": "optional", "full": "optional"}, "lines": ["T-FILM"], "deliver": True},
        {"id": "X1", "stage": 2, "title": "Extra kept for the full package", "owner": "Lead", "type": "task", "from": "day0", "start": 1, "end": 2, "packages": {"small": "no", "full": "yes"}},
    ],
}


def item(api, w, code, kind="service"):
    return one(api, w, w.editor2, "insert into pulse.erp_item(org_id,kind,code,name,price,status,created_by) values(%s,%s,%s,%s,100000,'active',%s) returning id",
               (w.org, kind, code, f"Synthetic {code}", w.editor2))["id"]


def document(api, owner, w, kind, number, day, lines, salesperson=None):
    """A paid invoice or an accepted quotation, linked to the project. lines: (item id, qty, removed, package id)."""
    who = w.editor2 if kind == "quotation" else w.manager  # a salesperson quotes; Finance invoices
    with api.transaction():
        set_tenant(api, w.org, who)
        did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,salesperson_id,created_by)
            values(%s,%s,%s,'{"name":"Synthetic Seller"}','{"name":"Synthetic Buyer"}','27','intra',0,0,0,0,0,%s,%s) returning id""", (w.org, kind, day, salesperson, who)).fetchone()["id"]
        for pos, (it, qty, removed, pkg) in enumerate(lines):
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,item_id,description,sac,qty,rate,gst_rate,taxable,cgst,sgst,igst,total,not_needed,package_id)
                values(%s,%s,%s,%s,'Synthetic line','998361',%s,0,18,0,0,0,0,0,%s,%s)""", (w.org, did, pos, it, qty, removed, pkg))
        api.execute("update pulse.erp_document set status=%s, number=%s, issued_at=now() where id=%s", ("paid" if kind == "invoice" else "accepted", number, did))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.project_quote(org_id,document_id,project_id) values(%s,%s,%s)", (w.org, did, w.project))
    return did


def unit_tasks(owner, w, doc, line_pos, n):
    """The per-unit tasks a paid invoice makes from a line (as 1471 does: source quote, one per unit)."""
    with owner.transaction():
        set_tenant(owner, w.org)
        line = owner.execute("select id from pulse.erp_line where document_id=%s and position=%s", (doc, line_pos)).fetchone()["id"]
        for i in range(1, n + 1):
            owner.execute("""insert into pulse.task(org_id,project_id,title,source,source_ref,source_key,status) values(%s,%s,%s,'quote',%s,%s,'open')""",
                           (w.org, w.project, f"Synthetic video #{i}", str(line), f"quote:{line}:{i}"))


def steps(api, w):
    rows = as_(api, w, w.lead, """select id,template_step,status,assignee_person_id,source,(due_at at time zone pulse.org_time_zone())::date due
        from pulse.task where project_id=%s and template_step is not null and deleted_at is null order by created_at""", (w.project,))
    out = {}
    for r in rows:
        out.setdefault(r["template_step"], []).append(r)
    return out


def plan(api, w):
    return one(api, w, w.lead, "select package,lines,roles,conditions,promise,live_paused,template_version from pulse.project_plan where project_id=%s", (w.project,))


@pytest.fixture
def bought(api, worker, owner, team):
    """A Full package sold as its parts: two videos (a part line each carries the package's code), the web page removed
    from the package; the plan laid out from it with the wrong package named (the codes win)."""
    w = team
    w.today = org_today(api, w)
    with worker.transaction():  # Editor Two sells too: the deal's salesperson, who writes its quotation
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,is_manager_of_unit,valid_from) values(%s,%s,%s,'sales',false,'2026-01-01')", (w.org, w.editor2, w.pod))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,is_manager_of_unit,valid_from) values(%s,%s,%s,'finance',false,'2026-01-01')", (w.org, w.manager, w.pod))
    one(api, w, w.manager, "select pulse.delivery_template_adopt('bought-test','Bought plan',%s,%s) r", (Jsonb(TPL), w.project))
    full, vid, web = item(api, w, "T-PKG-FULL", "package"), item(api, w, "T-VID-STD"), item(api, w, "T-WEB")
    w.film = item(api, w, "T-FILM")
    w.quote = document(api, owner, w, "quotation", "QT-T-1", w.today - timedelta(days=2), [(vid, 2, False, full), (web, 1, True, full)], salesperson=w.editor2)
    unit_tasks(owner, w, w.quote, 0, 2)
    w.laid = one(api, w, w.lead, "select pulse.project_plan_set(%s,'bought-test','small','big',%s,%s) r", (w.project, w.today - timedelta(days=2), w.lead))["r"]
    return w


def test_built_from_what_was_bought(api, worker, bought):
    w = bought
    p = plan(api, w)
    assert p["package"] == "full", "the codes bought name the package, over the one typed"
    codes = sorted(x["code"] for x in p["lines"])
    assert codes == ["T-PKG-FULL", "T-VID-STD"], codes  # the removed web page is not bought
    s = steps(api, w)
    assert "W1" not in s, "a step whose codes were not bought is not made"
    assert "X1" in s and "I1" in s, "steps without codes follow the package"
    assert "T1" not in s and "F1" not in s, "a condition not met, an add-on not bought"
    assert [x["source"] for x in s["V2"]] == ["quote", "quote"], "the delivering step takes the two bought units, nothing twice"
    assert len(s["V1"]) == 1 and s["V1"][0]["source"] == "template"
    why = {r["id"]: r["why"] for r in as_(api, w, w.lead, """select x->>'id' id, pulse.plan_step_why_not(pulse.plan_definition(%s), x, pl.package,
          pulse.plan_lines_used(pulse.plan_definition(%s), pl.lines), pl.conditions, pl.roles) why
        from pulse.project_plan pl, jsonb_array_elements(pulse.plan_definition(%s)->'steps') x where pl.project_id=%s""", (w.project, w.project, w.project, w.project))}
    assert why["W1"] == "not_bought" and why["T1"] == "condition" and why["F1"] == "not_bought" and why["V1"] is None


def test_an_add_on_joins_on_its_own_day(api, worker, owner, bought):
    w = bought
    before = {k: [x["due"] for x in v] for k, v in steps(api, w).items()}
    later = w.today - timedelta(days=1)
    inv = document(api, owner, w, "invoice", "INV-T-2", later, [(w.film, 1, False, None)])
    unit_tasks(owner, w, inv, 0, 1)
    with owner.transaction():  # what the "scope added" event runs (internal)
        set_tenant(owner, w.org)
        r = owner.execute("select pulse.project_plan_add_lines(%s) r", (w.project,)).fetchone()["r"]
    assert r["tasks"] == 1 and r["matched"] == 1, r  # F1 made; F2 took the add-on's unit
    s = steps(api, w)
    assert s["F1"][0]["due"] == later + timedelta(days=2), "an add-on counts from its own purchase day"
    assert s["F2"][0]["source"] == "quote" and s["F2"][0]["due"] == later + timedelta(days=20)
    assert all([x["due"] for x in s[k]] == v for k, v in before.items()), "no other date moves"


def test_who_does_what(api, worker, bought):
    w = bought
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_plan_roles_set(%s,%s)", (w.project, Jsonb({"Maker": str(w.editor)})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ai(api, w, w.lead, "select pulse.project_plan_roles_set(%s,%s)", (w.project, Jsonb({"Maker": str(w.editor)})))
    r = one(api, w, w.lead, "select pulse.project_plan_roles_set(%s,%s) r", (w.project, Jsonb({"Maker": str(w.editor), "Coordinator": "none"})))["r"]
    s = steps(api, w)
    assert s["V1"][0]["assignee_person_id"] == w.editor and r["assigned"] >= 3, r
    assert s["I2"][0]["status"] == "cancelled" and r["notMade"] == 1, "no empty cards: nobody holds Coordinator here"
    assert one(api, w, w.lead, "select count(*) n from pulse.project_member where project_id=%s and person_id=%s and left_at is null", (w.project, w.editor))["n"] == 1
    r = one(api, w, w.lead, "select pulse.project_plan_roles_set(%s,%s) r", (w.project, Jsonb({"Coordinator": str(w.editor2)})))["r"]
    s = steps(api, w)
    assert r["back"] == 1 and s["I2"][0]["status"] == "open" and s["I2"][0]["assignee_person_id"] == w.editor2, "named later, its steps come back"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.project_plan_roles_set(%s,%s)", (w.project, Jsonb({"Maker": str(uuid.uuid4())})))


def test_conditions_and_repeats(api, worker, owner, bought):
    w = bought
    r = one(api, w, w.lead, "select pulse.project_plan_condition_set(%s,'realBuyers',true) r", (w.project,))["r"]
    assert r["tasks"] == 1 and "T1" in steps(api, w)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.project_plan_condition_set(%s,'nope',true)", (w.project,))
    one(api, w, w.lead, "select pulse.project_plan_condition_set(%s,'realBuyers',false) r", (w.project,))
    assert steps(api, w)["T1"][0]["status"] == "cancelled", "untouched steps leave again when the condition no longer holds"
    r = one(api, w, w.lead, "select pulse.project_plan_condition_set(%s,'realBuyers',true) r", (w.project,))["r"]
    assert r["tasks"] == 1 and steps(api, w)["T1"][0]["status"] == "open", "and come back when it holds again"
    # Live 20 days ago: the weekly review's first time was live + 7; one card per week up to a week ahead.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.project_plan set kickoff=%s, day0_on=%s, live_on=%s where project_id=%s", (w.today - timedelta(days=30), w.today - timedelta(days=25), w.today - timedelta(days=20), w.project))
        owner.execute("select pulse.project_plan_reclock(%s,'live')", (w.project,))
    made = one(api, w, w.lead, "select pulse.project_plans_roll() n")["n"]
    dues = sorted(x["due"] for x in steps(api, w)["R1"])
    assert dues[0] == w.today - timedelta(days=13), dues
    assert made == len(dues) - 1 and dues[-1] <= w.today + timedelta(days=7) and dues[-1] > w.today, dues
    assert one(api, w, w.lead, "select pulse.project_plans_roll() n")["n"] == 0, "made once"


def test_what_we_promised(api, worker, bought):
    w = bought
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_promise_propose(%s,%s,null)", (w.project, Jsonb({"bookings": 4})))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Quality is out of range"):
        as_(api, w, w.lead, "select pulse.project_promise_propose(%s,%s,null)", (w.project, Jsonb({"quality": 140})))
    r = one(api, w, w.lead, "select pulse.project_promise_propose(%s,%s,'From the call') r", (w.project, Jsonb({"bookings": "4", "quality": 30, "goal": "Sell out by June"})))["r"]
    assert r["confirmed"] is False, "the lead proposes; sales confirms"
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Sales confirms"):
        as_(api, w, w.manager, "select pulse.project_promise_answer(%s,true)", (w.project,))
    with worker.transaction():  # the salesperson was told, and watches the project so the notice reaches them
        set_tenant(worker, w.org)
        told = worker.execute("select count(*) n from pulse.notification where person_id=%s and title like '%%Confirm it?'", (w.editor2,)).fetchone()["n"]
    assert told == 1
    one(api, w, w.editor2, "select pulse.project_promise_answer(%s,true) r", (w.project,))  # the deal's salesperson
    p = plan(api, w)["promise"]
    assert p["values"] == {"bookings": 4, "quality": 30, "goal": "Sell out by June"} and p["confirmedBy"] == str(w.editor2) and "pending" not in p
    # The salesperson's own change is the promise at once; nobody confirms their own proposal.
    r = one(api, w, w.editor2, "select pulse.project_promise_propose(%s,%s,null) r", (w.project, Jsonb({"bookings": 5})))["r"]
    assert r["confirmed"] is True and plan(api, w)["promise"]["values"]["bookings"] == 5
    one(api, w, w.lead, "select pulse.project_promise_propose(%s,%s,null) r", (w.project, Jsonb({"bookings": 6})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.project_promise_answer(%s,true)", (w.project,))
    one(api, w, w.editor2, "select pulse.project_promise_answer(%s,false) r", (w.project,))
    assert plan(api, w)["promise"]["values"]["bookings"] == 5 and "pending" not in plan(api, w)["promise"]


def test_date_moves_by_the_template(api, worker, bought):
    w = bought
    g2 = steps(api, w)["G2"][0]["id"]
    v1 = steps(api, w)["V1"][0]["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only the project's lead moves"):
        as_(api, w, w.editor2, "select pulse.project_reschedule(%s,null,%s,'client_delay',null,false)", (v1, w.today + timedelta(days=9)))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Choose why"):
        as_(api, w, w.lead, "select pulse.project_reschedule(%s,null,%s,'our_delay',null,false)", (v1, w.today + timedelta(days=9)))
    r = one(api, w, w.lead, "select pulse.project_reschedule(%s,null,%s,'capacity',null,false) r", (v1, w.today + timedelta(days=9)))["r"]
    assert r["steppedIn"] is False
    r = one(api, w, w.manager, "select pulse.project_reschedule(%s,null,%s,'client_delay','Late approval',false) r", (g2, w.today + timedelta(days=12)))["r"]
    assert r["steppedIn"] is True, "leadership may step in, and it is logged"
    ch = one(api, w, w.lead, "select reason_kind,note from pulse.project_date_change where task_id=%s", (g2,))
    assert ch["reason_kind"] == "client_delay" and "stepped in" in ch["note"]


def test_a_restart_moves_only_what_stopped(api, worker, owner, bought):
    w = bought
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.project_plan set kickoff=%s, day0_on=%s, live_on=%s where project_id=%s", (w.today - timedelta(days=15), w.today - timedelta(days=12), w.today - timedelta(days=10), w.project))
        owner.execute("update pulse.task set due_at = now() + interval '3 days' where project_id=%s and template_step='I1'", (w.project,))
    due = steps(api, w)["I1"][0]["due"]
    one(api, w, w.lead, "select pulse.project_set_status(%s,'paused','Client asked for a break',%s,null,%s,false) r",
        (w.project, w.today - timedelta(days=4), Jsonb({"tasks": False, "months": True})))
    one(api, w, w.lead, "select pulse.project_set_status(%s,'active','Back on',null,null,'{}',true) r", (w.project,))
    assert steps(api, w)["I1"][0]["due"] == due, "open tasks did not stop, so they do not move"
    assert plan(api, w)["live_paused"] == 4, "the campaign months stood still for the paused days"


def test_a_project_links_its_chat_groups(api, worker, bought):
    w = bought
    ch = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,'Pilot project · client group','group')", (w.org, ch, f"g-{ch}"))
        worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, ch, w.lead))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_chat_link(%s,%s,true)", (w.project, ch))
    one(api, w, w.lead, "select pulse.project_chat_link(%s,%s,true) r", (w.project, ch))
    g = one(api, w, w.lead, "select project_id,manual from pulse.chat_group_info where channel_id=%s", (ch,))
    assert g["project_id"] == w.project and "project" in g["manual"]
    one(api, w, w.lead, "select pulse.project_chat_link(%s,%s,false) r", (w.project, ch))
    assert one(api, w, w.lead, "select project_id from pulse.chat_group_info where channel_id=%s", (ch,))["project_id"] is None


def test_other_codes_leave_it_to_the_package(api, worker, owner, team):
    """A quotation whose lines carry codes the template does not know (an older catalogue) is planned by its package."""
    w = team
    w.today = org_today(api, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,is_manager_of_unit,valid_from) values(%s,%s,%s,'sales',false,'2026-01-01')", (w.org, w.editor2, w.pod))
    one(api, w, w.manager, "select pulse.delivery_template_adopt('bought-test','Bought plan',%s,%s) r", (Jsonb(TPL), w.project))
    old = item(api, w, "svc-old-reel")
    document(api, owner, w, "quotation", "QT-T-9", w.today, [(old, 1, False, None)], salesperson=w.editor2)
    one(api, w, w.lead, "select pulse.project_plan_set(%s,'bought-test','small','big',%s,%s) r", (w.project, w.today, w.lead))
    s = steps(api, w)
    assert {"V1", "V2", "W1"} <= set(s), "the package decides when no line speaks the template's codes"
