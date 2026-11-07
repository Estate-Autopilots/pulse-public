"""WA-DATASETS (1099) on real PostgreSQL: the imported WhatsApp history as a retrieval corpus. People search the chats
they may read by words and by meaning and see the ORIGINAL messages; an AI employee gets only the REDACTED text, only
inside a conversation it is a member of, only for that conversation's client; nobody reads the table directly. Every
group, name, number and vector here is synthetic."""

import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_agent_coworkers import as_agent, make_agent, owner_sql
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)
from test_wa_import import begin, load, msg, world


def unit(i):
    """A synthetic 768-d unit vector pointing along axis i."""
    return "[" + ",".join("1" if k == i else "0" for k in range(768)) + "]"


def chunk(owner, w, chat, key, body, client=None, axis=0):
    rows = owner_sql(owner, w, "select id from pulse_priv.wa_message where chat_id=%s order by seq", (chat,))
    cid = owner_sql(owner, w, """insert into pulse_priv.wa_chunk (org_id, chat_id, source_key, version, client_id, project_id, stage, first_at, last_at,
                                 messages, topics, langs, body, model)
                                 values (%s,%s,%s,'test',%s,%s,'live','2026-10-12T03:31:00Z','2026-10-12T03:40:00Z',%s,'{project}','{en}',%s,'synthetic')
                                 returning id""", (w.org, chat, key, client, w.project, [r["id"] for r in rows], body))[0]["id"]
    for a in (axis, 700):                                       # a chunk is as close as its closest message
        owner_sql(owner, w, "insert into pulse_priv.wa_chunk_vec (org_id, chunk_id, embedding) values (%s,%s,%s::public.halfvec)", (w.org, cid, unit(a)))


def search(api, w, who, **p):
    import json
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute("select pulse.wa_history_search(%s) r", (json.dumps(p),)).fetchone()["r"]


def test_people_search_their_history_and_ai_employees_read_only_redacted_text_of_their_client(worker, owner, api):
    w, people = world(worker, owner, api)
    one_ = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, one_["batchId"], [msg(1, "Synthetic: the 2 BHK price is 65 lakh"), msg(2, "Synthetic: noted, thanks", sender="s-client1")])
    two = begin(owner, w, source="grp-synthetic-2", members=[w.editor2], participants=people)
    load(owner, w, two["batchId"], [msg(1, "Synthetic: please add funds in the ad account")])
    chunk(owner, w, one_["chatId"], "c000001", "Group G001 · client CL001\n[2026-10-12 09:01] team T01: Synthetic: the 2 BHK price is 65 lakh", w.client, axis=0)
    chunk(owner, w, two["chatId"], "c000002", "Group G002 · client unknown\n[2026-10-12 09:01] team T01: Synthetic: please add funds", None, axis=1)
    assert owner_sql(owner, w, "select pulse.wa_terms_refresh() n")[0]["n"] > 10              # the loader's word counts

    # a member who is staff: by words, the original message as the preview and a link into the Pulse chat
    hits = search(api, w, w.editor, q="price")
    assert [h["chunkId"] is not None for h in hits] == [True] and hits[0]["channelId"] == str(one_["channelId"])
    assert hits[0]["preview"][0]["text"] == "Synthetic: the 2 BHK price is 65 lakh" and hits[0]["messageId"] is not None
    assert hits[0]["clientId"] == str(w.client) and hits[0]["messages"] == 2
    assert search(api, w, w.editor, q="funds") == []                                  # not a member of the other chat
    assert len(search(api, w, w.editor, q="what was the price of the flat?")) == 1     # any of the words, not all
    # by meaning: the vector alone ranks the chunk whose embedding points the same way
    by_meaning = search(api, w, w.manager, q="zzzz", vec=unit(1))
    assert [h["channelId"] for h in by_meaning] == [str(two["channelId"]), str(one_["channelId"])]
    assert len(search(api, w, w.manager, q="synthetic")) == 2                          # an admin reads every chat
    assert search(api, w, w.manager, q="synthetic", client=str(w.client))[0]["clientId"] == str(w.client)
    assert len(search(api, w, w.manager, q="synthetic", client=str(w.client))) == 1
    assert search(api, w, w.lead, q="synthetic") == []                                 # leadership by role only: nothing

    # an AI employee in the first chat: the redacted text of that client's history, nothing else
    agent, _ = make_agent(api, w, username="coordinator-ai")
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values (%s,%s,%s)", (w.org, one_["channelId"], agent))
    got = as_agent(api, w, agent, "select pulse.agent_wa_knowledge(%s,%s,%s,5) d", (one_["channelId"], "price", None))[0]["d"]
    assert [k["text"] for k in got] == ["Group G001 · client CL001\n[2026-10-12 09:01] team T01: Synthetic: the 2 BHK price is 65 lakh"]
    assert as_agent(api, w, agent, "select pulse.agent_wa_knowledge(%s,%s,%s,5) d", (two["channelId"], "funds", None))[0]["d"] == []
    assert as_agent(api, w, agent, "select pulse.wa_history_search(%s) r", ('{"q": "synthetic"}',))[0]["r"] == []   # never the originals
    with pytest.raises(psycopg.errors.InsufficientPrivilege):                         # people cannot use the agents' door
        with api.transaction():
            set_tenant(api, w.org, w.editor)
            api.execute("select pulse.agent_wa_knowledge(%s,'price',null,5)", (one_["channelId"],))
    for conn in (api, worker):                                                         # nobody reads the table itself
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                set_tenant(conn, w.org)
                conn.execute("select count(*) from pulse_priv.wa_chunk")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):                         # nor the ranking helper
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("select * from pulse.wa_chunk_rank(%s,'x',null,5)", ([str(uuid.uuid4())],))

    # the company opens client groups to all staff (1098 group access): a colleague outside the group finds it too
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_group_set(%s, %s)", ([two["channelId"]], '{"kind": "client"}'))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.chat_group_access_set('staff')")
    assert [h["channelId"] for h in search(api, w, w.editor, q="funds")] == [str(two["channelId"])]
