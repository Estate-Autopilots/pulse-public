"""WL-BHARATA-E2E (migration 1605): an admin ticks Billing for an AI employee and its billing area opens (erp_can);
without it the AI employee is refused billing, and a tool that does not exist is still refused. Approving a quotation
finishes the approval task submit_quotation made. Synthetic tenants, people and figures only."""
import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import SELLER, _seed_erp_world, as_, erp, one  # noqa: F401  (fixture)

from test_runners import _people
from test_runner_access import _agent, _as_agent


def test_admin_gives_an_ai_employee_billing(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    aid = _agent(owner, w, p["admin"])
    with api.transaction():
        _as_agent(api, w, aid)
        assert api.execute("select pulse.erp_can(true) v").fetchone()["v"] is False, "no Billing tool: no billing"
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.agent_settings_save(%s,'{\"tools\":[\"chats\",\"tasks\",\"billing\"]}'::jsonb)", (aid,))
        assert api.execute("select tools from pulse.agent_member where person_id=%s", (aid,)).fetchone()["tools"] == ["billing", "chats", "tasks"]
        with pytest.raises(psycopg.errors.InvalidParameterValue, match="Unknown tool"), api.transaction():
            api.execute("select pulse.agent_settings_save(%s,'{\"tools\":[\"payroll\"]}'::jsonb)", (aid,))
    with api.transaction():
        _as_agent(api, w, aid)
        assert api.execute("select pulse.erp_can(true) v").fetchone()["v"] is True, "Billing ticked: it drafts and submits"
    with api.transaction():     # a person without a billing role is still refused; the tool is the AI employee's only
        set_tenant(api, w.org, p["person"])
        assert api.execute("select pulse.erp_can(true) v").fetchone()["v"] is False


def test_approving_the_quotation_finishes_the_approval_task(api, worker, owner, erp):  # noqa: F811
    """submit_quotation links a task "Approve quotation …" to the draft; the approver's Approve numbers it and the task is
    done (it stayed open). A task linked without the approval mark is left alone."""
    w = erp
    _seed_erp_world(worker, w)

    def draft(name):
        with api.transaction():
            set_tenant(api, w.org, w.finance)
            did = api.execute("""insert into pulse.erp_document(org_id,doc_type,issue_date,seller,buyer,place_of_supply,tax_mode,taxable,cgst,sgst,igst,total,created_by)
                values(%s,'quotation',(now() at time zone 'Asia/Kolkata')::date,%s,%s,'27','intra',10000000,900000,900000,0,11800000,%s) returning id""",
                              (w.org, Jsonb(SELLER), Jsonb({"name": name, "stateCode": "27"}), w.finance)).fetchone()["id"]
            api.execute("""insert into pulse.erp_line(org_id,document_id,position,description,qty,rate,gst_rate,taxable,cgst,sgst,igst,total)
                values(%s,%s,0,'Synthetic power conditioner',1,10000000,18,10000000,900000,900000,0,11800000)""", (w.org, did))
        task = one(api, w, w.founder, "select pulse.task_save(null,%s) v", (Jsonb({"title": f"Approve quotation for {name}", "assigneeId": str(w.founder)}),))["v"]
        return did, task

    asked, task = draft("Synthetic Approval Client")
    one(api, w, w.finance, "select pulse.erp_approval_ask(%s,%s,null)", (asked, w.founder))
    as_(api, w, w.finance, "update pulse.erp_document set task_id=%s where id=%s", (task, asked))
    one(api, w, w.finance, "select pulse.erp_log('document',%s,'task',%s)", (asked, Jsonb({"taskId": str(task), "approval": True, "assignee": str(w.founder)})))
    plain, other = draft("Synthetic Plain Client")
    as_(api, w, w.finance, "update pulse.erp_document set task_id=%s where id=%s", (other, plain))
    one(api, w, w.founder, "select pulse.erp_document_issue(%s)", (asked,))
    one(api, w, w.founder, "select pulse.erp_document_issue(%s)", (plain,))
    with owner.transaction():
        set_tenant(owner, w.org)
        status = {r["id"]: r["status"] for r in owner.execute("select id,status from pulse.task where id = any(%s)", ([task, other],)).fetchall()}
    assert status[task] in ("done", "in_review", "accepted"), "approved: its approval task is finished"
    assert status[other] == "open", "a task linked without the approval mark is left alone"
