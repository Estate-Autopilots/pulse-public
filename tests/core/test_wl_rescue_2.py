"""WL-RESCUE-2 (18 Nov 2026, migration 2393): an AI employee corrects a staff record when an admin, leadership or HR asked
it in a message (never the sign-in e-mail), and a quotation it drafts because a seller asked is that seller's.

Willow Lane: Sakobe (admin and HR) sent bhrātā Megud's role, phone and joining date and it answered "no change made"; and
QT/26-27/0002, drafted by bhrātā for Adunor, recorded no salesperson. Synthetic people and figures only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_agent_coworkers import agent_one, as_agent, ask, claim, dispatch, make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


def _runs(api, w, agent):
    def run_for(person, words):
        dm = one(api, w, person, "select pulse.chat_direct(%s) id", (agent,))["id"]
        ask(api, w, person, dm, words)
        [c] = claim(api, w, agent)
        d = dispatch(api, w, agent, c)
        assert d["status"] == "dispatched", d
        return d["runId"]

    def finish(run):
        agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',100,1.0,null) r", (run,))
    return run_for, finish


def test_an_ai_employee_corrects_a_staff_record_only_when_an_admin_leadership_or_hr_asked(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "hr-helper")
    run_for, finish = _runs(api, w, agent)

    def correct(field, value):
        return agent_one(api, w, agent, "select pulse.hr_profile_correct(%s,%s,%s,'Synthetic: details sent in the chat') r", (w.editor2, field, value))["r"]

    # Outside any run: nobody asked.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="admin, leadership or HR asks"):
        correct("role", "Customer Support Executive")

    # A member asks: refused, the sentence says who can ask.
    run = run_for(w.editor, "Make Editor Two a Customer Support Executive")
    assert agent_one(api, w, agent, "select pulse.agent_run_asker() a, pulse.agent_hr_asked() h") == {"a": w.editor, "h": False}
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="admin, leadership or HR asks"):
        correct("role", "Customer Support Executive")
    finish(run)

    # HR asks: the role and the phone change, in the record's history as the AI employee; the sign-in e-mail never.
    run = run_for(w.lead, "Editor Two is now Customer Support Executive, phone +91 90000 00002, joined 2026-08-01")
    assert agent_one(api, w, agent, "select pulse.agent_hr_asked() h")["h"] is True
    r = correct("role", "Customer Support Executive")
    assert r["changed"] is True and r["to"] == "Customer Support Executive" and r["changeId"]
    assert correct("phone", "+91 90000 00002")["changed"] is True
    assert correct("joinedOn", "2026-08-01")["changed"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="sign-in e-mail"):
        correct("workEmail", "someone.else@example.com")
    finish(run)
    with worker.transaction():
        set_tenant(worker, w.org)
        p = worker.execute("select role, phone, joined_on::text joined from pulse.people_profile where person_id=%s", (w.editor2,)).fetchone()
        assert p == {"role": "Customer Support Executive", "phone": "+91 90000 00002", "joined": "2026-08-01"}
        by = worker.execute("select distinct changed_by from pulse.record_change where entity_id=%s and field in ('role','phone','joinedOn')", (w.editor2,)).fetchall()
        assert [x["changed_by"] for x in by] == [agent]

    # The run is over: the next correction needs a new ask. A person's own path is unchanged (HR yes, a member no).
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="admin, leadership or HR asks"):
        correct("role", "Editor")
    assert one(api, w, w.lead, "select pulse.hr_profile_correct(%s,'role','Editor','Synthetic: back to Editor') r", (w.editor2,))["r"]["changed"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="HR or admin required"):
        one(api, w, w.editor, "select pulse.hr_profile_correct(%s,'role','Boss','Synthetic: not mine to change') r", (w.editor2,))


def test_a_quotation_an_ai_employee_drafts_for_a_seller_is_that_sellers(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "quote-helper")
    owner_sql(owner, w, "update pulse.agent_member set tools=array(select distinct unnest(tools||'{billing}'::text[])) where person_id=%s", (agent,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'sales','2020-01-01')", (w.org, w.editor))
    run_for, finish = _runs(api, w, agent)
    seller = {"name": "Synthetic Seller Co", "gstin": "27ABCDE1234F1Z5", "stateCode": "27"}

    def draft(name):
        return agent_one(api, w, agent, """insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
            values(%s,'quotation',current_date,%s,%s,'27','intra',10000000,250000,250000,0,10500000,pulse.current_viewer())
            returning salesperson_id""", (w.org, Jsonb(seller), Jsonb({"name": name, "stateCode": "27"})))["salesperson_id"]

    # A seller asks: the quotation is the seller's.
    run = run_for(w.editor, "Make a quotation for 5 kW for Synthetic Client One")
    assert draft("Synthetic Client One") == w.editor
    finish(run)
    # The admin (no sales role) asks: no salesperson is made up; outside a run neither.
    run = run_for(w.manager, "Make a quotation for 3 kW for Synthetic Client Two")
    assert draft("Synthetic Client Two") is None
    finish(run)
    assert draft("Synthetic Client Three") is None
