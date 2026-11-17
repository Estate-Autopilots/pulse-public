"""UX-GAMIFY (owner, 9 Nov 2026): screens redone on the game-feel kit, in a real browser (PULSE_AUTH_BROWSER=1):
services/api/test/ux-gamify-browser-runner.mjs on disposable synthetic companies, as an admin, at 1440 and 363 px,
light and dark: the expected words show, nothing scrolls sideways, no page errors. Screenshots with
PULSE_UXG_SCREENSHOTS=<dir>. Every name and number is fake.

Agreements: our company sends a draft, one out to sign and one signed by both sides (one-off ₹ amounts), so the
tiles (Waiting to sign, Signed this month, Money in signed deals) and the tabs with counts have something to show."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from helpers import build_world
from psycopg.types.json import Jsonb
from test_contracts import admin, copy_of, one, save
from test_erp_invoice import draft, erp, issue  # noqa: F401  (erp is a fixture)
from test_kazuk_gaps import backdate_issued, owner_sql, world  # noqa: F401  (world is a fixture)
from test_tasks_rt1 import new_task, team  # noqa: F401  (team is a fixture)
from test_agent_coworkers import agent_one, ask, make_agent, owner_sql as owner_rows
from test_agent_memory import open_ai, run_for

API = Path(__file__).resolve().parents[2] / "services" / "api"


def sign_in(worker, w, person, handle):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, handle, person))


def agreement(api, us, them, title, rupees):
    return save(api, us, us.manager, None, {"kind": "services", "title": title, "scope": "Synthetic scope of work",
        "rates": [{"label": title, "amountMinor": rupees * 100, "unit": "one_off"}], "startsOn": "2026-12-01",
        "parties": [{"kind": "company", "role": "provider", "orgId": str(us.org)}, {"kind": "company", "role": "client", "orgId": str(them.org)}]})


def run_browser(us, pages, emails=None):
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_EMAILS": json.dumps(emails or {"admin": f"boss@{us.domain}"}),
           "TEST_PAGES": json.dumps(pages)}
    p = subprocess.run(["node", "test/ux-gamify-browser-runner.mjs"], cwd=API, env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_agreements_feel_like_progress_in_the_browser(worker, owner, api):
    us, them = build_world(worker, owner, api), build_world(worker, owner, api)
    admin(worker, us, us.manager)
    admin(worker, them, them.manager)
    sign_in(worker, us, us.manager, f"boss@{us.domain}")
    agreement(api, us, them, "Synthetic design fee", 420000)
    out = agreement(api, us, them, "Synthetic fit-out", 1800000)
    assert one(api, us, us.manager, "select pulse.contract_send(%s) s", (out,))["s"] == "proposed"
    done = agreement(api, us, them, "Synthetic site visit pack", 86000)
    one(api, us, us.manager, "select pulse.contract_send(%s) s", (done,))
    key = one(api, us, us.manager, "select contract_key k from pulse.contract where id=%s", (done,))["k"]
    one(api, them, them.manager, "select pulse.contract_accept(%s,null,null) s", (copy_of(api, them, them.manager, key)["id"],))
    assert one(api, us, us.manager, "select pulse.contract_accept(%s,null,null) s", (done,))["s"] == "active"
    run_browser(us, [{"name": "agreements", "path": "/contracts", "see": ["Agreements", "Waiting to sign", "Money in signed deals", "Synthetic fit-out"]}])


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_the_ceo_screen_leads_with_money_at_risk_and_todays_issues_in_the_browser(api, worker, owner, world):
    """Work -> Projects for the founder (every team): the money at risk as the first tile, and today's issues (an overdue
    invoice, a quotation with no answer, an accepted one not billed, a client issue raised today) as one list."""
    w = world
    sign_in(worker, w, w.founder, f"founder@{w.domain}")
    inv = draft(api, w, w.finance, taxable=10000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set due_date=(now() at time zone 'Asia/Kolkata')::date-10 where id=%s", (inv,))
    issue(api, w, w.finance, inv)
    big = draft(api, w, w.finance, "quotation", taxable=5000000, client=w.client)
    issue(api, w, w.finance, big)
    backdate_issued(owner, w, "update pulse.erp_document set issued_at=now()-interval '12 days',updated_at=now()-interval '12 days' where id=%s", (big,))
    acc = draft(api, w, w.finance, "quotation", taxable=3000000, client=w.client)
    issue(api, w, w.finance, acc)
    backdate_issued(owner, w, "update pulse.erp_document set status='accepted' where id=%s", (acc,))
    owner_sql(owner, w, "update pulse.project set client_id=%s,title='Synthetic Riverside launch',status='active' where id=%s", (w.client, w.project))
    t = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic inputs missing from the client", "projectId": str(w.project)}),))["id"]
    owner_sql(owner, w, "insert into pulse.blocker(org_id,task_id,project_id,blocker_key,opened_at,owner_side,source) values(%s,%s,%s,'client_inputs',now(),'client','declared')", (w.org, t, w.project))
    run_browser(w, [{"name": "ceo", "path": "/tasks?view=projects&scope=all", "role": "founder", "see": ["Today's issues", "Money at risk", "Overdue invoice", "Synthetic Riverside launch"]}],
                emails={"founder": f"founder@{w.domain}"})


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_a_salespersons_pipeline_reads_as_stages_tiles_and_follow_ups_in_the_browser(api, worker, owner, world):
    """My sales for a salesperson: a quotation waiting for an answer, one won, and a follow-up call due today."""
    # LAND-CAPTAIN-10: /sales is KAZUK-V2's one salesperson home (its own pipeline: "Pipeline value"); the kit's board
    # (pipeline-board.tsx) is on the sales Home (dashboard/sales-home.tsx), where its note is the "My sales" link.
    w = world
    sign_in(worker, w, w.sales, f"sales@{w.domain}")
    big = draft(api, w, w.finance, "quotation", taxable=5000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, big))
    issue(api, w, w.finance, big)
    backdate_issued(owner, w, "update pulse.erp_document set issued_at=now()-interval '12 days',updated_at=now()-interval '12 days' where id=%s", (big,))
    acc = draft(api, w, w.finance, "quotation", taxable=3000000, client=w.client)
    owner_sql(owner, w, "update pulse.erp_document set salesperson_id=%s where id=%s", (w.sales, acc))
    issue(api, w, w.finance, acc)
    backdate_issued(owner, w, "update pulse.erp_document set status='accepted' where id=%s", (acc,))
    f = one(api, w, w.founder, "select pulse.task_save(null,%s) id", (Jsonb({"title": "Synthetic call about the quotation", "assigneeId": str(w.sales)}),))["id"]
    owner_sql(owner, w, "update pulse.task set source='quote_followup',assignee_person_id=%s,due_at=now(),work_on=null where id=%s", (w.sales, f))
    run_browser(w, [{"name": "pipeline", "path": "/sales", "role": "sales", "see": ["My pipeline", "Pipeline value", "Synthetic call about the quotation"]}],
                emails={"sales": f"sales@{w.domain}"})


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_tidy_up_shows_what_there_is_to_merge_in_the_browser(api, worker, team):  # noqa: F811
    """Work -> Tidy up for an editor: tiles for what there is to tidy, a pair that is the same work and a group that could be
    one brief."""
    w = team
    x = new_task(api, w, w.editor2, title="Synthetic post for Demo Heights", assigneeId=str(w.editor))
    y = new_task(api, w, w.editor2, title="Synthetic post for Demo Heights again", assigneeId=str(w.editor))
    z = new_task(api, w, w.editor2, title="Synthetic story for Demo Heights", assigneeId=str(w.editor))
    rows = Jsonb([{"kind": "duplicate", "taskIds": [str(x), str(y)], "score": 0.91, "method": "words", "title": "Synthetic post for Demo Heights", "reason": "Same words"},
                  {"kind": "cluster", "taskIds": [str(x), str(y), str(z)], "score": 0.7, "method": "words", "title": "Synthetic Demo Heights brief", "shape": "brief"}])
    one(api, w, w.editor, "select pulse.merge_suggestion_save(%s,%s) n", (w.editor, rows))
    run_browser(w, [{"name": "tidy-up", "path": "/tasks/merge", "role": "editor", "see": ["Tidy up", "The same work", "Could be one brief", "Synthetic Demo Heights brief"]}],
                emails={"editor": w.editor_handle})


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_the_dependency_map_shows_tiles_and_what_waits_in_the_browser(api, worker, team):  # noqa: F811
    """Work -> Dependency map for an editor: one task waits on another, so the tiles read 1 blocked and 1 ready to start."""
    w = team
    first = new_task(api, w, w.editor, title="Synthetic shoot plan", assigneeId=str(w.editor))
    then = new_task(api, w, w.editor, title="Synthetic edit after the shoot", assigneeId=str(w.editor))
    one(api, w, w.editor, "select pulse.work_dependency_add('task',%s,'task',%s) id", (then, first))
    run_browser(w, [{"name": "dependency-map", "path": "/tasks/map", "role": "editor", "see": ["Dependency map", "Ready to start", "Synthetic shoot plan"]}],
                emails={"editor": w.editor_handle})


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_an_ai_employees_budget_reads_as_fuel_in_the_browser(api, worker, owner, team):  # noqa: F811
    """People -> an AI employee -> AI, for its owner: 8,500 of a 10,000-token month used, so the gauge shows 15% left in amber,
    with its rules, notes and who approves what."""
    w = team
    sign_in(worker, w, w.manager, f"boss@{w.domain}")
    agent, _ = make_agent(api, w, "synthetic-helper")
    open_ai(owner, w, agent)
    # A hired AI employee has a profile row like everyone (pulse.agent_create alone does not make one; the profile page needs it).
    owner_rows(owner, w, "insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'AI helper','test',98,'synthetic-helper') on conflict do nothing", (w.org, agent))
    owner_rows(owner, w, "insert into pulse_priv.ai_employee_cap(org_id,person_id,monthly_tokens,set_by) values(%s,%s,10000,%s)", (w.org, agent, w.manager))
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    ask(api, w, w.manager, dm, "Draft the weekly note (synthetic)")
    run, _ = run_for(api, w, agent)
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',8500,3,null)", (run,))
    run_browser(w, [{"name": "ai-employee", "path": f"/people/{agent}?tab=ai", "role": "admin", "click": ["Model & limits"], "see": ["Used so far", "% left"]}],
                emails={"admin": f"boss@{w.domain}"})


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_my_day_has_a_ring_streaks_and_the_week_in_the_browser(api, worker, owner, team):  # noqa: F811
    """My day for an editor who checked in on the last two days and finished two tasks today: the day's ring, the two
    streaks and "Your week"."""
    w = team
    a = new_task(api, w, w.editor, title="Synthetic caption pass", assigneeId=str(w.editor))
    b = new_task(api, w, w.editor, title="Synthetic thumbnail set", assigneeId=str(w.editor))
    new_task(api, w, w.editor, title="Synthetic reel for tomorrow", assigneeId=str(w.editor))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set status='done',done_at=now() where id = any(%s)", ([a, b],))
        for back in (1, 2):
            owner.execute("""insert into pulse.attendance_entry(org_id,person_id,checked_in_at,checked_out_at,work_date)
                values(%s,%s,now()-make_interval(days=>%s),now()-make_interval(days=>%s)+interval '8 hours',(now() at time zone 'Asia/Kolkata')::date-%s)""",
                          (w.org, w.editor, back, back, back))
    run_browser(w, [{"name": "my-day", "path": "/my-day", "role": "editor", "see": ["finishing work", "Your week", "Tasks done each day"]}],
                emails={"editor": w.editor_handle})
