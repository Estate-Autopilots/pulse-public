"""Salary and personal contact: the API role reads them only through the logged functions, and only with the HR or
leadership role; operational admins require the named permission."""
import json

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_gdrive_snapshot.roster import seed_roster
from pulse_sdk.db import set_tenant


def _as(conn, org, viewer):
    set_tenant(conn, org, viewer)


def test_salary_needs_role_and_permission_and_every_read_is_logged(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'hr','2026-01-01')", (w.org, w.lead))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'admin','2026-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values (%s,%s,'hr.salary.read','test')", (w.org, w.lead))
        worker.execute("insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis) "
                       "values (%s,%s,'2026-07-01','monthly',12345,'f','sheet','july','test')", (w.org, w.editor))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # no path to the table itself
        _as(api, w.org, w.lead)
        api.execute("select amount from pulse_priv.hr_compensation")
    for viewer in (w.editor, w.manager):                                            # no role; role without the permission
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            _as(api, w.org, viewer)
            api.execute("select * from pulse.hr_salary_read(%s)", (w.editor,))
    with api.transaction():
        _as(api, w.org, w.lead)
        rows = api.execute("select kind,amount from pulse.hr_salary_read(%s)", (w.editor,)).fetchall()
        log = api.execute("select viewer,resource from pulse.hr_access_log(%s)", (w.editor,)).fetchall()
    assert [(r["kind"], int(r["amount"])) for r in rows] == [("monthly", 12345)]
    assert [r["resource"] for r in log] == ["hr.salary"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # operational admins need contact permission
        _as(api, w.org, w.manager)
        api.execute("select * from pulse.hr_contact_read(%s)", (w.editor,))


def test_hr_document_sources_are_hidden_from_other_staff(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values (%s,%s,'hr','2026-01-01')", (w.org, w.lead))
        for source, restricted in (("ops_hub", False), ("hr_document", True)):
            worker.execute("insert into pulse.person_source(org_id,person_id,source,source_ref,label,written_name,restricted) "
                           "values (%s,%s,%s,'x',%s,'Name',%s)", (w.org, w.editor, source, source, restricted))
    seen = {}
    for name, viewer in (("staff", w.editor), ("hr", w.lead)):
        with api.transaction():
            _as(api, w.org, viewer)
            seen[name] = {r["source"] for r in api.execute("select source from pulse.person_source where person_id=%s", (w.editor,)).fetchall()}
    assert seen == {"staff": {"ops_hub"}, "hr": {"ops_hub", "hr_document"}}


def test_metadata_roster_refresh_preserves_hr_records_and_refreshes_profile_evidence(worker, owner, api, monkeypatch, tmp_path):
    w = build_world(worker, owner, api)
    group_roster = tmp_path / "group-members.csv"
    group_roster.write_text("group,name,email\ncreative,Editer One,\n")
    monkeypatch.setenv("EA_GROUPS_ROSTER", str(group_roster))

    class EmptyRows:
        def fetchall(self):
            return []

    class MetadataIndex:
        def execute(self, sql, _params=()):
            assert "drive_text" not in sql.lower()
            assert "ws_user" in sql
            return EmptyRows()

    config = {
        "team": [{"name": "Editor One", "key": "editor-one", "role": "Video Editor", "pod": "Pod 1"}],
        "name_aliases": {}, "confirm_same_person": [], "shared_local_parts": [], "mailbox_roles": {},
        "sensitive_access": [],
    }
    workspace = {w.editor: {"name": "Editor One", "accounts": [w.editor_handle]}}
    metadata_options = [{"value": name, "source": "As written in a source"}
                        for name in ("Editer One", "Editor One")]
    previous_options = [*metadata_options, {"value": "Legacy Editor", "source": "Salary sheet"}]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,field_sources) "
                       "values (%s,%s,'Video Editor','HR-era profile',%s)",
                       (w.org, w.editor, Jsonb({"status": {"source": "Salary sheet", "confirm": True}})))
        worker.execute("insert into pulse.person_source(org_id,person_id,source,source_ref,label,written_name,restricted) "
                       "values (%s,%s,'hr_document','synthetic-sheet','Synthetic salary sheet','Editor One',true)",
                       (w.org, w.editor))
        worker.execute("insert into pulse.person_flag(org_id,person_id,field,summary,options,status,resolution) "
                       "values (%s,%s,'identity','Confirmed using HR evidence',%s,'resolved','Confirmed')",
                       (w.org, w.editor, Jsonb(previous_options)))
        worker.execute("insert into pulse.person_flag(org_id,person_id,field,summary,options) "
                       "values (%s,%s,'status','Not in current team lists',%s)",
                       (w.org, w.editor, Jsonb([{"value": "inactive", "source": "Not in a current list"}])))
        worker.execute("insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis) "
                       "values (%s,%s,'2026-10-01','monthly',42000,'synthetic-file','Synthetic salary sheet','Current','Synthetic test')",
                       (w.org, w.editor))
        worker.execute("insert into pulse_priv.hr_document(org_id,person_id,doc_type,file_id,file_name,location) "
                       "values (%s,%s,'appointment_letter','synthetic-letter','Synthetic appointment letter','Synthetic/HR')",
                       (w.org, w.editor))

        seed_roster(MetadataIndex(), worker, w.org, config, workspace)

        flags = worker.execute("select field,status,options,resolution from pulse.person_flag where person_id=%s",
                               (w.editor,)).fetchall()
        profile = worker.execute("select evidence,field_sources from pulse.people_profile where person_id=%s",
                                 (w.editor,)).fetchone()
        compensation = worker.execute("select amount from pulse_priv.hr_compensation where person_id=%s",
                                      (w.editor,)).fetchall()
        documents = worker.execute("select doc_type,file_id from pulse_priv.hr_document where person_id=%s",
                                   (w.editor,)).fetchall()
        hr_sources = worker.execute("select source from pulse.person_source where person_id=%s and source='hr_document'",
                                    (w.editor,)).fetchall()

    identity = next(flag for flag in flags if flag["field"] == "identity")
    assert identity["status"] == "resolved"
    assert identity["options"] == previous_options
    assert identity["resolution"] == "Confirmed"
    assert not any(flag["field"] == "status" and flag["status"] == "open" for flag in flags)
    assert profile["evidence"] == "Named in Ops Hub team list, Planned groups roster, Workspace directory."
    assert "status" not in profile["field_sources"]
    assert [row["amount"] for row in compensation] == [42000]
    assert [(row["doc_type"], row["file_id"]) for row in documents] == [("appointment_letter", "synthetic-letter")]
    assert len(hr_sources) == 1


def test_employee_hr_self_view_is_allowlisted_self_scoped_and_audited(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,department,employment_type,joined_on) "
                       "values(%s,%s,'Video editor','synthetic','Creative','full_time','2024-03-11') "
                       "on conflict(person_id) do update set department=excluded.department,employment_type=excluded.employment_type,joined_on=excluded.joined_on",
                       (w.org, w.editor))
        worker.execute("insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) "
                       "values(%s,'person',%s,'department','Studio','Creative',%s),(%s,'person',%s,'notes','safe','Synthetic private note',%s)",
                       (w.org, w.editor, w.lead, w.org, w.editor, w.lead))
        for doc_type in ("appointment_letter", "salary_certificate", "id_passport", "bank_details"):
            worker.execute("insert into pulse_priv.hr_document(org_id,person_id,doc_type,file_id,file_name) values(%s,%s,%s,'synthetic-id','Synthetic document')",
                           (w.org, w.editor, doc_type))

    with api.transaction():
        _as(api, w.org, w.editor)
        data = api.execute("select pulse.hr_self_profile() data").fetchone()["data"]

    assert data["employee"] == {"name": "Editor One", "status": "active", "role": "Video editor", "department": "Creative",
                                "employmentType": "full_time", "joinedOn": "2024-03-11"}
    assert [row["field"] for row in data["history"]] == ["department"]
    assert data["history"][0]["from"] == "Studio" and data["history"][0]["to"] == "Creative"
    assert [row["type"] for row in data["documents"]] == ["appointment_letter"]
    assert {row["resource"] for row in data["accessHistory"]} >= {"hr.profile", "hr.history", "hr.documents", "hr.access_log"}
    forbidden = {"salary", "finance", "governmentid", "passport", "bank", "kyc", "identity", "fileid", "filename"}
    def keys(value):
        if isinstance(value, dict):
            return set(value) | set().union(*(keys(child) for child in value.values()))
        if isinstance(value, list):
            return set().union(*(keys(child) for child in value)) if value else set()
        return set()
    assert not {key.lower() for key in keys(data)} & forbidden
    assert "Synthetic private note" not in json.dumps(data)

    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,'Editor Two','synthetic')",
                       (w.org, w.editor2))
    with api.transaction():
        _as(api, w.org, w.editor2)
        other_data = api.execute("select pulse.hr_self_profile() data").fetchone()["data"]
    assert other_data["employee"]["name"] == "Editor Two"
    assert all(entry["viewer"] == "Editor Two" for entry in other_data["accessHistory"])
