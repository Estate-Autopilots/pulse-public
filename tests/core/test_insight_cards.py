"""INSIGHTS-2 (1082, 1086) on real PostgreSQL: insight cards, the pattern library and the live client-operations facts.
Leadership and admins read every card and pattern; a colleague reads only what is about them and marked for them; HR
without leadership reads nothing; retired rows never show; evidence keys resolve to this database's chats and clients;
the tables are closed to the API. Every name, group and number here is synthetic."""

import json

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world


def test_insight_cards_patterns_read_rules_and_facts(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    load(owner, w, b["batchId"], [msg(1, "Synthetic: the creatives are ready for approval"), msg(2, "Synthetic: approved, go live", sender="s-client1")])
    with owner.transaction():
        set_tenant(owner, w.org)
        group_key = owner.execute("select source_key from pulse_priv.wa_chat where id = %s", (b["chatId"],)).fetchone()["source_key"]
        lead_aud, mine = json.dumps({"rule": "leadership"}), json.dumps({"rule": "person", "person_id": str(w.editor)})
        rows = [("p-company", "confirmed", "Synthetic: calls in week one go live sooner", lead_aud, "{}", json.dumps({"group_ids": [group_key], "client_ids": [str(w.client)]})),
                ("p-mine", "candidate", "Synthetic: you answer fastest before noon", mine, json.dumps({"person_id": str(w.editor)}), "{}"),
                ("p-other", "candidate", "Synthetic: someone else answers slower at night", json.dumps({"rule": "person", "person_id": str(w.lead)}), json.dumps({"person_id": str(w.lead)}), "{}"),
                ("p-retired", "retired", "Synthetic: an old pattern", lead_aud, "{}", "{}")]
        for pid, status, st, aud, scope, ev in rows:
            owner.execute("""insert into pulse_priv.insight_pattern (org_id, id, status, family, area, statement, effect, ci_low, ci_high, support, q_value, value_inr, rank, audience, scope, evidence)
                             values (pulse.current_org(), %s, %s, 'contrast', 'onboarding', %s, -6.1, -8.4, -3.9, 18, 0.004, 240000, 1, %s, %s, %s)""", (pid, status, st, aud, scope, ev))
        owner.execute("""insert into pulse_priv.insight_card (org_id, id, area, tab, title, chart, data, audience, scope, retired_at) values
            (pulse.current_org(), 'c-tab', 'who_waits', 'waiting', 'Synthetic card', '{"kind": "bars"}', '[{"label": "a", "value": 1}]', '{"rule": "leadership"}', '{}', null),
            (pulse.current_org(), 'c-mine', 'team', null, 'Synthetic own card', '{"kind": "kpis"}', '[]', %s, %s, null),
            (pulse.current_org(), 'c-old', 'who_waits', null, 'Synthetic retired card', '{"kind": "bars"}', '[]', '{"rule": "leadership"}', '{}', now())""",
                      (mine, json.dumps({"person_id": str(w.editor)})))
        owner.execute("""insert into pulse_priv.insight_run (org_id, id, round, counts, saturation) values
            (pulse.current_org(), 'r1', 1, '{"confirmed": 1}', '[]'), (pulse.current_org(), 'r2', 2, '{"confirmed": 1}', '[{"round": 1, "cum_confirmed_novel": 1}, {"round": 2, "cum_confirmed_novel": 1}]')""")

    with api.transaction():                                  # a leader: everything, evidence resolved
        set_tenant(api, w.org, w.lead)
        lib = api.execute("select pulse.insight_patterns('{}') r").fetchone()["r"]
        assert lib["all"] == 3 and {i["id"] for i in lib["items"]} == {"p-company", "p-mine", "p-other"}
        assert lib["facets"]["status"] == {"confirmed": 1, "candidate": 2}
        assert [i["id"] for i in api.execute("""select pulse.insight_patterns('{"q": "week", "status": "confirmed"}') r""").fetchone()["r"]["items"]] == ["p-company"]
        one = api.execute("select pulse.insight_pattern('p-company') r").fetchone()["r"]
        assert [c["id"] for c in one["evidence"]["chats"]] == [str(b["chatId"])] and one["evidence"]["clients"][0]["name"] == "Synthetic Developers"
        assert api.execute("select pulse.insight_pattern('p-retired') r").fetchone()["r"] is None
        assert [c["id"] for c in api.execute("""select pulse.insight_cards('{"areas": ["waiting", "who_waits"]}') r""").fetchone()["r"]] == ["c-tab"]
        assert [c["id"] for c in api.execute("select pulse.insight_cards(%s) r", (json.dumps({"scope": {"person_id": str(w.editor)}}),)).fetchone()["r"]] == ["c-mine"]
        runs = api.execute("select pulse.insight_runs() r").fetchone()["r"]
        assert [r["id"] for r in runs["runs"]] == ["r1", "r2"] and len(runs["saturation"]) == 2 and runs["patterns"]["confirmed"] == 1
        ops = api.execute("select pulse.insight_ops('{}') r").fetchone()["r"]
        assert (ops["groups"], ops["messages"]) == (1, 2), {k: ops[k] for k in ("groups", "messages", "facets")}
        assert ops["groups"] == 1 and ops["messages"] == 2 and set(ops["waits"]) >= {"sides", "hist", "heat", "people", "pods"}
        assert api.execute("""select pulse.insight_ops('{"client": "00000000-0000-0000-0000-000000000000"}') r""").fetchone()["r"]["groups"] == 0

        mine = api.execute("select pulse.insight_person(%s) r", (str(w.editor),)).fetchone()["r"]     # 1086: a leader reads anyone's
        assert mine["messages"] == 1 and mine["groups"] == 1 and len(mine["hist"]) == 9

    with api.transaction():                                  # a colleague: only what is about them and marked for them
        set_tenant(api, w.org, w.editor)
        assert api.execute("select pulse.insight_person(%s) r", (str(w.editor),)).fetchone()["r"]["messages"] == 1
        lib = api.execute("select pulse.insight_patterns('{}') r").fetchone()["r"]
        assert [i["id"] for i in lib["items"]] == ["p-mine"] and lib["all"] == 1
        assert api.execute("select pulse.insight_pattern('p-company') r").fetchone()["r"] is None
        assert api.execute("select pulse.insight_pattern('p-other') r").fetchone()["r"] is None
        assert api.execute("select pulse.insight_cards('{}') r").fetchone()["r"] == []
        assert [c["id"] for c in api.execute("select pulse.insight_cards(%s) r", (json.dumps({"scope": {"person_id": str(w.editor)}}),)).fetchone()["r"]] == ["c-mine"]
        assert api.execute("select pulse.insight_runs() r").fetchone()["r"] is None
        assert api.execute("select pulse.insight_ops('{}') r").fetchone()["r"] is None

    with api.transaction():                                  # HR without leadership: nothing
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select pulse.insight_patterns('{}') r").fetchone()["r"]["all"] == 0
        assert api.execute("select pulse.insight_cards('{}') r").fetchone()["r"] == []
        assert api.execute("select pulse.insight_person(%s) r", (str(w.editor),)).fetchone()["r"] is None

    for table in ("insight_card", "insight_pattern", "insight_run", "insight_ops_cache"):   # closed to the API role
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, w.org, w.lead)
                api.execute(f"select count(*) from pulse_priv.{table}")
