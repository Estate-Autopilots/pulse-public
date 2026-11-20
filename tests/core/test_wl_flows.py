"""WL-FLOWS (19 Nov 2026, migration 2404): two gaps that Willow Lane's nightly journeys (tools/qa/vitals/wl-flows.mjs) found.

1. A quotation an AI employee drafts for a seller's own customer (create_quote_lead made the seller its relationship
   owner) is that seller's even when the seller did not ask in the run: from a task, outside a chat, or because a leader
   asked. Before, it had no salesperson and the seller could not mark it sent ("This deal is another salesperson's").
2. "Remind me about this message" reaches the person's bell: chat_due's chat.mention notice is allowed for the person's
   own fired reminder, on any message, their own too. Another person's mention rule is unchanged.

Synthetic people and figures only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_agent_coworkers import agent_one, ask, make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)

SELLER = {"name": "Synthetic Seller Co", "gstin": "27ABCDE1234F1Z5", "stateCode": "27"}


def _sales(worker, w, *people):
    with worker.transaction():
        set_tenant(worker, w.org)
        for p in people:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'sales','2020-01-01')", (w.org, p))


def test_an_ai_employees_quotation_for_a_sellers_customer_is_that_sellers(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "quote-flows")
    owner_sql(owner, w, "update pulse.agent_member set tools=array(select distinct unnest(tools||'{billing}'::text[])) where person_id=%s", (agent,))
    _sales(worker, w, w.editor)

    def lead(name, phone, salesperson):
        r = agent_one(api, w, agent, "select pulse.v1_quote_lead_create(%s) v", (Jsonb({"name": name, "phone": phone, "area": "Pune", "salespersonId": str(salesperson)}),))["v"]
        return r["id"]

    def draft(client):
        return agent_one(api, w, agent, """insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,client_id,created_by)
            values(%s,'quotation',current_date,%s,%s,'27','intra',10000000,250000,250000,0,10500000,%s,pulse.current_viewer())
            returning id, salesperson_id""", (w.org, Jsonb(SELLER), Jsonb({"name": "Synthetic Buyer", "stateCode": "27"}), client))

    # bhrātā adds a customer for the seller; a quotation it drafts for that customer outside any run is the seller's.
    mine = lead("Synthetic Lead One", "+919000000101", w.editor)
    q = draft(mine)
    assert q["salesperson_id"] == w.editor
    # So it is the seller's own deal (the sales seat changes only those: mark sent, revise, payments).
    assert one(api, w, w.editor, "select pulse.erp_doc_mine(%s) m", (q["id"],))["m"] is True
    # A customer whose relationship owner holds no sales seat: no salesperson is made up.
    other = lead("Synthetic Lead Two", "+919000000102", w.editor2)
    assert draft(other)["salesperson_id"] is None
    # No customer at all: none either (2393's rule, unchanged).
    none = agent_one(api, w, agent, """insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
        values(%s,'quotation',current_date,%s,%s,'27','intra',10000000,250000,250000,0,10500000,pulse.current_viewer()) returning salesperson_id""",
        (w.org, Jsonb(SELLER), Jsonb({"name": "Synthetic Buyer", "stateCode": "27"})))
    assert none["salesperson_id"] is None


def test_a_chat_reminder_reaches_the_bell_of_the_person_who_asked(api, worker, owner, team):  # noqa: F811
    w = team
    dm = one(api, w, w.lead, "select pulse.chat_direct(%s) id", (w.editor,))["id"]
    theirs = ask(api, w, w.lead, dm, "Synthetic: the site visit is on Friday")
    own = ask(api, w, w.editor, dm, "Synthetic: I will call the customer")

    # The editor asks to be reminded about both (one of them their own message); a reminder is at least 30 s ahead.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="time ahead"):
        one(api, w, w.editor, "select pulse.chat_remind(%s, now()) id", (theirs,))
    r1 = one(api, w, w.editor, "select pulse.chat_remind(%s, now() + interval '1 minute') id", (theirs,))["id"]
    r2 = one(api, w, w.editor, "select pulse.chat_remind(%s, now() + interval '1 minute') id", (own,))["id"]
    owner_sql(owner, w, "update pulse.chat_reminder set due_at = now() - interval '1 second' where id = any(%s::uuid[])", ([r1, r2],))
    assert one(api, w, w.editor, "select pulse.chat_due() n")["n"] >= 2

    with worker.transaction():
        set_tenant(worker, w.org)
        notes = worker.execute("""select n.id, n.subject_id from pulse.notification n where n.person_id=%s and n.kind='reminder' order by n.created_at""", (w.editor,)).fetchall()
    assert {n["subject_id"] for n in notes} == {theirs, own}
    for n in notes:
        assert one(api, w, w.editor, "select pulse.notification_authorized(%s,%s) a", (n["id"], w.editor))["a"] is True
    # The bell lists them (the inbox's own visibility rule).
    shown = one(api, w, w.editor, """select count(*)::int c from pulse.notification n where n.person_id=pulse.current_viewer()
        and pulse.notification_authorized(n.id,pulse.current_viewer()) and n.kind='reminder'""")["c"]
    assert shown == 2

    # Nothing else widened: a chat.mention for someone the message does not mention, with no reminder of theirs, stays out.
    allowed = "select pulse.notification_recipient_allowed(%s,'chat.mention','message',%s) a"  # not granted to the API role
    assert owner_sql(owner, w, allowed, (w.lead, own))[0]["a"] is False
    # And a reminder someone cancelled before it rang lets nothing through.
    r3 = one(api, w, w.lead, "select pulse.chat_remind(%s, now() + interval '1 minute') id", (own,))["id"]
    one(api, w, w.lead, "select pulse.chat_remind_cancel(%s)", (r3,))
    assert owner_sql(owner, w, allowed, (w.lead, own))[0]["a"] is False
