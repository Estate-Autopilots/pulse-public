"""COMP-B (0450_payroll.sql, 0451_people_budget.sql): payroll, payslips, the bank file, the people-cost ledger, the
budget and scenarios, enforced in the database. Synthetic tenants, people and sealed placeholders only: the database
never sees an amount (services/api/test/payroll-runner.mjs covers the real sealing and the maths runs in
services/api/test/payroll-model.test.mjs). Who may see and do what at every step, maker-checker, locking, corrections,
the Accountant's totals, the access log and notices without amounts."""
import re
import uuid
from datetime import timedelta

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_comp import SEALED, as_, denied, logs, notes, one, pay, refused, start_pay, val, worker_rows  # noqa: F401  (pay is a fixture)


def month_of(api, w):
    return val(api, w, w.p["hr"], "select date_trunc('month',pulse.lifecycle_today())::date")


def open_run(api, w, who="hr", month=None, note=None):
    return val(api, w, w.p[who], "select pulse.pay_run_open(%s,%s)", (month or month_of(api, w), note))


def save(api, w, run, people, who="hr", recover=(), settlement=None):
    lines = [{"person": str(p), "payType": "salary", "pod": "Pod 9", "exceptions": ["no_bank"] if i == 0 else [], "sealed": SEALED,
              "recover": p in recover, "settlementId": settlement} for i, p in enumerate(people)]
    return val(api, w, w.p[who], "select pulse.pay_run_save(%s,%s)", (run, Jsonb({"lines": lines, "totals": SEALED, "runExceptions": []})))


def lock_body(people, items=(), claims=(), carries=()):
    return Jsonb({"payslips": [{"person": str(p), "sealed": SEALED, "pdf": SEALED, "sha256": "b" * 64, "pages": 1} for p in people],
                  "payout": {"format": "axis", "rows": len(people), "leftOut": 0, "sealed": SEALED, "sha256": "c" * 64},
                  "ledger": {"entries": [{"id": str(uuid.uuid4()), "account": a, "side": s, "pod": "Pod 9", "people": len(people), "sealed": SEALED} for a, s in [("salaries", "debit"), ("net_payable", "credit")]],
                             "totals": [{"account": a, "side": s, "people": len(people), "sealed": SEALED} for a, s in [("salaries", "debit"), ("net_payable", "credit")]]},
                  "paid": {"items": [str(i) for i in items], "claims": [str(c) for c in claims], "carries": [str(c) for c in carries]}})


def checked_run(api, w, people, who_checks="hr"):
    run = open_run(api, w)
    calc = save(api, w, run, people)
    as_(api, w, w.p[who_checks], "select pulse.pay_run_check(%s,%s,'Looked at every exception')", (run, calc))
    return run


def test_api_role_reads_no_payroll_table(api, pay):
    w = pay
    for table in ["pay_settings", "pay_run", "pay_run_line", "pay_adjustment", "pay_run_event", "pay_payslip", "pay_payout", "pay_ledger_entry", "pay_ledger_total",
                  "pay_budget", "pay_plan_role", "pay_scenario"]:
        denied(api, w, w.p["hr"], f"select * from pulse.{table}")


def test_who_sees_and_starts_payroll(api, worker, pay):
    w = pay
    start_pay(api, w, w.p["person"])
    for who in ["hr", "founder", "lead", "admin_pay"]:
        assert val(api, w, w.p[who], "select pulse.pay_runs()")["can"]["read"], who
    for who in ["admin", "other", "person", "head", "ca"]:
        denied(api, w, w.p[who], "select pulse.pay_runs()")
        denied(api, w, w.p[who], "select pulse.pay_run_open(%s,null)", (month_of(api, w),))
        denied(api, w, w.p[who], "select pulse.pay_settings_read()")
    run = open_run(api, w)
    for who in ["other", "person", "ca", "admin"]:
        denied(api, w, w.p[who], "select pulse.pay_run_get(%s)", (run,))
        denied(api, w, w.p[who], "select * from pulse.pay_run_lines(%s,null)", (run,))
        denied(api, w, w.p[who], "select pulse.pay_run_inputs(%s)", (run,))
    # A month far ahead is refused; a month already open cannot be opened twice.
    refused(api, w, w.p["hr"], "select pulse.pay_run_open(%s,null)", (month_of(api, w) + timedelta(days=95),), match="this month")
    refused(api, w, w.p["hr"], "select pulse.pay_run_open(%s,null)", (month_of(api, w),), match="already open")
    assert any(r["purpose"] == "runs" for r in worker_rows(worker, w, "select purpose from privacy.access_log where org_id=%s and resource='comp.payroll'", (w.org,)))


def test_inputs_scope_attendance_and_logs(api, worker, owner, pay):
    w = pay
    m = month_of(api, w)
    for who in ["person", "other"]:
        start_pay(api, w, w.p[who], on=m - timedelta(days=60))
    bonus = val(api, w, w.p["hr"], "select pulse.comp_item_save(%s)", (Jsonb({"person": str(w.p["person"]), "kind": "bonus", "reason": "Synthetic", "forMonth": str(m), "sealed": SEALED}),))
    as_(api, w, w.p["founder"], "select pulse.comp_item_decide(%s,'approve',null)", (bonus,))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.leave_type(org_id,key,name,paid,annual_days,accrual) values(%s,'lwp_syn','Synthetic unpaid',false,null,'none') on conflict do nothing", (w.org,))
        owner.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days) values(%s,%s,%s,%s,'lwp_syn','approved',5)", (w.org, w.p["person"], m + timedelta(days=1), m + timedelta(days=7)))
        owner.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days) values(%s,%s,%s,%s,'lwp_syn','pending',1)", (w.org, w.p["other"], m + timedelta(days=9), m + timedelta(days=9)))
    run = open_run(api, w)
    inp = val(api, w, w.p["hr"], "select pulse.pay_run_inputs(%s)", (run,))
    people = {p["id"]: p for p in inp["people"]}
    assert set(people) == {str(w.p["person"]), str(w.p["other"])}           # nobody without pay in force
    me = people[str(w.p["person"])]
    assert [i["id"] for i in me["items"]] == [str(bonus)] and me["items"][0]["paid"] is False
    assert me.get("bank") is None or me["bank"]["onFile"] is False
    att = me["attendance"]
    if att["enabled"] and att["workingDays"]:
        assert any(d["why"] == "unpaid_leave" for d in att["lop"])
        assert people[str(w.p["other"])]["attendance"]["pendingLeave"] == 1
    sealed = as_(api, w, w.p["hr"], "select kind,person_id from pulse.pay_run_sealed(%s)", (run,))
    assert {r["kind"] for r in sealed} == {"change", "item"}
    assert ("comp.payroll", "payroll_run") in {(r["resource"], r["purpose"]) for r in logs(worker, w, w.p["person"])}


def test_flow_maker_checker_lock_and_notices(api, worker, pay):
    w = pay
    people = [w.p["person"], w.p["hr2"]]
    for p in people:
        start_pay(api, w, p)
    run = open_run(api, w)
    calc = save(api, w, run, people)
    assert calc == 1
    # HR adjusts others, never their own line; a person not in the run cannot be adjusted.
    as_(api, w, w.p["hr"], "select pulse.pay_adjust(%s,%s)", (run, Jsonb({"person": str(w.p["person"]), "kind": "lop_days", "days": 1.5, "reason": "Synthetic: agreed"})))
    denied(api, w, w.p["hr2"], "select pulse.pay_adjust(%s,%s)", (run, Jsonb({"person": str(w.p["hr2"]), "kind": "hold", "reason": "My own"})))
    refused(api, w, w.p["hr"], "select pulse.pay_adjust(%s,%s)", (run, Jsonb({"person": str(w.p["other"]), "kind": "hold", "reason": "Not in it"})), match="not in this payroll")
    refused(api, w, w.p["hr"], "select pulse.pay_adjust(%s,%s)", (run, Jsonb({"person": str(w.p["person"]), "kind": "amount", "label": "Synthetic", "reason": "No sealed value"})), match="Sealed")
    calc = save(api, w, run, people)
    # A stale calculation cannot be checked; the founder checks the current one and then may not approve it.
    with pytest.raises(psycopg.errors.SerializationFailure):
        as_(api, w, w.p["founder"], "select pulse.pay_run_check(%s,1,null)", (run,))
    as_(api, w, w.p["founder"], "select pulse.pay_run_check(%s,%s,null)", (run, calc))
    assert any(n["event_type"] == "comp.payroll" for n in notes(worker, w, w.p["founder2"]))
    denied(api, w, w.p["founder"], "select pulse.pay_lock_check(%s)", (run,))
    denied(api, w, w.p["hr"], "select pulse.pay_lock_check(%s)", (run,))
    # Recalculating a checked run sends it back to draft; HR checks it again.
    calc = save(api, w, run, people)
    assert val(api, w, w.p["hr"], "select pulse.pay_run_get(%s)", (run,))["status"] == "draft"
    as_(api, w, w.p["hr"], "select pulse.pay_run_check(%s,%s,null)", (run, calc))
    # The lock needs one payslip per person in the checked calculation.
    refused(api, w, w.p["founder2"], "select pulse.pay_run_lock(%s,%s)", (run, lock_body(people[:1])), match="one payslip")
    assert val(api, w, w.p["founder2"], "select pulse.pay_run_lock(%s,%s)", (run, lock_body(people))) == "locked"
    r = val(api, w, w.p["hr"], "select pulse.pay_run_get(%s)", (run,))
    assert r["status"] == "locked" and r["approvedBy"] == "Synthetic Founder2" and r["checkedBy"] == "Synthetic Hr" and r["payout"]["rows"] == 2
    assert [e["kind"] for e in reversed(r["events"])][:3] == ["opened", "computed", "adjusted"] and r["events"][0]["kind"] == "locked"
    # Locked is final: no recalculation, adjustment or withdrawal.
    refused(api, w, w.p["hr"], "select pulse.pay_run_save(%s,%s)", (run, Jsonb({"lines": []})), match="cannot change")
    refused(api, w, w.p["hr"], "select pulse.pay_adjust(%s,%s)", (run, Jsonb({"person": str(w.p["person"]), "kind": "hold", "reason": "Too late"})), match="draft")
    refused(api, w, w.p["hr"], "select pulse.pay_run_withdraw(%s,null)", (run,), match="corrected")
    # Notices name the month, never an amount.
    assert [n["title"] for n in notes(worker, w, w.p["person"], "comp.payslip")] and all("₹" not in n["title"] for n in notes(worker, w, w.p["person"]))
    titles = [x["title"] for x in worker_rows(worker, w, "select title from pulse.notification where event_type in ('comp.payroll','comp.payslip')")]
    assert titles and not any("₹" in t or re.search(r"\d", re.sub(r"\b[A-Z][a-z]+ \d{4}\b", "", t)) for t in titles)


def test_items_claims_and_settlements_are_paid_once(api, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    bonus = val(api, w, w.p["hr"], "select pulse.comp_item_save(%s)", (Jsonb({"person": str(who), "kind": "bonus", "reason": "Synthetic", "sealed": SEALED}),))
    as_(api, w, w.p["founder"], "select pulse.comp_item_decide(%s,'approve',null)", (bonus,))
    run = checked_run(api, w, [who])
    as_(api, w, w.p["founder"], "select pulse.pay_run_lock(%s,%s)", (run, lock_body([who], items=[bonus])))
    item = val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["items"][0]
    assert item["paidAt"] is not None
    # A later run of the next month no longer brings the paid bonus.
    nxt = open_run(api, w, month=(month_of(api, w) + timedelta(days=35)).replace(day=1))
    inp = val(api, w, w.p["hr"], "select pulse.pay_run_inputs(%s)", (nxt,))
    assert all(i["id"] != str(bonus) for p in inp["people"] for i in p["items"])


def test_payslips_bank_file_and_their_logs(api, worker, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    run = checked_run(api, w, [who])
    # The bank details of a checked run: the approver and HR (each person's read logged), nobody else.
    assert as_(api, w, w.p["founder"], "select * from pulse.pay_bank_sealed(%s)", (run,)) == []
    assert ("onboarding.bank.account", "payout_file") in {(r["resource"], r["purpose"]) for r in logs(worker, w, who)}
    for x in ["person", "other", "ca", "head"]:
        denied(api, w, w.p[x], "select * from pulse.pay_bank_sealed(%s)", (run,))
    as_(api, w, w.p["founder"], "select pulse.pay_run_lock(%s,%s)", (run, lock_body([who])))
    slip = val(api, w, w.p["hr"], "select pulse.pay_run_get(%s)", (run,))["lines"][0]["payslip"]["id"]
    assert one(api, w, who, "select person_id from pulse.pay_payslip_sealed(%s,'pdf')", (slip,))["person_id"] == who
    assert one(api, w, w.p["hr"], "select person_id from pulse.pay_payslip_sealed(%s,'content')", (slip,))["person_id"] == who
    for x in ["other", "head", "ca", "admin"]:
        with pytest.raises(psycopg.errors.NoDataFound):
            as_(api, w, w.p[x], "select * from pulse.pay_payslip_sealed(%s,'pdf')", (slip,))
    mine = val(api, w, who, "select pulse.pay_payslips(%s)", (who,))
    assert len(mine) == 1 and mine[0]["seenAt"] is not None and mine[0]["version"] == 1
    denied(api, w, w.p["other"], "select pulse.pay_payslips(%s)", (who,))
    purposes = {(r["resource"], r["purpose"]) for r in logs(worker, w, who)}
    assert ("comp.payslip", "self") in purposes and ("comp.payslip", "payslip_view") in purposes
    # The file: founders and HR download it (logged per person), never the person or the CA.
    assert one(api, w, w.p["founder2"], "select format from pulse.pay_payout_sealed(%s)", (run,))["format"] == "axis"
    assert one(api, w, w.p["hr"], "select format from pulse.pay_payout_sealed(%s)", (run,))["format"] == "axis"
    for x in ["person", "ca", "other"]:
        denied(api, w, w.p[x], "select * from pulse.pay_payout_sealed(%s)", (run,))
    assert ("onboarding.bank.account", "payout_file_download") in {(r["resource"], r["purpose"]) for r in logs(worker, w, who)}
    assert any(e["kind"] == "payout.downloaded" for e in val(api, w, w.p["hr"], "select pulse.pay_run_get(%s)", (run,))["events"])


def test_ledger_by_pod_for_hr_totals_for_the_accountant(api, worker, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    run = checked_run(api, w, [who])
    assert as_(api, w, w.p["hr"], "select * from pulse.pay_ledger(null,null)") == []   # nothing until it locks
    as_(api, w, w.p["founder"], "select pulse.pay_run_lock(%s,%s)", (run, lock_body([who])))
    rows = as_(api, w, w.p["hr"], "select account,side,pod from pulse.pay_ledger(null,null)")
    assert {(r["account"], r["side"], r["pod"]) for r in rows} == {("salaries", "debit", "Pod 9"), ("net_payable", "credit", "Pod 9")}
    totals = as_(api, w, w.p["ca"], "select * from pulse.pay_ledger_totals(null,null)")
    assert {r["account"] for r in totals} == {"salaries", "net_payable"} and "pod" not in totals[0]
    denied(api, w, w.p["ca"], "select * from pulse.pay_ledger(null,null)")
    for x in ["other", "person", "admin"]:
        denied(api, w, w.p[x], "select * from pulse.pay_ledger_totals(null,null)")
    with worker.transaction():
        set_tenant(worker, w.org)
        acct = worker.execute("select purpose from privacy.access_log where org_id=%s and viewer_id=%s and resource='comp.ledger'", (w.org, w.p["ca"])).fetchall()
    assert [r["purpose"] for r in acct] == ["accountant_totals"]


def test_corrections_and_recovery_next_month(api, worker, pay):
    w = pay
    who, mate = w.p["person"], w.p["other"]
    for p in [who, mate]:
        start_pay(api, w, p)
    run = checked_run(api, w, [who, mate])
    as_(api, w, w.p["founder"], "select pulse.pay_run_lock(%s,%s)", (run, lock_body([who, mate])))
    refused(api, w, w.p["hr"], "select pulse.pay_run_open(%s,null)", (month_of(api, w),), match="correction")
    fix = open_run(api, w, note="A backdated change, synthetic")
    r = val(api, w, w.p["hr"], "select pulse.pay_run_get(%s)", (fix,))
    assert r["kind"] == "correction" and r["correctsId"] == str(run) and r["seq"] == 2
    prev = as_(api, w, w.p["hr"], "select kind,id,person_id,seq from pulse.pay_run_sealed(%s) where kind='previous'", (fix,))
    assert {(x["person_id"], x["seq"]) for x in prev} == {(who, 1), (mate, 1)}
    calc = save(api, w, fix, [who], recover=[who])
    as_(api, w, w.p["hr"], "select pulse.pay_run_check(%s,%s,null)", (fix, calc))
    as_(api, w, w.p["founder2"], "select pulse.pay_run_lock(%s,%s)", (fix, lock_body([who])))
    # The person gets a second payslip for the month; the overpayment is recovered in the next regular run.
    assert [s["version"] for s in val(api, w, who, "select pulse.pay_payslips(%s)", (who,))] == [2, 1]
    nxt = open_run(api, w, month=(month_of(api, w) + timedelta(days=35)).replace(day=1))
    carry = as_(api, w, w.p["hr"], "select id,person_id from pulse.pay_run_sealed(%s) where kind='carry'", (nxt,))
    assert [(x["id"], x["person_id"]) for x in carry] == [(fix, who)]
    calc = save(api, w, nxt, [who, mate])
    as_(api, w, w.p["hr"], "select pulse.pay_run_check(%s,%s,null)", (nxt, calc))
    as_(api, w, w.p["founder"], "select pulse.pay_run_lock(%s,%s)", (nxt, lock_body([who, mate], carries=[fix])))
    assert {r["recovered_in"] for r in worker_rows(worker, w, "select recovered_in from pulse.pay_run_line where run_id=%s", (fix,))} == {nxt}


def test_budget_roles_and_scenarios(api, worker, owner, pay):
    w = pay
    m = month_of(api, w)
    cells = Jsonb({"cells": [{"month": str(m), "pod": "Pod 9", "sealed": SEALED}, {"month": str((m + timedelta(days=35)).replace(day=1)), "pod": "", "sealed": SEALED}]})
    for who in ["founder", "lead"]:
        assert val(api, w, w.p[who], "select pulse.pay_budget_save(%s)", (cells,)) == 2
    for who in ["hr", "admin_pay", "person", "ca", "other"]:
        denied(api, w, w.p[who], "select pulse.pay_budget_save(%s)", (cells,))
    assert len(as_(api, w, w.p["hr"], "select * from pulse.pay_budget_sealed(%s,%s)", (m, m + timedelta(days=365)))) == 2
    for who in ["ca", "other", "person", "admin"]:
        denied(api, w, w.p[who], "select * from pulse.pay_budget_sealed(%s,%s)", (m, m))
    # Clearing a cell.
    val(api, w, w.p["founder"], "select pulse.pay_budget_save(%s)", (Jsonb({"cells": [{"month": str(m), "pod": "Pod 9", "sealed": None}]}),))
    assert len(as_(api, w, w.p["hr"], "select * from pulse.pay_budget_sealed(%s,%s)", (m, m))) == 0
    with owner.transaction():
        set_tenant(owner, w.org)
        job = owner.execute("insert into pulse.ats_job(org_id,title,status,created_by) values(%s,'Synthetic editor','open',%s) returning id", (w.org, w.p["hr"])).fetchone()["id"]
    role = val(api, w, w.p["founder"], "select pulse.pay_role_save(%s)", (Jsonb({"title": "Editor", "pod": "Pod 9", "count": 2, "from": str(m), "jobId": str(job), "sealed": SEALED}),))
    denied(api, w, w.p["hr"], "select pulse.pay_role_save(%s)", (Jsonb({"title": "Editor", "from": str(m), "sealed": SEALED}),))
    refused(api, w, w.p["founder"], "select pulse.pay_role_save(%s)", (Jsonb({"title": "Editor", "from": str(m), "jobId": str(uuid.uuid4()), "sealed": SEALED}),), match="open job")
    roles = as_(api, w, w.p["hr"], "select id,job,count,status from pulse.pay_roles_sealed()")
    assert [(r["id"], r["job"], r["count"], r["status"]) for r in roles] == [(role, "Synthetic editor", 2, "planned")]
    val(api, w, w.p["lead"], "select pulse.pay_role_save(%s)", (Jsonb({"id": str(role), "status": "dropped"}),))
    assert as_(api, w, w.p["hr"], "select status from pulse.pay_roles_sealed()")[0]["status"] == "dropped"
    # Pay never goes on the job: the ATS table keeps no amount.
    with owner.transaction():
        set_tenant(owner, w.org)
        cols = {r["column_name"] for r in owner.execute("select column_name from information_schema.columns where table_schema='pulse' and table_name='ats_job'").fetchall()}
    assert not cols & {"pay", "salary", "monthly", "cost", "s_data"}
    sid = val(api, w, w.p["founder"], "select pulse.pay_scenario_save(%s)", (Jsonb({"name": "Two editors in November", "steps": 2, "sealed": SEALED}),))
    denied(api, w, w.p["hr"], "select pulse.pay_scenario_save(%s)", (Jsonb({"name": "HR's", "sealed": SEALED}),))
    assert [r["name"] for r in as_(api, w, w.p["hr"], "select name from pulse.pay_scenarios_sealed()")] == ["Two editors in November"]
    denied(api, w, w.p["ca"], "select * from pulse.pay_scenarios_sealed()")
    denied(api, w, w.p["hr"], "select pulse.pay_scenario_archive(%s)", (sid,))
    as_(api, w, w.p["lead"], "select pulse.pay_scenario_archive(%s)", (sid,))
    assert as_(api, w, w.p["hr"], "select name from pulse.pay_scenarios_sealed()") == []
    purposes = {r["purpose"] for r in worker_rows(worker, w, "select purpose from privacy.access_log where org_id=%s and resource in ('comp.budget','comp.scenario')", (w.org,))}
    assert {"budget_view", "roles_view", "scenarios_view"} <= purposes


def test_projection_reads_records_offers_and_changes_waiting(api, worker, pay):
    w = pay
    start_pay(api, w, w.p["person"])
    cid = val(api, w, w.p["hr"], "select pulse.comp_change_save(%s)", (Jsonb({"person": str(w.p["person"]), "kind": "raise", "effectiveOn": str(month_of(api, w) + timedelta(days=40)),
                                                                                "payType": "salary", "reason": "Synthetic", "submit": True, "sealed": SEALED}),))
    inp = val(api, w, w.p["hr"], "select pulse.pay_projection_inputs()")
    me = next(p for p in inp["people"] if p["id"] == str(w.p["person"]))
    assert [q["id"] for q in me["pending"]] == [str(cid)] and len(me["versions"]) == 1
    kinds = {(r["kind"], r["id"]) for r in as_(api, w, w.p["hr"], "select kind,id from pulse.pay_projection_sealed()")}
    assert ("change", cid) in kinds
    for who in ["ca", "other", "person", "admin"]:
        denied(api, w, w.p[who], "select pulse.pay_projection_inputs()")
        denied(api, w, w.p[who], "select * from pulse.pay_projection_sealed()")
    assert ("comp.pay", "projection") in {(r["resource"], r["purpose"]) for r in logs(worker, w, w.p["person"])}


def test_payroll_through_the_api(worker, owner, api, tmp_path):
    import json
    import os
    import subprocess
    from pathlib import Path

    from test_comp import _api_world
    w, roles, config, wc = _api_world(worker, owner, api)
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_REPORT": str(tmp_path / "payroll.json"), "TEST_KEY_DIR": str(keys), "PULSE_CI": "1"}
    env.pop("PULSE_DOCUMENT_KEY_FILE", None)
    result = subprocess.run(["node", "test/payroll-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, text=True, capture_output=True, timeout=600)
    assert result.returncode == 0, (result.stdout + "\n" + result.stderr)[-6000:]
    assert json.loads((tmp_path / "payroll.json").read_text())["checks"] >= 50
    # The API's own log never carries an amount, an account number or a master key.
    log = result.stdout + result.stderr
    for figure in ["3500000", "3000000", "30,000", "918273645501", "4800000"]:
        assert figure not in log
    for line in (keys / "document-master.key").read_text().split("\n"):
        if line.strip():
            assert line.split()[1] not in log


@pytest.mark.skipif(__import__("os").environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser flows need PULSE_AUTH_BROWSER=1 and a built web app")
def test_payroll_in_the_browser(worker, owner, api, tmp_path):
    import json
    import os
    import subprocess
    from pathlib import Path

    from test_comp import _api_world
    w, roles, config, wc = _api_world(worker, owner, api, names={"person": "Neha Jivop", "other": "Ahoro Nair", "head": "Tara Kapoor", "hr": "Asha Kireteso",
                                                                  "founder": "Meera Iyer", "founder2": "Rumam Menon"})
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_REPORT": str(tmp_path / "browser.json"), "TEST_KEY_DIR": str(keys), "PULSE_CI": "1"}
    p = subprocess.run(["node", "test/payroll-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "browser.json").read_text()) if (tmp_path / "browser.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]
