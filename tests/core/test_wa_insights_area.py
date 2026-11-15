"""WA-NATIVE (1053) on real PostgreSQL: Insights → Client operations and a client's health, built from the imported
WhatsApp groups' analysis (1016), for leadership and admins only; the company read is kept for six hours; a leader's
action on a recommendation (a task, an SOP) is recorded. Every group, name and number here is synthetic."""

import json

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world


def test_company_insights_client_health_and_actions_are_for_leaders(worker, owner, api):
    w, people = world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        poc = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client1", "kind": "client", "name": "Client Contact",
                            "clientId": str(w.client), "basis": "synthetic"}),)).fetchone()["id"]
    people[1]["person"] = str(poc)
    b = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, b["batchId"], [msg(1, "Synthetic: welcome, please share the brochure"), msg(2, "Synthetic brochure attached", sender="s-client1"),
                                  msg(3, "Synthetic: please add funds in ads manager"), msg(4, "Synthetic: leads are fake, not connecting", sender="s-client1")])
    with owner.transaction():
        set_tenant(owner, w.org)
        ids = [r["id"] for r in owner.execute("select id from pulse_priv.wa_message where chat_id=%s order by seq", (b["chatId"],))]
        for mid, intent, sent in zip(ids, ["greeting", "deliverable", "request", "complaint"], [0, 0, 0, -1]):
            owner.execute("""insert into pulse_priv.wa_message_signal (org_id, message_id, chat_id, intent, topics, sentiment, basis, model)
                             values (%s,%s,%s,%s,'{leads}',%s,'rules','synthetic')""", (w.org, mid, b["chatId"], intent, sent))
        owner.execute("insert into pulse_priv.wa_response (org_id, message_id, to_message_id, chat_id, responder_side, waited_s, working_s) values (%s,%s,%s,%s,'client',600,600)",
                      (w.org, ids[1], ids[0], b["chatId"]))
        owner.execute("insert into pulse_priv.wa_signal (org_id, chat_id, message_id, client_id, kind, score, at, note) values (%s,%s,%s,%s,'lead_quality',0.8,now(),'synthetic')",
                      (w.org, b["chatId"], ids[3], w.client))
        owner.execute("insert into pulse_priv.wa_chat_stage (org_id, chat_id, stage, first_at, last_at, messages, evidence) values (%s,%s,'brief',now(),now(),1,%s)", (w.org, b["chatId"], [ids[1]]))
        owner.execute("""insert into pulse_priv.wa_insight (org_id, subject, subject_id, metrics) values (%s,'company',%s,%s), (%s,'client',%s,%s), (%s,'chat',%s,%s)""",
                      (w.org, w.org, json.dumps({"top_sequences": [["onboarding → brief", 1]], "sop": [{"step_no": 1, "step": "Synthetic step", "groups": 1, "observed_share": 0.5, "median_hours_from_start": 30}]}),
                       w.org, w.client, json.dumps({"churn_risk": 0.6, "negative_share": 0.25, "signals": {"lead_quality": 1}, "groups": 1}),
                       w.org, b["chatId"], json.dumps({"days_start_to_live": 9.5, "revisions": 3, "messages": 4})))
    with api.transaction():
        set_tenant(api, w.org, w.editor)            # not a leader: nothing
        assert api.execute("select pulse.wa_company_insights() r").fetchone()["r"] is None
        assert api.execute("select pulse.wa_client_health(%s) r", (w.client,)).fetchone()["r"] is None
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.wa_insight_action_add('day-one','task',%s)", (w.project,))
    with api.transaction():
        set_tenant(api, w.org, w.lead)              # leadership
        d = api.execute("select pulse.wa_company_insights() r").fetchone()["r"]
        assert d["groups"] == 1 and d["messages"] == 4 and d["clients"] == 1 and d["path"]["days"]["startToLive"] == 9.5
        assert d["waits"]["sides"]["client"]["answers"] == 1 and d["waits"]["sides"]["client"]["medianMinutes"] == 10
        assert [s["stage"] for s in d["path"]["stages"]] == ["brief"] and d["wrong"]["funds"]["asks"] == 1
        assert d["wrong"]["atRisk"] == 1 and d["wrong"]["churn"][0]["clientId"] == str(w.client) and d["wrong"]["churn"][0]["leadQuality"] == 1
        assert {x["intent"] for x in d["asks"]["intents"]} == {"deliverable", "complaint"}          # client side only, greetings left out
        assert d["sop"]["steps"][0]["observed_share"] == 0.5
        again = api.execute("select pulse.wa_company_insights() r").fetchone()["r"]
        assert again["computedAt"] == d["computedAt"]                                               # kept, not recomputed
        h = api.execute("select pulse.wa_client_health(%s) r", (w.client,)).fetchone()["r"]
        assert h["metrics"]["churn_risk"] == 0.6 and h["groups"] == 1 and h["signals"][0]["kind"] == "lead_quality"
        assert len(h["waiting"]) == 1 and h["waiting"][0]["channelId"] == str(b["channelId"])       # the client wrote last
        assert h["sentiment"]["sentiment"] == -1
        tid = api.execute("""select pulse.task_save(null,'{"title":"Synthetic: make lead feedback a routine"}') id""").fetchone()["id"]
        api.execute("select pulse.wa_insight_action_add('lead-feedback','task',%s)", (tid,))
        acts = api.execute("select pulse.wa_insight_actions() r").fetchone()["r"]
        assert [(a["rec"], a["kind"], a["title"]) for a in acts] == [("lead-feedback", "task", "Synthetic: make lead feedback a routine")]
        assert api.execute("select pulse.wa_company_insights() r").fetchone()["r"]["actions"][0]["ref"] == str(tid)
    for table in ("wa_insights_cache",):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, w.org, w.lead)
                api.execute(f"select count(*) from pulse_priv.{table}")
