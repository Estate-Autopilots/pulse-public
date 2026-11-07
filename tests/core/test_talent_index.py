"""R55 talent index in the database: everyone who works on projects sees a model's shoots, projects and videos; what a
model costs is read only by leadership with finance grants (never by an admin without them), and every read is
audited; review decisions about a model's name or a shoot's project are taken by an individual admin and kept.
Synthetic tenants, names and figures only."""
import uuid
from datetime import date

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def talent_world(worker, w):
    """Two models (one a one-word duplicate), a client project, two shoots, one fee line, an alias and two suggestions."""
    model, dup, client, project, other = (uuid.uuid4() for _ in range(5))
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name in ((model, "Asha Rao"), (dup, "Asha")):
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'talent')", (pid, w.org, name))
            worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,source) values(%s,%s,'talent','test')", (w.org, pid))
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Northstar')", (client, w.org))
        no = worker.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        for pid, title, n in ((project, "Lakeview", no), (other, "Parkside", no + 1)):
            worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,client_id,start_month) values(%s,%s,%s,%s,%s,%s,'2026-08-01')",
                           (pid, w.org, n, title, title, client))
        worker.execute("insert into pulse.talent_alias(org_id,alias_key,alias,person_id,basis,confidence,status,seen) values(%s,'asha','Asha',%s,'first_name',0.7,'review',2)", (w.org, model))
        for key, day, proj in (("sd:synthetic:Sep:2:asha", date(2026, 9, 2), project), ("pt:synthetic:Sep:9:asha", date(2026, 9, 9), None)):
            worker.execute("""insert into pulse.talent_shoot(org_id,source_key,person_id,alias,shoot_on,month,client_label,project_id,project_basis,project_confidence,
                              place,place_basis,sources,source) values(%s,%s,%s,'asha',%s,'2026-09-01','Lakeview',%s,%s,%s,'River Side','none','{shoot_sheet}',%s)""",
                           (w.org, key, model, day, proj, "client_name" if proj else "none", 0.9 if proj else None, Jsonb({"type": "sheet", "file": "Synthetic"})))
        worker.execute("""insert into pulse_priv.talent_fee(org_id,source_key,person_id,alias,shoot_on,month,charges,travel,total,paid,shoot_keys,source)
                          values(%s,'pt:synthetic:Sep:7:asha',%s,'asha','2026-09-02','2026-09-01',4000,400,4400,'Paid','{sd:synthetic:Sep:2:asha}',%s)""",
                       (w.org, model, Jsonb({"type": "sheet", "file": "Synthetic"})))
        alias_item = worker.execute("""insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence)
            values(%s,'talent:alias:asha','talent','Which model is “Asha”?',%s,0.7,'{}') returning id""",
            (w.org, Jsonb({"what": "alias", "aliasKey": "asha", "personId": str(model), "options": [{"id": str(model)}, {"id": str(dup)}]}))).fetchone()["id"]
        shoot_item = worker.execute("""insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence)
            values(%s,'talent:shoot:pt:synthetic:Sep:9:asha','talent','Which project was the shoot on 9 Sep for?',%s,0.5,'{}') returning id""",
            (w.org, Jsonb({"what": "shoot_project", "sourceKey": "pt:synthetic:Sep:9:asha", "projectId": str(other)}))).fetchone()["id"]
    return model, dup, project, other, alias_item, shoot_item


def leader(worker, w):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Founder','staff')", (pid, w.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')", (w.org, pid))
    return pid


def test_shoots_are_work_data_and_fees_are_finance_data(api, worker, team):
    w = team
    model, *_ = talent_world(worker, w)
    # A member sees shoots and aliases, never fees.
    assert one(api, w, w.editor, "select count(*) n from pulse.talent_shoot")["n"] == 2
    assert one(api, w, w.editor, "select count(*) n from pulse.talent_alias")["n"] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select * from pulse_priv.talent_fee")
    assert one(api, w, w.editor, "select pulse.talent_cost_visible() v")["v"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.talent_fees()")
    # An organisation admin without the finance grants sees no fee either; with them, the fees and an audit row.
    assert one(api, w, w.manager, "select pulse.talent_cost_visible() v")["v"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.manager, "select pulse.talent_fees()")
    with worker.transaction():
        set_tenant(worker, w.org)
        for perm in ("money.read", "money.amount.read"):
            worker.execute("insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s)", (w.org, w.manager, perm))
    fees = one(api, w, w.manager, "select pulse.talent_fees(%s) f", (model,))["f"]
    assert len(fees) == 1 and float(fees[0]["total"]) == 4400 and fees[0]["shootKeys"] == ["sd:synthetic:Sep:2:asha"]
    # Leadership reads them by role; each read is written to the audit log.
    founder = leader(worker, w)
    assert one(api, w, founder, "select pulse.talent_cost_visible() v")["v"] is True
    assert len(one(api, w, founder, "select pulse.talent_fees() f")["f"]) == 1
    with worker.transaction():
        set_tenant(worker, w.org)
        reads = worker.execute("select count(*) n from pulse.audit_event where action='restricted_read' and resource='talent.fee'").fetchone()["n"]
    assert reads >= 2


def test_review_decisions_are_an_admins_and_stick(api, worker, team):
    w = team
    model, dup, _project, other, alias_item, shoot_item = talent_world(worker, w)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.talent_decide(%s,true,%s)", (alias_item, model))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.talent_decide(%s,true,%s)", (alias_item, model))   # HR does not decide who a model is
    # Only a talent contact can be chosen.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.talent_decide(%s,true,%s)", (alias_item, w.editor))
    as_(api, w, w.manager, "select pulse.talent_decide(%s,true,%s)", (alias_item, dup))
    alias = one(api, w, w.manager, "select person_id,status,basis,decided_by from pulse.talent_alias where alias_key='asha'")
    assert alias["person_id"] == dup and alias["status"] == "confirmed" and alias["basis"] == "review" and alias["decided_by"] == w.manager
    assert one(api, w, w.manager, "select count(*) n from pulse.talent_shoot where person_id=%s", (dup,))["n"] == 2
    item = one(api, w, w.manager, "select status,proposed->>'chosen' chosen from pulse.review_item where id=%s", (alias_item,))
    assert item["status"] == "accepted" and item["chosen"] == str(dup)
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.manager, "select pulse.talent_decide(%s,false)", (alias_item,))      # already decided
    # Accepting a shoot's suggestion links it to the proposed project.
    as_(api, w, w.manager, "select pulse.talent_decide(%s,true)", (shoot_item,))
    shoot = one(api, w, w.manager, "select project_id,project_basis,project_confidence from pulse.talent_shoot where source_key='pt:synthetic:Sep:9:asha'")
    assert shoot["project_id"] == other and shoot["project_basis"] == "review" and float(shoot["project_confidence"]) == 1
    assert one(api, w, w.editor, "select pulse.talent_key('Sobuha  O.') k")["k"] == "sobuha o"
