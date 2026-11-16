"""AGENT-UI-CONTROL (1745): an AI employee drives the screen of the person it is helping. Only someone who wrote to it in
the last 30 minutes (never a client conversation); within its level (view < act < admin) at once, above it a prompt that
admins and leadership answer (Allow once / Always / No) and the person may allow once up to act on their own screen;
the first browser tab takes each action and reports back; every action is a row (the audit trail); cards in the chat
are filled in as the person. Plus the quotation agent's tools (clients, projects, tasks) as an AI member with the
tools it is given. Synthetic data only."""
import json
import pathlib
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, as_agent, make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

CATALOGUE = json.loads((pathlib.Path(__file__).resolve().parents[2] / "services/api/data/agent-ui-actions.json").read_text())


def say(api, w, who, channel, text):
    return one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]',%s,null) id", (channel, text, uuid.uuid4()))["id"]


def ask(api, w, agent, target, action, args=None, why="Synthetic reason"):
    return agent_one(api, w, agent, "select pulse.agent_ui_request(%s,%s,%s,%s) r", (target, action, Jsonb(args or {}), why))["r"]


def pending(api, w, who):
    return one(api, w, who, "select pulse.agent_ui_pending() p")["p"]


def helped(api, w, agent, person, text="Synthetic: please open the quotation"):
    dm = one(api, w, person, "select pulse.chat_direct(%s) id", (agent,))["id"]
    say(api, w, person, dm, text)
    return dm


def test_catalogue_levels_match_the_database(api, team):  # noqa: F811
    w = team
    for a in CATALOGUE["actions"]:
        assert one(api, w, w.editor, "select pulse.agent_ui_action_level(%s,'{}') l", (a["name"],))["l"] == a["level"], a["name"]
    for path in ("/settings?tab=ai", "/admin", "https://pulse.example/platform/x"):
        assert one(api, w, w.editor, "select pulse.agent_ui_action_level('page.open',%s) l", (Jsonb({"path": path}),))["l"] == "admin"
    assert one(api, w, w.editor, "select pulse.agent_ui_action_level('panel.open',%s) l", (Jsonb({"target": "/erp/documents/x"}),))["l"] == "view"
    for form in CATALOGUE["actions"][[a["name"] for a in CATALOGUE["actions"]].index("form.open")]["adminForms"]:
        assert one(api, w, w.editor, "select pulse.agent_ui_action_level('form.open',%s) l", (Jsonb({"form": form}),))["l"] == "admin"
    assert one(api, w, w.editor, "select pulse.agent_ui_action_level('screen.wipe','{}') l")["l"] is None
    # FIX-CHAT-AI: a click that deletes, sends, pays or approves is risky; AGENT-OPERATOR (2080): it needs "confirm" (asked
    # every time, only the person whose screen it is says yes); any other click and a fill need act.
    for words, level in [("Remove", "confirm"), ("Delete line", "confirm"), ("Send for approval", "confirm"), ("Pay now", "confirm"), ("Save", "act"), ("Add line", "act"), ("Open", "act")]:
        assert one(api, w, w.editor, "select pulse.agent_ui_action_level('element.click',%s) l", (Jsonb({"target": "b1", "text": words}),))["l"] == level, words
    assert one(api, w, w.editor, "select pulse.agent_ui_action_level('field.fill',%s) l", (Jsonb({"target": "f1", "field": "Client", "value": "x"}),))["l"] == "act"


def test_only_the_person_it_is_helping_and_the_first_tab_takes_it(api, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "pip-screen-synthetic")
    # Nobody wrote to it: it may drive nobody's screen.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ask(api, w, agent, w.editor, "panel.open", {"target": "/tasks"})
    dm = helped(api, w, agent, w.editor)
    r = ask(api, w, agent, w.editor, "panel.open", {"target": "/erp/documents/0a0a0a0a-0000-4000-8000-000000000001", "title": "Quotation Q-1"})
    assert r["state"] == "sent" and r["needed"] == "view" and r["channelId"] == str(dm) and r["agent"]["name"] == "Pip Screen Synthetic"
    # Still nobody else's: a colleague who did not write to it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ask(api, w, agent, w.editor2, "sidebar.set", {"open": False})
    p = pending(api, w, w.editor)
    assert [a["id"] for a in p["actions"]] == [r["id"]] and p["asks"] == [] and p["manager"] is False
    assert pending(api, w, w.editor2)["actions"] == []
    # Another person cannot take it; the person's first tab does, the second gets nothing.
    assert one(api, w, w.editor2, "select pulse.agent_ui_claim(%s) c", (r["id"],))["c"] is None
    assert one(api, w, w.editor, "select pulse.agent_ui_claim(%s) c", (r["id"],))["c"]["state"] == "claimed"
    assert one(api, w, w.editor, "select pulse.agent_ui_claim(%s) c", (r["id"],))["c"] is None
    done = one(api, w, w.editor, "select pulse.agent_ui_done(%s,true,%s,null) d", (r["id"], Jsonb({"opened": "panel"})))["d"]
    assert done["state"] == "done" and done["result"] == {"opened": "panel"}
    # The AI employee reads how it went; the person's browser no longer has it.
    assert agent_one(api, w, agent, "select pulse.agent_ui_status(%s) s", (r["id"],))["s"]["state"] == "done"
    assert pending(api, w, w.editor)["actions"] == []
    # Every action is kept (the audit trail): who, for whom, what, when.
    rows = owner_sql(owner, w, "select agent_id, target_id, action, state, decided_by from pulse.agent_ui_action where org_id=%s order by created_at", (w.org,))
    assert [(x["agent_id"], x["target_id"], x["action"], x["state"]) for x in rows] == [(agent, w.editor, "panel.open", "done")]
    # Never in a conversation with a client in it.
    client = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Person','client')", (client, w.org))
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, dm, client))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ask(api, w, agent, w.editor, "panel.close")


def test_above_its_level_it_asks_and_one_click_allows(api, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "pip-asks-synthetic")
    helped(api, w, agent, w.editor)
    r = ask(api, w, agent, w.editor, "emoji.insert", {"emoji": "🎉"})
    assert r["state"] == "asked" and r["needed"] == "act" and "asked in the top bar" in r["message"]
    # Asking again does not make a second prompt.
    assert ask(api, w, agent, w.editor, "emoji.insert", {"emoji": "🎉"})["id"] == r["id"]
    mine = pending(api, w, w.editor)["asks"]
    assert [(a["id"], a["mine"], a["canAlways"]) for a in mine] == [(r["id"], True, False)]
    # The admin sees every open prompt; another member sees none.
    assert [a["id"] for a in pending(api, w, w.manager)["asks"]] == [r["id"]] and pending(api, w, w.manager)["asks"][0]["canAlways"] is True
    assert pending(api, w, w.editor2)["asks"] == []
    # The person may allow once on their own screen, never "always"; the AI employee never answers its own prompt.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_ui_decide(%s,'always')", (r["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_ui_decide(%s,'once')", (r["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor2, "select pulse.agent_ui_decide(%s,'once')", (r["id"],))
    d = one(api, w, w.editor, "select pulse.agent_ui_decide(%s,'once') d", (r["id"],))["d"]
    assert d["state"] == "sent" and d["decision"] == "once" and d["decidedBy"] == "Editor One"
    assert [a["id"] for a in pending(api, w, w.editor)["actions"]] == [r["id"]]
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        one(api, w, w.manager, "select pulse.agent_ui_decide(%s,'no')", (r["id"],))
    # Once is once: the next one asks again; the admin's "Always" keeps that kind allowed from now on.
    r2 = ask(api, w, agent, w.editor, "emoji.insert", {"emoji": "👍"})
    assert r2["state"] == "asked"
    assert one(api, w, w.manager, "select pulse.agent_ui_decide(%s,'always') d", (r2["id"],))["d"]["state"] == "sent"
    assert ask(api, w, agent, w.editor, "emoji.insert", {"emoji": "✅"})["state"] == "sent"
    # Always for one kind is not a higher level: typing in the message box still asks.
    assert ask(api, w, agent, w.editor, "composer.insert", {"text": "Synthetic draft"})["state"] == "asked"
    s = one(api, w, w.manager, "select pulse.agent_ui_settings(%s) s", (agent,))["s"]
    assert s["level"] == "view" and [(x["action"], x["level"]) for x in s["allows"]] == [("emoji.insert", "act")] and len(s["recent"]) == 4
    # Removing it asks again.
    one(api, w, w.manager, "select pulse.agent_ui_allow_remove(%s,'emoji.insert')", (agent,))
    assert ask(api, w, agent, w.editor, "emoji.insert", {"emoji": "🙂"})["state"] == "asked"


def test_admin_screens_need_admin_and_levels_are_set_by_leaders(api, worker, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "pip-admin-synthetic")
    helped(api, w, agent, w.editor)
    r = ask(api, w, agent, w.editor, "page.open", {"path": "/settings?tab=ai"})
    assert r["state"] == "asked" and r["needed"] == "admin"
    # Their own screen, but an admin screen: the person sees no prompt to answer and cannot answer it.
    assert pending(api, w, w.editor)["asks"] == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_ui_decide(%s,'once')", (r["id"],))
    assert one(api, w, w.manager, "select pulse.agent_ui_decide(%s,'no') d", (r["id"],))["d"]["state"] == "refused"
    # Levels: admins and leadership set them, never a member or the AI employee itself.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_ui_level_set(%s,'admin')", (agent,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_ui_level_set(%s,'admin')", (agent,))
    assert one(api, w, w.manager, "select pulse.agent_ui_level_set(%s,'admin') s", (agent,))["s"]["level"] == "admin"
    assert ask(api, w, agent, w.editor, "page.open", {"path": "/settings?tab=ai"})["state"] == "sent"
    # Off: no screen actions and no prompts, and what was waiting ends.
    waiting = ask(api, w, agent, w.editor, "sidebar.set", {"open": True})
    one(api, w, w.manager, "select pulse.agent_ui_level_set(%s,'off')", (agent,))
    assert pending(api, w, w.editor)["actions"] == []
    assert agent_one(api, w, agent, "select pulse.agent_ui_status(%s) s", (waiting["id"],))["s"]["state"] == "refused"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ask(api, w, agent, w.editor, "sidebar.set", {"open": True})
    # Unknown actions and bad details are refused.
    one(api, w, w.manager, "select pulse.agent_ui_level_set(%s,'view')", (agent,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        ask(api, w, agent, w.editor, "screen.wipe")


def test_a_persons_own_token_drives_only_their_own_screen(api, team):  # noqa: F811
    w = team
    r = one(api, w, w.editor, "select pulse.agent_ui_request(null,'page.open',%s,null) r", (Jsonb({"path": "/settings"}),))["r"]
    assert r["state"] == "sent" and r["target"]["id"] == str(w.editor) and r["agent"]["name"] == "You"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_ui_request(%s,'page.open',%s,null)", (w.editor2, Jsonb({"path": "/tasks"})))
    assert one(api, w, w.editor, "select pulse.agent_ui_status(%s) s", (r["id"],))["s"]["state"] == "sent"
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.editor2, "select pulse.agent_ui_status(%s)", (r["id"],))


def test_cards_in_the_chat_are_filled_in_as_the_person(api, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "quote-card-synthetic")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'client.add','x','Add client','{}',null)", (w.editor,))
    dm = helped(api, w, agent, w.editor, "Synthetic: quote for Riverside Synthetic Realty")
    c = agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'client.add',%s,'Add the client',%s,%s) c",
                  (w.editor, "I could not find Riverside Synthetic Realty in Clients. Add them here and I will carry on.", Jsonb({"name": "Riverside Synthetic Realty"}), uuid.uuid4()))["c"]
    assert c["channelId"] == str(dm) and c["state"] == "open"
    # The card comes with its message, under the person's own row security; a colleague outside the chat cannot see it.
    seen = one(api, w, w.editor, "select m.body, k.kind, k.fields from pulse.chat_message m join pulse.agent_ui_card k on k.message_id=m.id where m.id=%s", (c["messageId"],))
    assert seen["kind"] == "client.add" and seen["fields"]["name"] == "Riverside Synthetic Realty" and seen["body"].startswith("I could not find")
    assert one(api, w, w.editor2, "select count(*)::int n from pulse.agent_ui_card where id=%s", (c["cardId"],))["n"] == 0
    # The person's own permissions decide: a member does not add clients (as on Clients) and the card stays open.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_ui_card_submit(%s,%s)", (c["cardId"], Jsonb({"name": "Riverside Synthetic Realty"})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_ui_card_submit(%s,%s)", (c["cardId"], Jsonb({"name": "x"})))
    # The admin in the same conversation adds them: the client exists, the card is done and the chat says so as them.
    helped(api, w, agent, w.manager, "Synthetic: add Harbour Synthetic Homes")
    c2 = agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'client.add','Add Harbour Synthetic Homes to Clients?','Add the client',%s,null) c",
                   (w.manager, Jsonb({"name": "Harbour Synthetic Homes", "phone": "+91 90000 00000"})))["c"]
    r = one(api, w, w.manager, "select pulse.agent_ui_card_submit(%s,%s) r", (c2["cardId"], Jsonb({"name": "Harbour Synthetic Homes", "phone": "+91 90000 00000", "city": "Synthetic City"})))["r"]
    assert r["state"] == "done" and r["result"]["name"] == "Harbour Synthetic Homes"
    assert owner_sql(owner, w, "select display_name, city from pulse.client where id=%s", (r["result"]["clientId"],)) == [{"display_name": "Harbour Synthetic Homes", "city": "Synthetic City"}]
    said = owner_sql(owner, w, "select author_id, body from pulse.chat_message where id=%s", (r["messageId"],))[0]
    assert said == {"author_id": w.manager, "body": "Added the client “Harbour Synthetic Homes”."}
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        one(api, w, w.manager, "select pulse.agent_ui_card_submit(%s,%s)", (c2["cardId"], Jsonb({"name": "Again"})))
    # A choice card takes only its options; closing a card leaves it closed.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'choice','Which one?','Pick the client',%s,null)", (w.editor, Jsonb({"options": ["Only one"]})))
    ch = agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'choice','Which one?','Pick the client',%s,null) c", (w.editor, Jsonb({"options": ["Riverside", "Harbour"]})))["c"]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.editor, "select pulse.agent_ui_card_submit(%s,%s)", (ch["cardId"], Jsonb({"choice": "Someone else"})))
    assert one(api, w, w.editor, "select pulse.agent_ui_card_submit(%s,%s) r", (ch["cardId"], Jsonb({"choice": "Harbour"})))["r"]["result"] == {"choice": "Harbour"}
    t = agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'task.add','Shall I note it?','Add a task',%s,null) c", (w.editor, Jsonb({"title": "Call Riverside"})))["c"]
    assert one(api, w, w.editor, "select pulse.agent_ui_card_dismiss(%s) r", (t["cardId"],))["r"]["state"] == "dismissed"
    # Each card is in the audit trail too.
    assert len(owner_sql(owner, w, "select 1 from pulse.agent_ui_action where org_id=%s and action='card.show'", (w.org,))) == 4


def tools(owner, w, agent, names):
    owner_sql(owner, w, "update pulse.agent_member set tools=%s where org_id=%s and person_id=%s", (names, w.org, agent))


def test_the_quotation_agent_finds_and_adds_clients_and_makes_projects_and_tasks(api, owner, team):  # noqa: F811
    """The tools the quotation agent holds on production ({billing,chats,tasks}, standard access): it finds and adds a
    client itself; a standard AI employee proposes tasks and projects (Pulse's rule since EA-AI), so it posts a filled-in
    card and the person adds it in one click, as themselves. With operations access (an admin's choice) it makes them
    itself."""
    w = team
    agent, _ = make_agent(api, w, "quotation-synthetic")
    tools(owner, w, agent, ["billing", "chats", "tasks"])
    cid = agent_one(api, w, agent, "select pulse.v1_client_create(%s) id", (Jsonb({"name": "Lakeview Synthetic Developers", "phone": "+91 90000 00001"}),))["id"]
    assert agent_one(api, w, agent, "select display_name from pulse.client where id=%s", (cid,))["display_name"] == "Lakeview Synthetic Developers"
    # Without Billing it does not add clients.
    plain, _ = make_agent(api, w, "plain-synthetic")
    tools(owner, w, plain, ["chats", "tasks"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, plain, "select pulse.v1_client_create(%s)", (Jsonb({"name": "Nope Synthetic"}),))
    # Standard access: no task or project of its own making ...
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.work_project_save(null,%s)", (Jsonb({"type": "internal", "name": "Lakeview Synthetic launch"}),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.task_save(null,%s)", (Jsonb({"title": "Send Lakeview the revised quotation"}),))
    # ... so it posts the card, and the person adds it in one click (here the admin, who may make projects).
    helped(api, w, agent, w.manager, "Synthetic: start the Lakeview project and remind me to send the quote")
    pc = agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'project.add','Shall I set up the project?','Add the project',%s,null) c",
                   (w.manager, Jsonb({"name": "Lakeview Synthetic launch"})))["c"]
    made = one(api, w, w.manager, "select pulse.agent_ui_card_submit(%s,%s) r", (pc["cardId"], Jsonb({"name": "Lakeview Synthetic launch"})))["r"]
    assert made["state"] == "done" and made["result"]["projectId"]
    tc = agent_one(api, w, agent, "select pulse.agent_ui_card_post(%s,'task.add','And the reminder?','Add a task',%s,null) c",
                   (w.manager, Jsonb({"title": "Send Lakeview the revised quotation", "dueOn": "2026-11-09"})))["c"]
    made = one(api, w, w.manager, "select pulse.agent_ui_card_submit(%s,%s) r", (tc["cardId"], Jsonb({"name": "Send Lakeview the revised quotation", "dueOn": "2026-11-09"})))["r"]
    assert one(api, w, w.manager, "select title from pulse.task where id=%s", (made["result"]["taskId"],))["title"] == "Send Lakeview the revised quotation"
    # With operations access (an admin gives it) it makes them itself.
    owner_sql(owner, w, "update pulse.agent_member set access='operations' where org_id=%s and person_id=%s", (w.org, agent))
    p = agent_one(api, w, agent, "select pulse.work_project_save(null,%s) p", (Jsonb({"type": "internal", "name": "Lakeview Synthetic phase two", "ownerId": str(w.manager)}),))["p"]
    assert p.get("id") or p.get("projectId")
    # (API v1's create_task gives an AI member's task its manager as the reviewer, as here.)
    t = agent_one(api, w, agent, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Call Lakeview about phase two", "assigneeId": str(w.editor), "reviewerId": str(w.manager)}),))["id"]
    assert t
