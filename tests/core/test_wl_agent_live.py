"""WL-DOCS live walk (18 Nov 2026): a salesperson and the owner work with two AI employees set up as Willow Lane's are
after their upgrade (Claude Opus, effort high, thinking lane, instructions, standing rules, the owner as approver; the
finance one with the Finance role), on a synthetic copy of Willow Lane with the real runtime
(services/api/test/wl-agent-live.mjs): hello → a quotation for 5 kW → the client's name → yes, submit → the owner
approves → "give me the final quote" → a document written and shared in the chat → a task for a colleague (not a
quotation) → the finance AI lists quotations and drafts the invoice. Every turn is timed.
Only with PULSE_WLA_LIVE=1: it spends real model tokens. Results in PULSE_WLA_OUT. Every person, client, product and
price is invented; nothing is sent to anyone."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import MODE, dsn, role_url
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import lead, make_agent, owner_sql
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)
from test_wl_quote_live_suite import salespeople

SUITE = json.loads((Path(__file__).parent / "wl_quote_live_scenarios.json").read_text())
COMPANY = "Willow Lane (synthetic), an Indian company in Pune, Maharashtra (GST state 27). It sells PuREPower energy systems with their accessories, extended warranties and services."
HOW = """How you work:
- Use your Pulse tools; never say you have no access when a tool covers it. If Pulse refuses a step, fix what it names and try again once; if it still refuses, say in one plain line what Pulse said and who can change it. Never say something was done before the tool confirmed it.
- "Assign <name> a task", "<name> ko task do", "remind <name>" is a TASK (create_task: the colleague as assignee, the due date worked out from today in IST, the asker as reviewer), never a quotation.
- Documents: write real documents with create_doc (notes, letters, SOPs, lists, summaries, proposals). A doc you write while answering in a chat is shared with that chat's people; give its address, and open it beside the chat when they ask to see it (screen_open_side_panel with /docs/<id>).
- People write and speak in Hindi, Marathi, English or Hinglish, often as voice notes. Answer in the language and script they used, short and concrete, in simple words.
- Indian formats: ₹, lakh and crore, DD Mon YYYY, IST. Never invent a number, price, rate, GSTIN, phone or date: if it is not in Pulse or in what you were given, say what is missing and ask once."""
QUOTES = """Quotations: use draft_quotation, once, with the client's name exactly as written or heard, and the lines. A request with a size and a client is enough: draft it at catalogue price and give the link. No client named: ask "Which client is this for?" and never offer a colleague or a TEST record as a choice. When they say yes / submit / "bhej do", submit it for approval. TEST Owner WL approves. After it is approved and issued, give the number and its link, and the PDF in the chat when Pulse provides it. You never approve your own quotation."""
PEOPLE = "People of the company (colleagues, NEVER clients): TEST Owner WL (Director; approves quotations and anything about money) and the sales team (TEST Sales 1 WL, TEST Sales 2 WL)."
RULES = ["Ask TEST Owner WL first before sending anything outside the company on your own, promising or recording money, deleting or cancelling anything, or changing tax or company settings.",
         "Never invent a number, price, rate, GSTIN, phone or date: use what is in Pulse or what you were given, and say plainly what is missing.",
         "A colleague is never a client: \"assign <name> a task\" is a task, not a quotation. Never say a step is done before Pulse confirmed it. A doc you make in a chat is shared there; open it beside the chat when asked."]


def instructions(finance):
    job = ("You are the Quotation & Finance agent, the Finance AI employee of " if finance else "You are bhrata, the AI assistant of ") + COMPANY
    work = ("Your job: quotations, tax invoices drafted from approved quotations, what is due, GST worked out per line, reports and documents. Payments: Pulse lets only a person record a payment; prepare it and ask."
            if finance else "Your job: quotations for the salespeople and leaders, tasks, documents and lookups (staff, clients, quotations).")
    return "\n\n".join([job, "You report to TEST Owner WL (Director).", work, PEOPLE, SUITE["instructions"], QUOTES, HOW])


@pytest.mark.skipif(os.environ.get("PULSE_WLA_LIVE") != "1", reason="spends real model tokens: run with PULSE_WLA_LIVE=1")
def test_a_salesperson_and_the_owner_work_with_the_upgraded_ai_employees(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team  # the team fixture already signs the admin (ADMIN) in as w.manager
    lead(worker, w, w.manager)
    with worker.transaction():
        set_tenant(worker, w.org)
        if not worker.execute("select 1 from pulse.role_assignment where person_id=%s and role_key='admin'", (w.manager,)).fetchone():
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'admin','2026-01-01')", (w.org, w.manager))
    owner_sql(owner, w, "update pulse.person set display_name='TEST Owner WL' where id=%s", (w.manager,))
    agents = []
    for username, name, finance, tools in (("bhrata-live", "bhrata", False, ["billing", "board", "chats", "drive", "mcp", "memory", "projects", "server", "tasks", "web"]),
                                           ("finance-live", "Quotation & Finance agent", True, ["billing", "chats", "drive", "memory", "projects", "tasks"])):
        agent, key = make_agent(api, w, username)
        # Exactly the upgraded settings (wl-agent.mjs): Claude Opus, high, thinking; operations access; the owner approves.
        owner_sql(owner, w, """update pulse.agent_member set tools=%s, access='operations', daily_token_budget=2000000, instructions=%s, title=%s, provider=%s, runtime=%s, effort='high',
                  lane='thinking', approver_person_id=%s, owner_person_id=%s, final_approvers=%s::jsonb where org_id=%s and person_id=%s""",
                  (tools, instructions(finance), "Finance and documents" if finance else "The owner's assistant: quotations, tasks, documents", os.environ.get("PULSE_WLA_PROVIDER", "claude"),
                   os.environ.get("PULSE_WLA_MODEL", "claude-opus-5-5"), w.manager, w.manager, json.dumps({k: str(w.manager) for k in ("message", "task", "quotation", "budget")}), w.org, agent))
        owner_sql(owner, w, "update pulse.person set display_name=%s where id=%s", (name, agent))
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            for r in RULES:
                api.execute("select pulse.agent_rule_save(%s,%s)", (agent, json.dumps({"body": r})))
            if finance:
                api.execute("select pulse.agent_finance_role_set(%s,true,'Synthetic: the finance AI employee')", (agent,))
        keyfile = tmp_path / f"{username}.key"
        keyfile.write_text(key)
        keyfile.chmod(0o600)
        agents.append({"id": str(agent), "username": username, "keyFile": str(keyfile), "finance": finance})
    sales = salespeople(worker, w, 2)
    was = install_org(owner, w.org)
    url = lambda role: role_url("migrate") if role == "owner" and MODE["value"] == "superuser" else dsn(role)  # noqa: E731
    conf = lambda role: {**(d := conninfo_to_dict(url(role))), "database": d.pop("dbname")}  # noqa: E731
    out = Path(os.environ.get("PULSE_WLA_OUT", tmp_path))
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(conf("api")), "TEST_OWNER_CONFIG": json.dumps(conf("owner")),
           "TEST_ORG": str(w.org), "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager), "TEST_SALES": json.dumps(sales), "TEST_AGENTS": json.dumps(agents), "PULSE_WLA_OUT": str(out)}
    try:
        p = subprocess.run(["node", "test/wl-agent-live.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                           capture_output=True, text=True, timeout=int(os.environ.get("PULSE_WLA_TIMEOUT", "3600")), check=False)
    finally:
        if was:
            install_org(owner, was)
    (out / "walk-runner.log").write_text(p.stdout[-60000:] + "\n---\n" + p.stderr[-20000:])
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    walk = json.loads((out / "walk.json").read_text())
    assert walk["checks"]["quotationIssued"] and walk["checks"]["docSharedWithSeller"] and walk["checks"]["taskNotQuotation"], walk["checks"]
