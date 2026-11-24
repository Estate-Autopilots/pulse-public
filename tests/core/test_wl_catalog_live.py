"""WL-CATALOG-2 live walk (19 Nov 2026, owner order "burst the work of Willow Lane"): can bhrātā quote NEW catalogue items
right after a price list import? On a synthetic copy of Willow Lane with Billing set as production's (no approval step;
an AI employee's quotation at catalogue prices approved by the rule up to ₹10 lakh), the owner imports 5 new items with
Billing → Catalogue → Import a price list (preview, then import; a salesperson's seat may not), a salesperson asks bhrātā
for a quotation with them in plain words and says yes, then the import is undone (services/api/test/wl-catalog-live.mjs).
bhrātā is set up exactly as in test_wl_agent_live (Claude Opus, effort high, thinking lane, its instructions and rules).
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
from test_wl_agent_live import RULES, instructions
from test_wl_quote_live_suite import salespeople

TOOLS = ["billing", "board", "chats", "drive", "mcp", "memory", "projects", "server", "tasks", "web"]


@pytest.mark.skipif(os.environ.get("PULSE_WLA_LIVE") != "1", reason="spends real model tokens: run with PULSE_WLA_LIVE=1")
def test_bhrata_quotes_five_items_right_after_a_price_list_import(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    lead(worker, w, w.manager)
    with worker.transaction():
        set_tenant(worker, w.org)
        if not worker.execute("select 1 from pulse.role_assignment where person_id=%s and role_key='admin'", (w.manager,)).fetchone():
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'admin','2026-01-01')", (w.org, w.manager))
    owner_sql(owner, w, "update pulse.person set display_name='TEST Owner WL' where id=%s", (w.manager,))
    agent, key = make_agent(api, w, "bhrata-live")
    owner_sql(owner, w, """update pulse.agent_member set tools=%s, access='operations', daily_token_budget=2000000, instructions=%s, title=%s, provider=%s, runtime=%s, effort='high',
              lane='thinking', approver_person_id=%s, owner_person_id=%s, final_approvers=%s::jsonb where org_id=%s and person_id=%s""",
              (TOOLS, instructions(False), "The owner's assistant: quotations, tasks, documents", os.environ.get("PULSE_WLA_PROVIDER", "claude"),
               os.environ.get("PULSE_WLA_MODEL", "claude-opus-5-5"), w.manager, w.manager, json.dumps({k: str(w.manager) for k in ("message", "task", "quotation", "budget")}), w.org, agent))
    owner_sql(owner, w, "update pulse.person set display_name='bhrata' where id=%s", (agent,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for r in RULES:
            api.execute("select pulse.agent_rule_save(%s,%s)", (agent, json.dumps({"body": r})))
    keyfile = tmp_path / "bhrata-live.key"
    keyfile.write_text(key)
    keyfile.chmod(0o600)
    agents = [{"id": str(agent), "username": "bhrata-live", "keyFile": str(keyfile), "finance": False}]
    sales = salespeople(worker, w, 1)
    was = install_org(owner, w.org)
    url = lambda role: role_url("migrate") if role == "owner" and MODE["value"] == "superuser" else dsn(role)
    conf = lambda role: {**(d := conninfo_to_dict(url(role))), "database": d.pop("dbname")}
    out = Path(os.environ.get("PULSE_WLA_OUT", tmp_path))
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(conf("api")), "TEST_OWNER_CONFIG": json.dumps(conf("owner")),
           "TEST_ORG": str(w.org), "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager), "TEST_SALES": json.dumps(sales), "TEST_AGENTS": json.dumps(agents), "PULSE_WLA_OUT": str(out)}
    try:
        p = subprocess.run(["node", "test/wl-catalog-live.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                           capture_output=True, text=True, timeout=int(os.environ.get("PULSE_WLA_TIMEOUT", "1800")), check=False)
    finally:
        if was:
            install_org(owner, was)
    (out / "walk-runner.log").write_text(p.stdout[-60000:] + "\n---\n" + p.stderr[-20000:])
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    walk = json.loads((out / "walk.json").read_text())
    c = walk["checks"]
    assert c["sellerCannotImport"] and c["previewFiveNew"] and c["fiveImportedActive"], c
    assert c["drafted"] and c["allFiveOnTheQuote"] and c["newLinesAtCataloguePrice"] and c["noPriceInvented"], (c, walk["quotation"])
    assert c["issuedByRule"] and c["undoArchivesFive"] and c["quoteKeepsLinesAfterUndo"], (c, walk["quotation"])
