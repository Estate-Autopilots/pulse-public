"""AGENT-MEMORY (1840): the AI-employee bugs seen in the 7 Nov demo, fixed with typed rules and proven here.
1. "Can you remember that?" is kept as a note (about a colleague, by who asked) and can be undone; never a task.
2. "I have noted that every quotation should mention …" from its owner becomes a behaviour rule with who set it and when,
   and a later quotation the AI employee drafts carries it in its terms (a person's own quotation is untouched); from a
   plain colleague it stays a note about them.
3. Out of budget: where it stands (80% warns its budget approver once), the waiting person is answered in words, and an
   admin's one-click "Add budget" raises the cap and answers the held messages.
4. Activity lists group conversations to their members only, never direct messages.
5. Who gives the final approval, per kind of action: its owner by default, then whoever is chosen.
6. Notes about one person are given only to runs with that person, not to every conversation.
Synthetic tenants, people and figures only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_agent_coworkers import agent_one, ask, claim, dispatch, make_agent, owner_sql
from test_erp_invoice import SELLER, _seed_erp_world, erp, one  # noqa: F401  (erp is a fixture)
from test_runner_access import _agent, _as_agent
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)


def open_ai(owner, w, agent, tools=("chats", "tasks", "memory")):
    """An AI employee that answers everyone on its own, in direct messages and mentions."""
    owner_sql(owner, w, "update pulse.agent_member set tools=%s, listens_to='everyone', autonomy=%s, daily_token_budget=500000 where person_id=%s",
              (list(tools), Jsonb({"direct": "own", "mention": "own", "group": "own"}), agent))


def run_for(api, w, agent):
    """Claim and dispatch its next chat event, as its runtime does: the run and its context."""
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    assert d["status"] == "dispatched", d
    return d["runId"], d["context"]


def done(api, w, agent, run):
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null)", (run,))


def remember(api, w, agent, run, p):
    return agent_one(api, w, agent, "select pulse.agent_remember(%s,%s) r", (run, Jsonb(p)))["r"]


def username(owner, w, person):
    return owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (person,))[0]["username"]


def test_remember_is_a_note_about_a_colleague_with_undo_and_per_person_notes(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "memo-test")
    open_ai(owner, w, agent)
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "Pod head reviews quotes only after lunch (synthetic)")
    run, _ = run_for(api, w, agent)
    done(api, w, agent, run)
    ask(api, w, w.manager, dm, "Can you remember that?")
    run, _ = run_for(api, w, agent)
    head = username(owner, w, w.editor2)
    saved = remember(api, w, agent, run, {"kind": "note", "body": "Pod head reviews quotes only after lunch (synthetic)", "aboutUsername": head})
    done(api, w, agent, run)
    assert saved["kind"] == "note" and saved["about"]["id"] == str(w.editor2) and not saved["downgraded"]
    row = owner_sql(owner, w, "select source, said_by, created_by, about_person_id, channel_id from pulse.agent_memory where id=%s", (saved["id"],))[0]
    assert row == {"source": "chat", "said_by": w.manager, "created_by": w.manager, "about_person_id": w.editor2, "channel_id": dm}
    assert not owner_sql(owner, w, "select 1 from pulse.agent_proposal where agent_id=%s and kind='task'", (agent,)), "never a task"
    # Per person: given to runs with the pod head only; the general notes every run gets leave it out.
    assert agent_one(api, w, agent, "select pulse.agent_notes_for(%s) n", (w.editor2,))["n"]["about"] == ["Pod head reviews quotes only after lunch (synthetic)"]
    assert agent_one(api, w, agent, "select pulse.agent_notes_for(%s) n", (w.editor,))["n"]["about"] == []
    ask(api, w, w.manager, dm, "What is on today?")
    run, ctx = run_for(api, w, agent)
    assert "Pod head reviews quotes only after lunch (synthetic)" not in ctx["memory"]
    done(api, w, agent, run)
    # Undo: the newest thing this person asked it to keep here, within 30 minutes.
    ask(api, w, w.manager, dm, "undo")
    run, _ = run_for(api, w, agent)
    u = agent_one(api, w, agent, "select pulse.agent_remember_undo(%s) r", (run,))["r"]
    assert u == {"undone": True, "kind": "note", "body": "Pod head reviews quotes only after lunch (synthetic)"}
    assert agent_one(api, w, agent, "select pulse.agent_remember_undo(%s) r", (run,))["r"] == {"undone": False}
    done(api, w, agent, run)
    assert owner_sql(owner, w, "select retired_by from pulse.agent_memory where id=%s", (saved["id"],))[0]["retired_by"] == w.manager
    # A plain colleague's "always …" is kept as a note about them, not a rule for everyone.
    edm = one(api, w, w.editor, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.editor, edm, "Always send me the draft first")
    run, _ = run_for(api, w, agent)
    r = remember(api, w, agent, run, {"kind": "rule", "body": "Always send me the draft first"})
    done(api, w, agent, run)
    assert r["kind"] == "note" and r["downgraded"] and r["about"]["id"] == str(w.editor) and r["canSetRules"]
    assert not owner_sql(owner, w, "select 1 from pulse.agent_rule where agent_id=%s", (agent,))
    # Outside a run of a chat message, nothing is kept.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="inside the run"):
        remember(api, w, agent, run, {"kind": "note", "body": "Late note"})
    # The Knowledge tab: every colleague reads it; whoever manages it edits notes; rules need its owner, approvers or leaders.
    k = one(api, w, w.editor, "select pulse.agent_knowledge(%s) k", (agent,))["k"]
    assert not k["canEdit"] and not k["canRule"] and [n["about"] for n in k["notes"]] == [one(api, w, w.editor, "select display_name n from pulse.person where id=%s", (w.editor,))["n"]]
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.editor, "select pulse.agent_note_save(%s,%s)", (agent, Jsonb({"body": "Mine now"})))
    nid = one(api, w, w.manager, "select pulse.agent_note_save(%s,%s) id", (agent, Jsonb({"body": "Prefers voice notes (synthetic)", "aboutPersonId": str(w.editor2)})))["id"]
    one(api, w, w.manager, "select pulse.agent_note_save(%s,%s) id", (agent, Jsonb({"id": str(nid), "body": "Prefers short voice notes (synthetic)", "aboutPersonId": str(w.editor2)})))
    k = one(api, w, w.manager, "select pulse.agent_knowledge(%s) k", (agent,))["k"]
    edited = next(n for n in k["notes"] if n["id"] == str(nid))
    assert k["canEdit"] and k["canRule"] and edited["body"] == "Prefers short voice notes (synthetic)" and edited["aboutId"] == str(w.editor2) and edited["editedAt"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_rule_save(%s,%s)", (agent, Jsonb({"body": "Never reply after 9 pm"})))
    rid = one(api, w, w.manager, "select pulse.agent_rule_save(%s,%s) id", (agent, Jsonb({"body": "Never reply to clients after 9 pm"})))["id"]
    assert agent_one(api, w, agent, "select pulse.agent_notes_for(null) n", ())["n"]["rules"][0]["body"] == "Never reply to clients after 9 pm"
    one(api, w, w.manager, "select pulse.agent_rule_retire(%s)", (rid,))
    assert agent_one(api, w, agent, "select pulse.agent_notes_for(null) n", ())["n"]["rules"] == []


def test_a_quotation_rule_from_its_owner_is_kept_and_a_later_quotation_follows_it(api, worker, owner, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    aid = _agent(owner, w, w.founder)
    open_ai(owner, w, aid, ("billing", "chats", "memory"))
    dm = one(api, w, w.founder, "select pulse.chat_direct(%s) id", (aid,))["id"]
    said = "I have noted that every quotation should mention 50% advance with the order"
    ask(api, w, w.founder, dm, said)
    run, _ = run_for(api, w, aid)
    r = remember(api, w, aid, run, {"kind": "rule", "body": "Every quotation should mention 50% advance with the order"})
    done(api, w, aid, run)
    assert r["kind"] == "rule" and r["scope"] == "quotation" and r["include"] == "50% advance with the order"
    rule = owner_sql(owner, w, "select set_by, set_at, source, channel_id from pulse.agent_rule where id=%s", (r["id"],))[0]
    assert rule["set_by"] == w.founder and rule["set_at"] and rule["source"] == "chat" and rule["channel_id"] == dm, "who set it and when"
    shown = one(api, w, w.member, "select pulse.agent_knowledge(%s) k", (aid,))["k"]["rules"][0]
    assert shown["setBy"] == "Neha Founder" and shown["include"] == "50% advance with the order"

    def draft(as_ai, name, notes=""):
        with api.transaction():
            if as_ai:
                _as_agent(api, w, aid)
            else:
                set_tenant(api, w.org, w.finance)
            did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,notes,created_by)
                values(%s,'quotation',(now() at time zone 'Asia/Kolkata')::date,%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s,%s) returning id""",
                              (w.org, Jsonb(SELLER), Jsonb({"name": name, "stateCode": "27"}), notes, aid if as_ai else w.finance)).fetchone()["id"]
        return did

    terms = lambda did: owner_sql(owner, w, "select terms from pulse.erp_document where id=%s", (did,))[0]["terms"]  # noqa: E731
    later = draft(True, "Synthetic Later Client")
    assert terms(later) == "50% advance with the order", "a later quotation follows the rule"
    with api.transaction():     # changing its draft does not add it twice
        _as_agent(api, w, aid)
        api.execute("update pulse.erp_document set notes='Revised lines (synthetic)' where id=%s", (later,))
    assert terms(later) == "50% advance with the order"
    said_already = draft(True, "Synthetic Said Client", notes="Terms: 50% advance with the order, rest on delivery")
    assert terms(said_already) is None, "already said in its notes"
    assert terms(draft(False, "Synthetic Person Client")) is None, "a person's own quotation is theirs to word"
    one(api, w, w.founder, "select pulse.agent_rule_retire(%s)", (r["id"],))
    assert terms(draft(True, "Synthetic After Client")) is None, "a removed rule no longer applies"


def test_budget_warns_answers_in_words_and_admins_add_more(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "budget-test")
    open_ai(owner, w, agent)
    owner_sql(owner, w, "insert into pulse_priv.ai_employee_cap(org_id,person_id,monthly_tokens,set_by) values(%s,%s,10000,%s)", (w.org, agent, w.manager))
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "Draft the weekly note (synthetic)")
    run, _ = run_for(api, w, agent)
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',8500,3,null)", (run,))
    st = one(api, w, w.editor, "select pulse.agent_budget_state(%s) s", (agent,))["s"]
    assert st["level"] == "warn" and st["period"] == "month" and st["month"] == {"used": 8500, "limit": 10000, "share": 85} and not st["canAdd"]
    assert st["owner"]["id"] == str(w.manager), "its owner by default"
    assert agent_one(api, w, agent, "select pulse.agent_budget_notify('warn',%s,'Heads up (synthetic): 85%% used') t", (st["key"],))["t"] is True
    assert agent_one(api, w, agent, "select pulse.agent_budget_notify('warn',%s,'Heads up (synthetic): 85%% used') t", (st["key"],))["t"] is False, "once"
    assert owner_sql(owner, w, "select count(*)::int n from pulse.chat_message where channel_id=%s and author_id=%s and body like 'Heads up (synthetic)%%'", (dm, agent))[0]["n"] == 1
    # Out: a colleague's message is refused for budget and answered in words, once.
    owner_sql(owner, w, "update pulse.agent_run set tokens=10000 where id=%s", (run,))
    assert one(api, w, w.manager, "select pulse.agent_budget_state(%s) s", (agent,))["s"]["level"] == "out"
    edm = one(api, w, w.editor, "select pulse.chat_direct(%s) id", (agent,))["id"]
    asked = ask(api, w, w.editor, edm, "Can you check the invoice? (synthetic)")
    [c] = claim(api, w, agent)
    assert dispatch(api, w, agent, c) == {"status": "refused", "reason": "budget_spent"}
    text = "I've used this month's budget. Synthetic Manager can add more here: https://x.example/people/ai/x I'll answer this as soon as it's added."
    told = agent_one(api, w, agent, "select pulse.agent_budget_reply(%s,null,%s) r", (c["event"]["id"], text))["r"]
    assert told["status"] == "told" and told["messageId"]
    assert agent_one(api, w, agent, "select pulse.agent_budget_reply(%s,null,%s) r", (c["event"]["id"], text))["r"]["status"] == "already"
    reply = owner_sql(owner, w, "select channel_id, author_id, body from pulse.chat_message where id=%s", (told["messageId"],))[0]
    assert reply == {"channel_id": edm, "author_id": agent, "body": text}, "never silent"
    # Claimed while out (the runtime knows first): answered the same way, the event closes.
    ask(api, w, w.editor, edm, "Are you there? (synthetic)")
    [c2] = claim(api, w, agent)
    assert agent_one(api, w, agent, "select pulse.agent_budget_reply(%s,%s,%s) r", (c2["event"]["id"], c2["leaseToken"], text))["r"]["status"] == "told"
    # One click for admins: the month grows, the held messages are answered now.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_budget_add(%s,'auto')", (agent,))
    added = one(api, w, w.manager, "select pulse.agent_budget_add(%s,'auto') r", (agent,))["r"]
    assert added["scope"] == "month" and added["added"] == 100000 and added["budget"]["level"] == "ok"
    held = owner_sql(owner, w, "select state, reason from pulse.agent_event where agent_id=%s and subject_id=%s", (agent, asked))[0]
    assert held == {"state": "queued", "reason": None}
    # The budget ask goes to the final approver chosen for budget.
    one(api, w, w.manager, "select pulse.agent_final_approver_set(%s,'budget',%s)", (agent, w.lead))
    ask_card = agent_one(api, w, agent, "select pulse.agent_budget_ask(null,%s,%s) r", (Jsonb({"scope": "day", "estimate": "50000", "why": "Synthetic"}), uuid.uuid4()))["r"]
    assert owner_sql(owner, w, "select approver_id from pulse.agent_proposal where id=%s", (ask_card["id"],))[0]["approver_id"] == w.lead


def test_final_approver_per_kind_of_action_defaults_to_the_owner(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "approve-test")
    usual = {a["action"]: a for a in one(api, w, w.editor, "select pulse.agent_final_approvers(%s) a", (agent,))["a"]}
    assert set(usual) == {"message", "task", "quotation", "budget"} and all(a["personId"] == str(w.manager) and not a["chosen"] for a in usual.values())
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.editor, "select pulse.agent_final_approver_set(%s,'task',%s)", (agent, w.editor))
    a = {x["action"]: x for x in one(api, w, w.manager, "select pulse.agent_final_approver_set(%s,'task',%s) a", (agent, w.lead))["a"]}
    assert a["task"]["personId"] == str(w.lead) and a["task"]["chosen"] and a["message"]["personId"] == str(w.manager)
    assert owner_sql(owner, w, "select pulse.agent_approver_for(%s,null) p", (agent,))[0]["p"] == w.manager, "messages keep their approver"
    one(api, w, w.manager, "select pulse.agent_final_approver_set(%s,'message',%s)", (agent, w.editor2))
    assert owner_sql(owner, w, "select pulse.agent_approver_for(%s,null) p", (agent,))[0]["p"] == w.editor2
    one(api, w, w.manager, "select pulse.agent_final_approver_set(%s,'message',null)", (agent,))
    assert owner_sql(owner, w, "select pulse.agent_approver_for(%s,null) p", (agent,))[0]["p"] == w.manager, "cleared: back to the default"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.manager, "select pulse.agent_final_approver_set(%s,'payroll',%s)", (agent, w.lead))


def test_activity_lists_group_conversations_to_their_members_only(api, worker, owner, team):  # noqa: F811
    w = team
    g = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,'Synthetic launch group','group')", (w.org, g, f"group:{g}"))
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s),(%s,%s,%s)", (w.org, g, w.editor, w.org, g, w.manager))
    ask(api, w, w.editor, g, "Shoot moved to Friday (synthetic)")
    private = one(api, w, w.editor, "select pulse.chat_direct(%s) id", (w.manager,))["id"]
    ask(api, w, w.editor, private, "Private hello (synthetic)")
    seen = one(api, w, w.manager, "select pulse.activity_chats('all',50,0) r", ())["r"]
    assert [x["text"] for x in seen if x["channelId"] == str(g)] == ["Shoot moved to Friday (synthetic)"]
    item = next(x for x in seen if x["channelId"] == str(g))
    assert item["channel"] == "Synthetic launch group" and item["kind"] == "group" and not item["byAi"] and item["authorId"] == str(w.editor)
    assert not any("Private hello" in x["text"] for x in seen), "direct messages are never listed"
    assert one(api, w, w.outsider, "select pulse.activity_chats('all',50,0) r", ())["r"] == [], "not a member: nothing"
    assert one(api, w, w.manager, "select pulse.activity_chats('pod',50,0) r", ())["r"] == []
