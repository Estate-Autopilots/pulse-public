"""FIX-AI-EMPLOYEES (owner walkthrough, 10 Nov 2026): Autopilots, the AI employees as cards with what each did today,
what it waits on and what it cost (2011 agent_costs, added to GET /api/v0/agents/workload), and Connect your AI with the
real Claude, ChatGPT and Gemini logos. The API end to end and, with PULSE_AUTH_BROWSER=1, a Playwright walk at 363, 390,
1440 and 1920 px in light and dark (services/api/test/autopilots-runner.mjs). Synthetic company, people, runs and price;
nothing is sent anywhere."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import make_agent, owner_sql
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def runs(owner, w, agent, n, tokens, ago="2 hours", kind="chat.message", state="done", engine="server:claude/sonnet"):
    """n finished runs of the AI employee, each with its event, `ago` before now."""
    for i in range(n):
        ev = owner_sql(owner, w, """insert into pulse.agent_event(org_id,agent_id,event_type,subject_type,subject_id,event_key,invoked_by,state,created_at)
            values(%s,%s,%s,'message',%s,%s,%s,'done',now()-%s::interval) returning id""",
                       (w.org, agent, kind, uuid.uuid4(), f"autopilots-test:{uuid.uuid4()}", w.manager, ago))[0]["id"]
        owner_sql(owner, w, """insert into pulse.agent_run(org_id,agent_id,event_id,state,lane,model,reserved,tokens,tokens_in,tokens_out,engine,seconds,started_at,deadline,finished_at)
            values(%s,%s,%s,%s,'quick','sonnet',%s,%s,%s,%s,%s,12,now()-%s::interval-make_interval(mins=>%s),now(),now()-%s::interval)""",
                   (w.org, agent, ev, state, tokens, tokens, tokens * 4 // 5, tokens // 5, engine, ago, i, ago))


def test_autopilots_api_and_browser(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    accounts, _ = make_agent(api, w, "accounts-helper-test", title="Quotes and invoices (AI)")
    care, _ = make_agent(api, w, "client-care-test", title="Client Care Test")
    ideas, _ = make_agent(api, w, "creative-helper-test", title="Scripts and hooks (AI)")
    posts, _ = make_agent(api, w, "posts-updates-test", title="Posts updates (AI)")
    paused, _ = make_agent(api, w, "old-helper-test", title="Old helper (AI)")
    owner_sql(owner, w, "update pulse.agent_member set tools=array['billing','chats','tasks'], daily_token_budget=120000 where person_id=%s", (accounts,))
    owner_sql(owner, w, "update pulse.agent_member set tools=array['chats','memory'], daily_token_budget=60000 where person_id=%s", (care,))
    owner_sql(owner, w, "update pulse.agent_member set runtime_state='out_of_quota' where person_id=%s", (posts,))
    owner_sql(owner, w, "update pulse.agent_member set paused_reason='Paused for the test' where person_id=%s", (paused,))
    runs(owner, w, accounts, 3, 12000)
    runs(owner, w, care, 2, 9000, ago="40 minutes")
    runs(owner, w, ideas, 1, 4000, ago="3 days")
    # Work queued for the accounts helper now, and a reply card waiting on the admin.
    owner_sql(owner, w, """insert into pulse.agent_event(org_id,agent_id,event_type,subject_type,subject_id,event_key,invoked_by,state)
        values(%s,%s,'chat.message','message',%s,%s,%s,'queued')""", (w.org, accounts, uuid.uuid4(), f"autopilots-test:{uuid.uuid4()}", w.manager))
    group = owner_sql(owner, w, """insert into pulse.chat_channel(org_id,key,name,kind,description) values(%s,%s,'Harbor Crest client room (test)','group','A synthetic room')
        returning id""", (w.org, f"autopilots-test:{uuid.uuid4()}"))[0]["id"]
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (accounts, w.manager))[0]["id"]
    msg = owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'The card (test)',%s) returning id", (w.org, dm, accounts, uuid.uuid4()))[0]["id"]
    for body in ("Here is the quotation for 3 reels (test).", "The invoice for October is attached (test)."):
        owner_sql(owner, w, """insert into pulse.agent_proposal(org_id,agent_id,channel_id,approver_id,dm_channel_id,dm_message_id,kind,body,why,created_at)
            values(%s,%s,%s,%s,%s,%s,'reply',%s,'They asked.',now()-interval '2 hours')""", (w.org, accounts, group, w.manager, dm, msg, body))
    # A synthetic platform price, so the cards read in rupees (production has none yet: they then read in tokens).
    owner_sql(owner, w, "insert into pulse_priv.platform_ai_price(engine,inr_per_m_in,inr_per_m_out,note) values('*',250,1250,'synthetic test price') on conflict (engine) do nothing")

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "autopilots.json"
    shots = os.environ.get("AUTOPILOTS_SHOTS") or str(tmp_path / "shots")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_OWNER_CONFIG": config(owner.info.dsn),
           "TEST_WORKER_CONFIG": config(dsn("worker")), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle, "TEST_ADMIN_EMAIL": ADMIN,
           "TEST_AGENTS": json.dumps({"accounts": str(accounts), "care": str(care), "ideas": str(ideas), "posts": str(posts), "paused": str(paused)}),
           "AUTOPILOTS_REPORT": str(report), "AUTOPILOTS_SHOTS": shots}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(["node", "test/autopilots-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=1800)
    owner_sql(owner, w, "delete from pulse_priv.platform_ai_price where note='synthetic test price'")
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 8
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 20
