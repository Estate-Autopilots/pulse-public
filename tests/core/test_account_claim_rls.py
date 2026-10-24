"""Uploader account claims stay tenant-scoped and visible only to the claimant or an authorized reviewer."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world, drive_id, new_code
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _account_with_delivery(worker, owner, w, handle, purpose="Uploader"):
    file_id = drive_id()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set unit_id=%s where org_id=%s and id=%s", (w.pod, w.org, w.project))
        worker.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,uploader_account,
                       account_basis,observed_at,event_seq)
                       values(%s,%s,'Synthetic design export.psd','image/vnd.adobe.photoshop','Synthetic',%s,%s,'test',now(),1)""",
                       (w.org, file_id, w.project, handle))
        worker.execute("""insert into pulse.delivery(org_id,file_id,project_id,uploader_account,kind,delivered_at,rule,rule_detail,event_seq)
                       values(%s,%s,%s,%s,'final',now(),'synthetic','Synthetic test delivery',1)""",
                       (w.org, file_id, w.project, handle))
    with owner.transaction():
        set_tenant(owner, w.org)
        account = owner.execute("""insert into pulse.account(org_id,provider,handle,purpose)
                                  values(%s,'google',%s,%s) returning id""",
                                (w.org, handle, purpose)).fetchone()["id"]
    return account


def _assert_api_claim_insert_denied(api, w, account):
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("insert into pulse.account_claim(org_id,account_id,person_id) values(%s,%s,%s)",
                    (w.org, account, w.manager))


@pytest.mark.parametrize("case", ["workspace", "client_contact", "other_person_link"])
def test_account_claim_insert_policy_rejects_workspace_contacts_and_ambiguous_links(worker, owner, api, case):
    w = build_world(worker, owner, api)
    handle = f"{case}@outside.example"
    purpose = "Workspace account" if case == "workspace" else "Uploader"
    account = _account_with_delivery(worker, owner, w, handle, purpose)
    clean_account = _account_with_delivery(worker, owner, w, f"clean-{case}@outside.example")
    with owner.transaction():
        set_tenant(owner, w.org)
        if case == "client_contact":
            external = uuid.uuid4()
            owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic client contact','client')",
                          (external, w.org))
            owner.execute("""insert into pulse.contact_profile(org_id,person_id,contact_type,email)
                              values(%s,%s,'other',%s)""", (w.org, external, f" {handle.upper()} "))
        elif case == "other_person_link":
            owner.execute("""insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,
                              method,valid_from,evidence)
                              values(%s,'person',%s,'account','google:'||%s,%s,'manual',now(),'{}')""",
                          (w.org, w.editor, handle, handle))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert w.project in api.execute("select unnest(pulse.work_projects()) project").fetchall()[0].values()
        clean_claim = api.execute("""insert into pulse.account_claim(org_id,account_id,person_id)
                                    values(%s,%s,%s) returning id""",
                                  (w.org, clean_account, w.manager)).fetchone()
        assert clean_claim["id"]
    _assert_api_claim_insert_denied(api, w, account)


def test_account_claim_flow_works_for_staff_hr_and_manager(worker, owner, api):
    w = build_world(worker, owner, api)
    claimant_email = f"claimant@{w.domain}"
    hr_email = f"hr@{w.domain}"
    manager_email = f"manager@{w.domain}"
    first = _account_with_delivery(worker, owner, w, "first-designer@outside.example")
    second = _account_with_delivery(worker, owner, w, "second-designer@outside.example")
    with owner.transaction():
        set_tenant(owner, w.org)
        for email, person_id, role in ((claimant_email, w.editor, "Designer"),
                                       (manager_email, w.manager, "Manager"),
                                       (hr_email, w.lead, "HR")):
            owner.execute("""insert into pulse.people_profile(org_id,person_id,role,evidence,accounts,manager_id)
                              values(%s,%s,%s,'synthetic',%s,%s)
                              on conflict(person_id) do update set accounts=excluded.accounts,
                                manager_id=coalesce(excluded.manager_id,pulse.people_profile.manager_id)""",
                          (w.org, person_id, role, [email], w.manager if person_id == w.editor else None))
            owner.execute("""insert into pulse.account(org_id,provider,handle,holder_person_id,purpose)
                              values(%s,'google',%s,%s,'Workspace account')""", (w.org, email, person_id))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from)
                          values(%s,%s,'hr','2020-01-01')""", (w.org, w.lead))
        for person_id in (w.editor,):
            worker.execute("""insert into pulse.task(id,org_id,project_id,title,assignee_person_id)
                              values(%s,%s,%s,'Synthetic account claim task',%s)""",
                          (uuid.uuid4(), w.org, w.project, person_id))
    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org),
           "TEST_CLAIMANT_EMAIL": claimant_email, "TEST_HR_EMAIL": hr_email,
           "TEST_MANAGER_EMAIL": manager_email,
           "TEST_ACCOUNT_FIRST": str(first), "TEST_ACCOUNT_SECOND": str(second)}
    result = subprocess.run(["node", "test/account-claim-flow-runner.mjs"], cwd=root / "services/api",
                            env=env, capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stderr[-3000:]
    with owner.transaction():
        set_tenant(owner, w.org)
        records = owner.execute("""select claim.account_id,claim.status,account.holder_person_id
            from pulse.account_claim claim join pulse.account account
              on account.org_id=claim.org_id and account.id=claim.account_id
            where claim.org_id=%s and claim.account_id=any(%s)""", (w.org, [first, second])).fetchall()
    assert {row["account_id"]: (row["status"], row["holder_person_id"]) for row in records} == {
        first: ("reverted", None), second: ("confirmed", w.editor)}


def test_ambiguous_pending_claim_can_be_rejected_and_reclaimed(worker, owner, api):
    w = build_world(worker, owner, api)
    claimant_email = f"claimant@{w.domain}"
    manager_email = f"manager@{w.domain}"
    handle = "ambiguous-designer@outside.example"
    account = _account_with_delivery(worker, owner, w, handle)
    with owner.transaction():
        set_tenant(owner, w.org)
        for email, person_id, role, manager_id in (
            (claimant_email, w.editor, "Designer", w.manager),
            (manager_email, w.manager, "Manager", None),
        ):
            owner.execute("""insert into pulse.people_profile(org_id,person_id,role,evidence,accounts,manager_id)
                              values(%s,%s,%s,'synthetic',%s,%s)""",
                          (w.org, person_id, role, [email], manager_id))
            owner.execute("""insert into pulse.account(org_id,provider,handle,holder_person_id,purpose)
                              values(%s,'google',%s,%s,'Workspace account')""",
                          (w.org, email, person_id))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.task(id,org_id,project_id,title,assignee_person_id)
                          values(%s,%s,%s,'Synthetic ambiguous account claim task',%s)""",
                       (uuid.uuid4(), w.org, w.project, w.editor))

    root = Path(__file__).resolve().parents[2]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "PULSE_ORG_ID": str(w.org),
           "TEST_CLAIMANT_EMAIL": claimant_email, "TEST_MANAGER_EMAIL": manager_email,
           "TEST_ACCOUNT_AMBIGUOUS": str(account)}

    def run_phase(phase):
        result = subprocess.run(["node", "test/account-claim-ambiguity-runner.mjs", phase],
                                cwd=root / "services/api", env=env, capture_output=True,
                                text=True, timeout=60, check=False)
        assert result.returncode == 0, result.stderr[-3000:]

    run_phase("claim")
    with owner.transaction():
        set_tenant(owner, w.org)
        conflict = owner.execute("""insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,
                                 raw_value,method,valid_from,evidence)
                                 values(%s,'person',%s,'manual','google:'||%s,%s,'manual',now(),'{}')
                                 returning org_id,entity_type,entity_id,source,source_key,raw_value,method,valid_from,valid_to""",
                                 (w.org, w.editor2, handle, handle)).fetchone()

    run_phase("decide")
    with owner.transaction():
        set_tenant(owner, w.org)
        claim = owner.execute("""select claim.id,claim.status,claim.decided_by,claim.reason,account.holder_person_id
            from pulse.account_claim claim join pulse.account account
              on account.org_id=claim.org_id and account.id=claim.account_id
            where claim.org_id=%s and claim.account_id=%s and claim.status='rejected'""",
                              (w.org, account)).fetchone()
        assert claim is not None
        assert claim["decided_by"] == w.manager
        assert claim["reason"] == "Conflicting active identity link"
        assert claim["holder_person_id"] is None
        unchanged = owner.execute("""select org_id,entity_type,entity_id,source,source_key,raw_value,method,valid_from,valid_to
            from pulse.identity_link where org_id=%s and entity_type=%s and source=%s and source_key=%s and valid_from=%s""",
                                  (w.org, conflict["entity_type"], conflict["source"], conflict["source_key"],
                                   conflict["valid_from"])).fetchone()
        assert unchanged == conflict
        assert owner.execute("""select count(*) n from pulse.audit_event where org_id=%s
            and action='account_claim.rejected' and resource='uploader.account_claim' and resource_id=%s""",
                             (w.org, str(claim["id"]))).fetchone()["n"] == 1
        owner.execute("""update pulse.identity_link set valid_to=now()
            where org_id=%s and entity_type=%s and source=%s and source_key=%s and valid_from=%s""",
                      (w.org, conflict["entity_type"], conflict["source"], conflict["source_key"],
                       conflict["valid_from"]))

    run_phase("retry")
    with owner.transaction():
        set_tenant(owner, w.org)
        statuses = owner.execute("select status from pulse.account_claim where org_id=%s and account_id=%s",
                                 (w.org, account)).fetchall()
        assert {row["status"] for row in statuses} == {"rejected", "pending"}
        assert owner.execute("select holder_person_id from pulse.account where org_id=%s and id=%s",
                             (w.org, account)).fetchone()["holder_person_id"] is None


def test_account_claim_is_tenant_scoped_and_person_visible(worker, owner, api):
    w = build_world(worker, owner, api)
    other_org = uuid.uuid4()
    other_code = new_code()
    with worker.transaction():
        set_tenant(worker, other_org)
        worker.execute("insert into pulse.org(id,slug,name,code) values(%s,%s,%s,%s)",
                       (other_org, "claim-" + str(other_org), "Synthetic second tenant", other_code))
        set_tenant(worker, w.org)
        account = worker.execute(
            "insert into pulse.account(org_id,provider,handle,purpose) values(%s,'google','designer@claim.example','Uploader') returning id",
            (w.org,)).fetchone()["id"]
    claim_id = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.account_claim(org_id,id,account_id,person_id) values(%s,%s,%s,%s)",
                      (w.org, claim_id, account, w.editor))

    with api.transaction():
        set_tenant(api, w.org, w.editor)
        own = api.execute("select id from pulse.account_claim").fetchall()
        assert [row["id"] for row in own] == [claim_id]
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select id from pulse.account_claim").fetchall() == []
        set_tenant(api, other_org, w.editor)
        assert api.execute("select id from pulse.account_claim").fetchall() == []


def test_claim_reviewer_can_set_holder_but_not_account_purpose(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr','2020-01-01')",
                       (w.org, w.manager))
    with owner.transaction():
        set_tenant(owner, w.org)
        account = owner.execute(
            "insert into pulse.account(org_id,provider,handle,purpose) values(%s,'google','designer@claim.example','Uploader') returning id",
            (w.org,)).fetchone()["id"]
        owner.execute("""insert into pulse.account_claim(org_id,account_id,person_id,status,decided_by,decided_at)
                        values(%s,%s,%s,'confirmed',%s,now())""",
                       (w.org, account, w.editor, w.manager))

    with api.transaction():
        set_tenant(api, w.org, w.manager)
        holder_update = api.execute("update pulse.account set holder_person_id=%s where org_id=%s and id=%s",
                                    (w.editor, w.org, account))
        assert holder_update.rowcount == 1

    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("update pulse.account set purpose='Workspace account' where org_id=%s and id=%s",
                    (w.org, account))
