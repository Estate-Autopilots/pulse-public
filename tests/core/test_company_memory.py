"""EA-PATTERNS (2170) on real PostgreSQL: the company memory. A chunk is found only by people who may read its source
(imported chat → members and admins, as 1099; a task → its assignee, leaders, HR and admins; an invoice line → money
access); an AI employee never gets the original text of an imported WhatsApp chat (1099's redacted piece of the same
time, or nothing); words and meaning are fused; nobody reads the tables directly; risk scores follow the same rules.
Every group, name, number and vector here is synthetic."""

import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_agent_coworkers import as_agent, make_agent, owner_sql
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)
from test_wa_import import begin, load, msg, world


def unit(i, n=384):
    """A synthetic n-d unit vector pointing along axis i."""
    return "[" + ",".join("1" if k == i else "0" for k in range(n)) + "]"


def piece(owner, w, kind, key, title, body, access, ref=None, channel=None, client=None, events=(), axis=0, at="2026-10-12T03:31:00Z"):
    return owner_sql(owner, w, """insert into memory.chunk (org_id, source_kind, source_key, access, access_ref, channel_id, client_id, first_at, last_at,
                                  title, body, events, content_hash, embedding, model, link)
                                  values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::public.halfvec,'synthetic','/tasks')
                                  returning id""", (w.org, kind, key, access, ref, channel, client, at, at, title, body, list(events),
                                                    "0" * 32, unit(axis)))[0]["id"]


def search(api, w, who, **p):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute("select pulse.memory_search(%s) r", (json.dumps(p),)).fetchone()["r"]


def test_memory_finds_only_what_each_reader_may_read(worker, owner, api):
    w, people = world(worker, owner, api)
    one = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, one["batchId"], [msg(1, "Synthetic: the shoot is delayed again, very unhappy"), msg(2, "Synthetic: sorry, Monday", sender="s-client1")])
    two = begin(owner, w, source="grp-synthetic-2", members=[w.editor2], participants=people)
    load(owner, w, two["batchId"], [msg(1, "Synthetic: please add funds in the ad account")])
    # 1099's redacted piece of the first chat (what an AI employee may read)
    rows = owner_sql(owner, w, "select id from pulse_priv.wa_message where chat_id=%s order by seq", (one["chatId"],))
    owner_sql(owner, w, """insert into pulse_priv.wa_chunk (org_id, chat_id, source_key, version, client_id, first_at, last_at, messages, body, model)
                           values (%s,%s,'c000001','test',%s,'2026-10-12T03:00:00Z','2026-10-12T04:00:00Z',%s,'Group G001 · T01: Synthetic: the shoot is delayed [PR]','synthetic')""",
              (w.org, one["chatId"], w.client, [r["id"] for r in rows]))
    piece(owner, w, "whatsapp", "wa:one", "Group one · 12 Oct 2026", "Editor One: Synthetic: the shoot is delayed again, very unhappy",
          "wa_chat", one["chatId"], one["channelId"], w.client, events=("complaint", "delay"), axis=0)
    piece(owner, w, "whatsapp", "wa:two", "Group two · 12 Oct 2026", "Editor One: Synthetic: please add funds in the ad account",
          "wa_chat", two["chatId"], two["channelId"], None, events=("payment",), axis=1)
    task = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.task (id, org_id, title, status, assignee_person_id) values (%s,%s,'Synthetic reel edit','open',%s)", (task, w.org, w.editor2))
    piece(owner, w, "task", f"task:{task}", "Synthetic reel edit", "Synthetic reel edit\nstatus open", "task", task, axis=2)
    piece(owner, w, "invoice", "inv:SYN-0001", "Invoice SYN-0001", "Invoice SYN-0001 for Synthetic Developers: taxable Rs 50,000", "money", axis=3)
    assert owner_sql(owner, w, "select pulse.memory_terms_refresh() n")[0]["n"] > 10

    # a staff member of the first chat: that chat by words, with the citation (where, client, events, link)
    hits = search(api, w, w.editor, q="which clients said the shoot is delayed?")
    assert [h["title"] for h in hits] == ["Group one · 12 Oct 2026"]
    assert hits[0]["clientId"] == str(w.client) and hits[0]["events"] == ["complaint", "delay"] and hits[0]["channelId"] == str(one["channelId"])
    assert "very unhappy" in hits[0]["text"] and hits[0]["redacted"] is False and hits[0]["byWords"] is True
    assert search(api, w, w.editor, q="funds ad account") == []                       # not a member of the other chat
    for who in (w.editor, w.editor2, w.manager, w.lead):                              # a task: exactly when Pulse shows it to them
        with api.transaction():
            set_tenant(api, w.org, who)
            sees = api.execute("select count(*) n from pulse.task where id = %s", (task,)).fetchone()["n"] == 1
        assert [h["kind"] for h in search(api, w, who, q="reel edit")] == (["task"] if sees else [])
    owner_sql(owner, w, "update pulse.task set deleted_at = now() where id = %s", (task,))
    assert search(api, w, w.manager, q="reel edit") == []                             # a deleted task is gone at once
    owner_sql(owner, w, "update pulse.task set deleted_at = null where id = %s", (task,))
    assert search(api, w, w.editor2, q="invoice taxable") == []                       # no money access
    # an admin reads every chat; meaning alone ranks the chunk whose embedding points the same way
    by_meaning = search(api, w, w.manager, q="zzzz", vec=unit(1))
    assert by_meaning[0]["title"] == "Group two · 12 Oct 2026" and by_meaning[0]["byMeaning"] is True
    assert {h["title"] for h in search(api, w, w.manager, q="synthetic", kinds=["whatsapp"])} == {"Group one · 12 Oct 2026", "Group two · 12 Oct 2026"}
    assert [h["title"] for h in search(api, w, w.manager, q="synthetic", client=str(w.client))] == ["Group one · 12 Oct 2026"]
    assert search(api, w, w.manager, q="synthetic", **{"from": "2026-11-01"}) == []  # outside the dates asked
    assert [h["kind"] for h in search(api, w, w.lead, q="invoice taxable")] == ["invoice"]   # leadership: money access

    # an AI employee in the first chat: the citation with 1099's redacted text, never the original
    agent, _ = make_agent(api, w, username="memory-ai")
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values (%s,%s,%s)", (w.org, one["channelId"], agent))
    got = as_agent(api, w, agent, "select pulse.memory_search(%s) r", (json.dumps({"q": "shoot delayed"}),))[0]["r"]
    assert [h["title"] for h in got] == ["Group one · 12 Oct 2026"]
    assert got[0]["redacted"] is True and got[0]["text"] == "Group G001 · T01: Synthetic: the shoot is delayed [PR]" and "unhappy" not in json.dumps(got)
    assert as_agent(api, w, agent, "select pulse.memory_search(%s) r", (json.dumps({"q": "funds ad account"}),))[0]["r"] == []

    # nobody reads the tables or the ranking helper directly
    for conn in (api, worker):
        for table in ("memory.chunk", "memory.risk_score", "memory.model_card", "memory.term"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    set_tenant(conn, w.org)
                    conn.execute(f"select count(*) from {table}")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("select * from pulse.memory_rank('x', null, 5, null, null, null, null, '{}', '{}', '{}', true, true)")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):                         # signed out: refused
        with api.transaction():
            set_tenant(api, w.org)
            api.execute("select pulse.memory_search('{\"q\": \"x\"}')")


def test_risk_scores_follow_who_owns_the_client(worker, owner, api):
    w, _ = world(worker, owner, api)
    owner_sql(owner, w, "update pulse.client set relationship_owner_id = %s where id = %s", (w.editor, w.client))
    for model, kind, key, client, owner_id in (("churn", "client", str(w.client), w.client, None),
                                               ("late_payment", "client", str(w.client), w.client, None),
                                               ("delivery_delay", "task", str(uuid.uuid4()), None, w.editor2)):
        owner_sql(owner, w, """insert into memory.risk_score (org_id, model, subject_kind, subject_key, client_id, owner_id, label, score, band, reasons, as_of, model_version)
                               values (%s,%s,%s,%s,%s,%s,'Synthetic',0.7,'high',%s,now(),'test')""",
                  (w.org, model, kind, key, client, owner_id, json.dumps([{"text": "Synthetic reason", "weight": 1}])))
    owner_sql(owner, w, "insert into memory.model_card (org_id, model, version, method, evaluation) values (%s,'churn','test','synthetic','{\"auc\": 0.6}')", (w.org,))

    def risks(who, **p):
        with api.transaction():
            set_tenant(api, w.org, who)
            return api.execute("select pulse.memory_risks(%s) r", (json.dumps(p),)).fetchone()["r"]
    assert sorted(s["model"] for s in risks(w.lead)["scores"]) == ["churn", "delivery_delay", "late_payment"]   # leadership: all
    mine = risks(w.editor)["scores"]                                                     # the client's relationship owner
    assert [s["model"] for s in mine] == ["churn"] and mine[0]["reasons"] == [{"text": "Synthetic reason", "weight": 1}]
    assert [s["model"] for s in risks(w.editor2)["scores"]] == ["delivery_delay"]       # their own task only
    assert risks(w.lead, model="churn")["models"][0]["evaluation"] == {"auc": 0.6}
