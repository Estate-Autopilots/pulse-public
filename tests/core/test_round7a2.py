"""Round 7A2 boundaries and replay semantics. All names, documents and values are synthetic."""
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_company import configure


def test_statement_allowlist_category_identity_and_tenant(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    row = {"date": "2026-07-01", "vendor": "Synthetic merchant 1234 5678 9012", "amount": "12.50", "currency": "INR", "direction": "outflow",
           "category": "Other", "account_last4": "9012", "reference_hash": "a" * 64, "account_number": "123456789012", "credentials": "SYNTHETIC_SECRET"}
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.money_statement_save(%s,'bank')", (Jsonb([row]),))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute("select pulse.money_statement_save(%s,'bank') n", (Jsonb([row]),)).fetchone()["n"] == 1
        row["category"] = "Travel"
        assert api.execute("select pulse.money_statement_save(%s,'bank') n", (Jsonb([row]),)).fetchone()["n"] == 0
        data = api.execute("select pulse.money_workspace() data").fetchone()["data"]
        assert "123456789012" not in json.dumps(data)
        assert "1234 5678 9012" not in json.dumps(data)
        assert "SYNTHETIC_SECRET" not in json.dumps(data)
        assert data[0]["data"]["account_last4"] == "9012"
        api.execute("select pulse.money_category_save('money_sheet_transactions',%s,'Office')", (data[0]["id"],))
        assert api.execute("select pulse.money_read('money_sheet_transactions') data").fetchone()["data"]["rows"][0]["data"]["category"] == "Office"
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        assert worker.execute("select count(*) n from pulse_priv.money_observation").fetchone()["n"] == 0


def test_statement_rejects_raw_reference_and_full_account(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    for row in [{"date": "2026-07-01", "amount": 2, "currency": "INR", "direction": "inflow", "reference_hash": "secret"},
                {"date": "2026-07-01", "amount": 2, "currency": "INR", "direction": "inflow", "reference_hash": "a"*64, "account_last4": "12345678"}]:
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("select pulse.money_statement_save(%s,'bank')", (Jsonb([row]),))


def test_policy_versions_acknowledgement_and_stale_edits(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        first = api.execute("select pulse.policy_save('leave','Synthetic leave','Synthetic policy content for review.','published',0) id").fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.policy_acknowledge(%s)", (first,))
        api.execute("select pulse.policy_acknowledge(%s)", (first,))
        assert api.execute("select count(*) n from pulse.policy_ack").fetchone()["n"] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.policy_save('leave','Synthetic leave','Changed synthetic content.','published',1)")
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        second = api.execute("select pulse.policy_save('leave','Synthetic leave','Changed synthetic policy content.','published',1) id").fetchone()["id"]
    with pytest.raises(psycopg.errors.SerializationFailure), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.policy_save('leave','Synthetic leave','Stale synthetic policy content.','published',1)")
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.policy_acknowledge(%s)", (first,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert not api.execute("select 1 from pulse.policy_ack where document_id=%s", (second,)).fetchone()
        api.execute("select pulse.policy_acknowledge(%s)", (second,))


def test_public_audit_diff_excludes_private_salary_components(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,'hr.salary.write','synthetic'),(%s,%s,'hr.salary.read','synthetic')", (w.org,w.manager,w.org,w.manager))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("update pulse.project set title='Synthetic changed title' where id=%s", (w.project,))
        changes = api.execute("select changes from pulse.audit_event where resource='project' and action='update' order by at desc limit 1").fetchone()["changes"]
        assert changes["title"]["after"] == "Synthetic changed title"
        api.execute("select pulse.hr_salary_components_write(%s,'2026-07-01','current',89123.45,'Synthetic entry',%s,'2026-07-15',null)", (w.editor,Jsonb({"fixed":89123.45,"ctc":1234567.89})))
        salary = api.execute("select pulse.hr_salary_components_read(%s) data", (w.editor,)).fetchone()["data"]
        assert salary[0]["effectiveFrom"] == "2026-07-15"
        assert salary[0]["components"]["fixed"] == 89123.45
        audit = api.execute("select * from pulse.audit_event").fetchall()
        assert "89123.45" not in json.dumps(audit,default=str)
        assert "1234567.89" not in json.dumps(audit,default=str)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.hr_salary_components_read(%s)", (w.editor,))


def test_review_rule_preserves_manual_pod_and_requires_admin(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.review_rule(org_id,kind,threshold,enabled) values(%s,'project_pod',.95,true)", (w.org,))
        worker.execute("insert into pulse.review_rule(org_id,kind,threshold,enabled) values(%s,'onboard_project_fill',.95,true)", (w.org,))
        worker.execute("insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence) values(%s,'synthetic-rule','project_pod','project',%s,'Synthetic pod suggestion',%s,.99,%s)",(w.org,w.project,Jsonb({"pod":"Pod 1"}),Jsonb({"source":"synthetic"})))
        worker.execute("insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence) values(%s,'onboard_project_fill:pod:synthetic-project','project_pod','project',%s,'Configured fill pod suggestion',%s,.95,%s)",(w.org,w.project,Jsonb({"pod":"Pod 1"}),Jsonb({"ruleId":"northwind@1:pods:default","sampleFileIds":["synthetic-file-1"]})))
        worker.execute("insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence) values(%s,'configured-pod-rule:synthetic-project','project_pod','project',%s,'Rule-id fill pod suggestion',%s,.95,%s)",(w.org,w.project,Jsonb({"pod":"Pod 1"}),Jsonb({"ruleId":"northwind@1:pods:configured","sampleFileIds":["synthetic-file-rule"]})))
        worker.execute("insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence) values(%s,'onboard_project_fill:client:synthetic-project','onboard_project_fill','project',%s,'Configured fill client suggestion',%s,.95,%s)",(w.org,w.project,Jsonb({"field":"client","clientKey":"drive-path-client:synthetic","clientId":str(uuid.uuid4()),"clientName":"Synthetic Client"}),Jsonb({"ruleId":"northwind@1:project_paths:client","sampleFileIds":["synthetic-file-2"]})))
        worker.execute("insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence) values(%s,'onboard_project_fill:deliverable_type:synthetic-project','onboard_project_fill','project',%s,'Configured fill type suggestion',%s,.95,%s)",(w.org,w.project,Jsonb({"field":"deliverable_type","deliverableType":"model_video"}),Jsonb({"ruleId":"northwind@1:creative_types:model_video","sampleFileIds":["synthetic-file-3"]})))
        worker.execute("update pulse.project set locked='{unit_id}' where id=%s",(w.project,))
        assert worker.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 0
        worker.execute("update pulse.project set locked='{}' where id=%s",(w.project,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.review_apply_rules()")
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        # Fixture pod is named Pod 1 in build_world; existing PGS is preserved.
        before = api.execute("select lead_person_id from pulse.project where id=%s", (w.project,)).fetchone()
        assert api.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 1
        assert api.execute("select lead_person_id from pulse.project where id=%s", (w.project,)).fetchone() == before
        assert api.execute("select status from pulse.review_item where source_key='synthetic-rule'").fetchone()["status"] == "accepted"
        assert api.execute("select status from pulse.review_item where source_key='onboard_project_fill:pod:synthetic-project'").fetchone()["status"] == "pending"
        assert api.execute("select status from pulse.review_item where source_key='configured-pod-rule:synthetic-project'").fetchone()["status"] == "pending"
        assert api.execute("select status from pulse.review_item where source_key='onboard_project_fill:client:synthetic-project'").fetchone()["status"] == "pending"
        assert api.execute("select status from pulse.review_item where source_key='onboard_project_fill:deliverable_type:synthetic-project'").fetchone()["status"] == "pending"
        assert api.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 0


def test_performance_intake_scope_replay_and_unknown_actor(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        args=(w.editor,w.project,"synthetic-event")
        sql="select pulse.performance_submit('work_event',%s,%s,null,'exported',null,'unknown','editing',%s,now(),1) id"
        assert api.execute(sql,args).fetchone()["id"]
        assert api.execute(sql,args).fetchone()["id"] is None
        api.execute("select pulse.performance_submit('attendance',null,null,null,'presence_corroboration',null,'unknown','office','synthetic-unattributed',now(),.5)")
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert len(api.execute("select * from pulse.work_event").fetchall()) == 1
        assert api.execute("select * from pulse.attendance_signal").fetchall() == []
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select * from pulse.work_event").fetchall() == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.performance_submit('work_event',%s,null,null,'created',null,'unknown','desktop','fake-other',now(),1)",(w.editor2,))


def test_contact_rule_uses_source_contact_type_and_preserves_locks(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,locked) values(%s,%s,'other','{contact_type}')", (w.org,w.editor2))
        worker.execute("insert into pulse.review_rule(org_id,kind,threshold,enabled) values(%s,'contact_type',.95,true)", (w.org,))
        worker.execute("insert into pulse.review_item(org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence) values(%s,'synthetic-contact-rule','contact_type','contact',%s,'Synthetic contact suggestion',%s,.99,%s)", (w.org,w.editor2,Jsonb({"contactType":"talent"}),Jsonb({"source":"synthetic"})))
        assert worker.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 0
        worker.execute("update pulse.contact_profile set locked='{}' where person_id=%s", (w.editor2,))
        assert worker.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 1
        assert worker.execute("select contact_type,type_status from pulse.contact_profile where person_id=%s", (w.editor2,)).fetchone() == {"contact_type":"talent","type_status":"confirmed"}
        assert worker.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 0
