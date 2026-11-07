"""WA-INTEL (1070) on real PostgreSQL: the work the imported WhatsApp groups record. Insights → From the chats and a
client's money are for leadership and admins; a colleague reads their own numbers and nobody else's; a suggested task
becomes a Pulse task only when a leader names who does it; a contact suggestion fills only what is empty and only for
an admin; the review kind is added without losing the kinds already allowed. Every name and number is synthetic."""

import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world


def seed(owner, w, chat, mids):
    with owner.transaction():
        set_tenant(owner, w.org)
        q = owner.execute
        q("""insert into pulse_priv.wa_work_item (org_id, source_key, chat_id, message_id, client_id, kind, title, asked_by, asked_side, owner_id, owner_side, asked_at, status, follow_ups, review_state)
             values (%s,'w-1',%s,%s,%s,'deliverable','Synthetic: send the first edit',null,'client',%s,'team',now() - interval '2 days','open',2,'suggested'),
                    (%s,'w-2',%s,%s,%s,'material_request','Synthetic: share the cost sheet',%s,'team',null,'client',now() - interval '3 days','open',0,'suggested'),
                    (%s,'w-3',%s,%s,%s,'promise','Synthetic: reel by evening',%s,'team',%s,'team',now() - interval '9 days','done',0,'history')""",
          (w.org, chat, mids[0], w.client, w.editor, w.org, chat, mids[1], w.client, w.editor, w.org, chat, mids[2], w.client, w.editor, w.editor))
        q("""insert into pulse_priv.wa_learning (org_id, source_key, kind, chat_id, client_id, category, verdict, title, root_cause, prevention, by_id, by_side, at, evidence)
             values (%s,'d-1','decision',%s,%s,'budget','bad','Synthetic: launch with one creative',null,null,%s,'team',now(),%s),
                    (%s,'i-1','incident',%s,%s,'wrong_info','high','Synthetic: old price in the script','Price not confirmed','Confirm prices on the call',%s,'team',now(),%s)""",
          (w.org, chat, w.client, w.editor, [mids[0]], w.org, chat, w.client, w.editor, [mids[1]]))
        q("""insert into pulse_priv.wa_finance_event (org_id, source_key, chat_id, message_id, client_id, kind, amount_inr, period, at, by_side, status, note)
             values (%s,'f-1',%s,%s,%s,'budget_set',500,'per_day',now(),'team','done','Synthetic daily budget'), (%s,'f-2',%s,%s,%s,'topup_request',10000,null,now(),'team','pending',null)""",
          (w.org, chat, mids[0], w.client, w.org, chat, mids[1], w.client))
        q("insert into pulse_priv.wa_person_perf (org_id, person_id, side, metrics) values (%s,%s,'team',%s), (%s,%s,'team',%s)",
          (w.org, w.editor, json.dumps({"messages": 120, "groups": 3, "confidence": "low"}), w.org, w.lead, json.dumps({"messages": 900, "groups": 12})))
        q("insert into pulse_priv.wa_intel_summary (org_id, data) values (%s,%s)", (w.org, json.dumps({"groups": 1, "workItems": 3})))


def test_work_from_the_chats_is_for_leaders_and_a_person_reads_their_own(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, b["batchId"], [msg(1, "Synthetic: please send the edit"), msg(2, "Synthetic: cost sheet please", sender="s-client1"), msg(3, "Synthetic: done")])
    with owner.transaction():
        set_tenant(owner, w.org)
        mids = [r["id"] for r in owner.execute("select id from pulse_priv.wa_message where chat_id=%s order by seq", (b["chatId"],))]
    seed(owner, w, b["chatId"], mids)
    with api.transaction():
        set_tenant(api, w.org, w.editor)                       # a colleague, not a leader
        assert api.execute("select pulse.wa_intel('{}') r").fetchone()["r"] is None
        assert api.execute("select pulse.wa_client_finance(%s) r", (w.client,)).fetchone()["r"] is None
        assert api.execute("select pulse.wa_person_perf_read(%s) r", (w.lead,)).fetchone()["r"] is None      # not someone else's
        mine = api.execute("select pulse.wa_person_perf_read(%s) r", (w.editor,)).fetchone()["r"]
        assert mine["self"] and mine["metrics"]["messages"] == 120 and mine["work"]["owned"] == 2 and mine["work"]["promises"] == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.wa_work_decide((select id from pulse_priv.wa_work_item limit 1),'dismiss','{}')")
    with api.transaction():
        set_tenant(api, w.org, w.lead)                          # leadership
        s = api.execute("select pulse.wa_intel('{}') r").fetchone()["r"]
        assert s["counts"]["work"] == 3 and s["counts"]["suggested"] == 2 and s["counts"]["decisions"] == 1 and s["counts"]["incidents"] == 1
        assert s["summary"]["workItems"] == 3
        work = api.execute("""select pulse.wa_intel('{"part":"work"}') r""").fetchone()["r"]
        assert {x["title"] for x in work} == {"Synthetic: send the first edit", "Synthetic: share the cost sheet"}
        assert all(x["chatId"] == str(b["chatId"]) and x["client"] == "Synthetic Developers" for x in work)
        bad = api.execute("""select pulse.wa_intel('{"part":"learning","kind":"incident"}') r""").fetchone()["r"]
        assert len(bad) == 1 and bad[0]["prevention"] == "Confirm prices on the call" and bad[0]["evidence"] == [str(mids[1])]
        team = api.execute("""select pulse.wa_intel('{"part":"team"}') r""").fetchone()["r"]
        assert [t["metrics"]["messages"] for t in team] == [900, 120]
        f = api.execute("select pulse.wa_client_finance(%s) r", (w.client,)).fetchone()["r"]
        assert [e["kind"] for e in f["events"]] and {e["amount"] for e in f["events"]} == {500, 10000} and f["open"] == 2
        assert api.execute("select pulse.wa_person_perf_read(%s) r", (w.editor,)).fetchone()["r"]["self"] is False
        item = next(x["id"] for x in work if x["title"] == "Synthetic: send the first edit")
        with pytest.raises(psycopg.errors.InvalidParameterValue):            # nothing is assigned by itself
            api.execute("select pulse.wa_work_decide(%s,'accept','{}')", (item,))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        r = api.execute("select pulse.wa_work_decide(%s,'accept',%s) r", (item, json.dumps({"assigneeId": str(w.editor), "dueOn": "2030-01-10"}))).fetchone()["r"]
        t = api.execute("select title, assignee_person_id, notes from pulse.task where id=%s", (r["taskId"],)).fetchone()
        assert t["title"] == "Synthetic: send the first edit" and t["assignee_person_id"] == w.editor and "followed up 2 times" in t["notes"]
        again = api.execute("select pulse.wa_work_decide(%s,'accept',%s) r", (item, json.dumps({"assigneeId": str(w.editor)}))).fetchone()["r"]
        assert again["taskId"] == r["taskId"]                                 # accepting twice makes one task
        other = next(x["id"] for x in work if x["id"] != item)
        api.execute("select pulse.wa_work_decide(%s,'dismiss','{}')", (other,))
        assert [x["id"] for x in api.execute("""select pulse.wa_intel('{"part":"work","state":"dismissed"}') r""").fetchone()["r"]] == [other]
        api.execute("select pulse.wa_work_decide(%s,'restore','{}')", (other,))
        assert len(api.execute("""select pulse.wa_intel('{"part":"work"}') r""").fetchone()["r"]) == 1


def test_contact_suggestion_fills_only_what_is_empty_and_only_for_admins(worker, owner, api):
    w, _ = world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        kinds = owner.execute("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='pulse.review_item'::regclass and conname='review_item_kind_check'").fetchone()["d"]
        assert "wa_contact" in kinds and "contact_type" in kinds and "geocode" in kinds                     # nothing allowed before was lost
        poc = owner.execute("insert into pulse.person(org_id, display_name, side) values (%s,'Synthetic Contact','client') returning id", (w.org,)).fetchone()["id"]
        owner.execute("insert into pulse.contact_profile(org_id, person_id, email, source) values (%s,%s,'kept@synthetic.invalid','manual')", (w.org, poc))
        item = owner.execute("""insert into pulse.review_item (org_id, source_key, kind, entity_type, entity_id, title, proposed, confidence, evidence, status)
                                values (%s,'wa_contact:profile:s-x','wa_contact','contact',%s,'Role from the chats',%s,0.8,'{}','pending') returning id""",
                             (w.org, poc, json.dumps({"designation": "Marketing head", "email": "other@synthetic.invalid", "clientId": str(w.client)}))).fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.wa_contact_apply(%s)", (item,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)                       # an admin
        api.execute("select pulse.wa_contact_apply(%s)", (item,))
    with owner.transaction():
        set_tenant(owner, w.org)
        p = owner.execute("select designation, email from pulse.contact_profile where person_id=%s", (poc,)).fetchone()
        assert p["designation"] == "Marketing head" and p["email"] == "kept@synthetic.invalid"             # the e-mail someone set stays
        assert owner.execute("select 1 from pulse.client_contact where client_id=%s and person_id=%s", (w.client, poc)).fetchone()
        assert owner.execute("select count(*) n from pulse.record_change where entity_id=%s and field='designation'", (poc,)).fetchone()["n"] == 1


def test_new_contact_suggestion_makes_the_named_sender_a_point_of_contact(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, b["batchId"], [msg(1, "Synthetic: hello", sender="s-client1"), msg(2, "Synthetic: hi", sender="s-number1")])
    with owner.transaction():
        set_tenant(owner, w.org)
        add = lambda key, sender: owner.execute(
            """insert into pulse.review_item (org_id, source_key, kind, entity_type, entity_id, title, proposed, confidence, evidence, status)
               values (%s,%s,'wa_contact','client',%s,'New contact from the chats',%s,0.7,'{}','pending') returning id""",
            (w.org, key, w.client, json.dumps({"designation": "Owner / director", "newContact": sender}))).fetchone()["id"]
        named, bare = add("wa_contact:new:s-client1", "s-client1"), add("wa_contact:new:s-number1", "s-number1")
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.wa_contact_apply(%s)", (named,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        r = api.execute("select pulse.wa_contact_apply(%s) r", (named,)).fetchone()["r"]
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        with pytest.raises(psycopg.errors.InvalidParameterValue):            # known only by a number: not made into a person
            api.execute("select pulse.wa_contact_apply(%s)", (bare,))
    with owner.transaction():
        set_tenant(owner, w.org)
        pid = uuid.UUID(r["personId"])
        p = owner.execute("select p.display_name, p.side, c.designation from pulse.person p join pulse.contact_profile c on c.person_id = p.id where p.id=%s", (pid,)).fetchone()
        assert p["display_name"] == "Client Contact" and p["side"] == "client" and p["designation"] == "Owner / director"
        assert owner.execute("select 1 from pulse.client_contact where client_id=%s and person_id=%s", (w.client, pid)).fetchone()
        assert owner.execute("select person_id from pulse_priv.wa_participant where chat_id=%s and source_key='s-client1'", (b["chatId"],)).fetchone()["person_id"] == pid
        assert owner.execute("select person_id from pulse_priv.wa_identity where source_key='s-client1'").fetchone()["person_id"] == pid
        assert owner.execute("select count(*) n from pulse.person where org_id=%s and display_name like 'Number ending%%'", (w.org,)).fetchone()["n"] == 0
