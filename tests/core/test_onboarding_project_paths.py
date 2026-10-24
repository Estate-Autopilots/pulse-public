from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from helpers import build_world, store
from psycopg.types.json import Jsonb
from pulse_gdrive_snapshot.backfill import drive_event
from pulse_gdrive_snapshot import team
from pulse_gdrive_snapshot.records import CLIENT_SOURCE, seed_records
from pulse_sdk.db import set_tenant
from pulse_sdk.ids import entity_id
from pulse_workers.deliveries import Deliveries
from pulse_workers.onboard import sort_org
from pulse_workers.projector import ProjectionRunner

def _previous_project_path(path: str) -> str | None:
    """The pre-rules project-root behavior, kept here as a synthetic bootstrap baseline."""
    parts = [part.strip() for part in path.split("/") if part.strip()]
    for index, part in enumerate(parts[:-1]):
        if part.casefold() not in ("client video shoot", "#0 - client work video package"):
            continue
        next_part = index + 1 + int(index + 1 < len(parts) and parts[index + 1].isdecimal()
                                    and len(parts[index + 1]) == 4)
        if next_part >= len(parts) or "past data" in parts[next_part].casefold():
            return None
        next_part += 1
        return "/".join(parts[:next_part + 1]) if next_part < len(parts) - 1 else None
    return None


def test_bootstrap_project_and_client_ids_match_before_and_after_folder_rules(worker, owner, api):
    world = build_world(worker, owner, api, notice=False)
    config = team.load_config()
    paths = [
        (
            "Drive/Client Video Shoot/2024/#10 - May 2024/"
            "#1 - Synthetic Project | Mr Synthetic Client | Pune | Residential/file.mp4"
        ),
        (
            "Drive/#0 - Client Work Video Package/3) June 2023/"
            "#2 - Synthetic Legacy | Ms Legacy Client | Baner | Luxury/source.mp4"
        ),
    ]
    previous_roots = [_previous_project_path(path) for path in paths]
    configured_roots = [team.project_path(path, config["project_paths"]) for path in paths]
    assert configured_roots == previous_roots
    project_ids = [entity_id(world.org, "project", "index_path", root) for root in previous_roots]
    client_ids_before = sorted(str(entity_id(world.org, "client", CLIENT_SOURCE, "drive-project:" + str(pid)))
                               for pid in project_ids)
    northwind_path = "Northwind/Quarterly Launch/Deliverables/Final.mp4"
    northwind_rules = [{"match": r"(?i)(?:^|/)(?P<client>[^/]+)/(?P<project>[^/]+)"
                                r"(?:/(?P<deliverable>deliverables?))?(?:/|$)"}]
    northwind_root = team.project_path(northwind_path, northwind_rules)
    northwind_project_id = entity_id(world.org, "project", "index_path", northwind_root)
    northwind_client_id = entity_id(world.org, "client", CLIENT_SOURCE, "drive-path-client:northwind")

    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute(
            "insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
            "values (%s,'folder_rules','ea-deliveries-v0',1,%s,true)",
            (world.org, Jsonb({"schema_version": 1, "project_paths": config["project_paths"], "pods": config["pods"]})),
        )
        for index, (root, project_id) in enumerate(zip(configured_roots, project_ids, strict=True), 1):
            worker.execute(
                "insert into pulse.project(id,org_id,registry_no,name,storage_root) values (%s,%s,%s,%s,%s)",
                (project_id, world.org, 90000 + index, root.split("/")[-1], "index-path:" + root),
            )
        seed_records(worker, world.org)
        actual_project_ids = sorted(str(row["id"]) for row in worker.execute(
            "select id from pulse.project where org_id=%s and storage_root like 'index-path:%%'", (world.org,)).fetchall())
        actual_client_ids = sorted(str(row["id"]) for row in worker.execute(
            "select id from pulse.client where org_id=%s and source=%s", (world.org, CLIENT_SOURCE)).fetchall())
        worker.execute(
            "insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
            "values (%s,'folder_rules','northwind-layout',1,%s,true)",
            (world.org, Jsonb({"schema_version": 1, "project_paths": northwind_rules})),
        )
        worker.execute(
            "insert into pulse.project(id,org_id,registry_no,name,storage_root) values (%s,%s,%s,%s,%s)",
            (northwind_project_id, world.org, 90003, "Quarterly Launch", "index-path:" + northwind_root),
        )
        seed_records(worker, world.org)
        northwind_project = worker.execute("select id from pulse.project where id=%s", (northwind_project_id,)).fetchone()
        northwind_client = worker.execute("select id,display_name from pulse.client where id=%s",
                                          (northwind_client_id,)).fetchone()

    assert actual_project_ids == sorted(str(project_id) for project_id in project_ids)
    assert actual_client_ids == client_ids_before
    assert northwind_project == {"id": northwind_project_id}
    assert northwind_client == {"id": northwind_client_id, "display_name": "Northwind"}


def test_northwind_sort_acceptance_auto_accept_and_dismissal(worker, owner, api):
    world = build_world(worker, owner, api, notice=False)
    fixture_path = Path(__file__).resolve().parents[2] / "services/workers/tests/fixtures/onboard_northwind.json"
    fixture = json.loads(fixture_path.read_text())
    admin_id = uuid.uuid4()
    client_key = "drive-path-client:northwind homes"
    existing_client = entity_id(world.org, "client", CLIENT_SOURCE, client_key)
    existing_project = entity_id(world.org, "project", "index_path", "Northwind Homes/Maple Rise")
    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Admin','staff')",
                       (admin_id, world.org))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin',current_date)",
                       (world.org, admin_id))
        worker.execute("insert into pulse.client(id,org_id,display_name,type_basis,source) values(%s,%s,'Northwind Homes','source',%s)",
                       (existing_client, world.org, CLIENT_SOURCE))
        worker.execute("insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,method) values(%s,'client',%s,%s,%s,'evidence')",
                       (world.org, existing_client, CLIENT_SOURCE, client_key))
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,title,client_id,storage_root) values(%s,%s,90001,'Maple Rise','Maple Rise',%s,'index-path:Northwind Homes/Maple Rise')",
                       (existing_project, world.org, existing_client))
        worker.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'folder_rules','northwind-layout',1,%s,true)",
                       (world.org, Jsonb({"schema_version": 1, "project_paths": fixture["project_paths"]})))
        for index, row in enumerate(fixture["files"], 1):
            worker.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,account_basis,observed_at,event_seq)
                              values(%s,%s,%s,%s,%s,'synthetic',now(),%s)""",
                           (world.org, row["file_id"], row["path"].split("/")[-1], row.get("mime", "video/mp4"),
                            row["path"], index))
    with worker.transaction():
        set_tenant(worker, world.org)
        preview = sort_org(worker, world.org, dry_run=True)
        assert (preview["folders"], preview["proposals"], preview["matched_existing"], preview["pending"]) == (3, 2, 1, 2)
        assert worker.execute("select count(*) n from pulse.review_item where kind='onboard_project_new'").fetchone()["n"] == 0
        first = sort_org(worker, world.org)
        second = sort_org(worker, world.org)
    assert (first["folders"], first["proposals"], first["matched_existing"], first["created"]) == (3, 2, 1, 2)
    assert second["created"] == 0 and second["pending"] == 2

    with api.transaction():
        set_tenant(api, world.org, admin_id)
        item = api.execute("select id,proposed,evidence from pulse.review_item where kind='onboard_project_new' and proposed->>'projectName'='Cedar Point'").fetchone()
        proposal = item["proposed"]
        project_id = api.execute("select pulse.company_create_drive_project(%s,%s,%s,%s,%s,%s,%s) id",
                                 (proposal["projectId"], item["evidence"]["folderPath"], proposal["storageRoot"],
                                  proposal["projectName"], proposal["clientKey"], proposal["clientId"],
                                  proposal["clientName"])).fetchone()["id"]
        api.execute("update pulse.review_item set entity_type='project',entity_id=%s,status='accepted',decided_by=%s,decided_at=now() where id=%s",
                    (project_id, admin_id, item["id"]))
        expected_cedar_id = entity_id(world.org, "project", "index_path", "Northwind Homes/Cedar Point")
        assert project_id == expected_cedar_id
        cedar = api.execute("select id,name,storage_root,kind from pulse.project where id=%s", (project_id,)).fetchone()
        assert cedar["name"] == "Cedar Point" and cedar["storage_root"] == "index-path:Northwind Homes/Cedar Point"
        lakeview = api.execute("select id from pulse.review_item where kind='onboard_project_new' and proposed->>'clientName'='Lakeview Group'").fetchone()
        api.execute("update pulse.review_item set status='dismissed',decided_by=%s,decided_at=now() where id=%s",
                    (admin_id, lakeview["id"]))
        api.execute("insert into pulse.review_rule(org_id,kind,threshold,enabled,created_by) values(%s,'onboard_project_new',.95,true,%s)",
                    (world.org, admin_id))
        api.execute("""insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence)
                        values(%s,'northwind:auto-accept','onboard_project_new','New project from Drive · Greenway',
                               %s,.95,%s)""",
                    (world.org, Jsonb({
                        "projectId": str(entity_id(world.org, "project", "index_path", "Orbit/Greenway")),
                        "storageRoot": "index-path:Orbit/Greenway",
                        "clientKey": "drive-path-client:orbit",
                        "clientId": str(entity_id(world.org, "client", CLIENT_SOURCE, "drive-path-client:orbit")),
                        "projectName": "Greenway", "clientName": "Orbit",
                    }), Jsonb({"ruleId": "northwind@1", "folderPath": "Orbit/Greenway", "sampleFileIds": ["nw-auto-1"]})))
        api.execute("""insert into pulse.review_item(org_id,source_key,kind,title,proposed,confidence,evidence)
                        values(%s,'northwind:bad-auto-accept','onboard_project_new','Bad proposal',%s,.96,%s)""",
                    (world.org, Jsonb({"projectId": "invalid", "storageRoot": "index-path:Orbit/Bad",
                                       "projectName": "Bad", "clientKey": None, "clientId": None,
                                       "clientName": None}),
                     Jsonb({"ruleId": "northwind@1", "folderPath": "Orbit/Bad", "sampleFileIds": []})))
        assert api.execute("select pulse.review_apply_rules() n").fetchone()["n"] == 1
        assert api.execute("select count(*) n from pulse.project where name in ('Cedar Point','Greenway')").fetchone()["n"] == 2
        assert api.execute("select count(*) n from pulse.client where display_name in ('Northwind Homes','Orbit')").fetchone()["n"] == 2
        assert api.execute("select status from pulse.review_item where id=%s", (lakeview["id"],)).fetchone()["status"] == "dismissed"
        assert api.execute("select status from pulse.review_item where source_key='northwind:bad-auto-accept'").fetchone()["status"] == "pending"
    with worker.transaction():
        set_tenant(worker, world.org)
        seeded = seed_records(worker, world.org)
        assert seeded["client_projects"] >= 2
        cedar_after_seed = worker.execute("select id,name,storage_root,kind,client_id from pulse.project where id=%s",
                                          (expected_cedar_id,)).fetchone()
        assert cedar_after_seed["name"] == "Cedar Point"
        assert cedar_after_seed["storage_root"] == "index-path:Northwind Homes/Cedar Point"
        assert cedar_after_seed["kind"] == "client_work"
        assert cedar_after_seed["client_id"] == existing_client
        assert worker.execute("select count(*) n from pulse.project where storage_root='index-path:Northwind Homes/Cedar Point'").fetchone()["n"] == 1
        assert worker.execute("select count(*) n from pulse.client where display_name='Northwind Homes'").fetchone()["n"] == 1
    event_time = datetime.now(UTC)
    cedar_file = {"id": "nw-file-003", "name": "launch.pdf", "mime": "application/pdf", "parents": [],
                  "path": "Northwind Homes/Cedar Point/Briefs/launch.pdf", "created": event_time,
                  "modified": event_time}
    assert store(worker, drive_event(cedar_file, world.org, event_time)).status == "accepted"
    ProjectionRunner(worker, Deliveries()).catch_up(world.org)
    with worker.transaction():
        set_tenant(worker, world.org)
        linked = worker.execute("select project_id from pulse.index_file where file_id='nw-file-003'").fetchone()
        assert linked["project_id"] == expected_cedar_id
    with worker.transaction():
        set_tenant(worker, world.org)
        worker.execute("""insert into pulse.index_file(org_id,file_id,name,mime,path,account_basis,observed_at,event_seq)
                          values(%s,'nw-auto-2','final.mp4','video/mp4','Orbit/Emerald Grove/Exports/final.mp4','synthetic',now(),20)""",
                       (world.org,))
        auto = sort_org(worker, world.org)
        assert auto["auto_accepted"] == 1 and auto["pending"] == 0
        assert worker.execute("select count(*) n from pulse.project where name='Emerald Grove'").fetchone()["n"] == 1
        final = sort_org(worker, world.org)
        baseline = worker.execute("select name,title from pulse.project where id=%s", (world.project,)).fetchone()
        items = worker.execute("select count(*) n from pulse.review_item where kind='onboard_project_new'").fetchone()["n"]
    assert final["created"] == 0 and final["dismissed"] == 1
    assert baseline == {"name": "Pilot project", "title": None}
    assert items == 5
