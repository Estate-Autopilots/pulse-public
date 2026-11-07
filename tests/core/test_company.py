"""Round 5B safety: synthetic source observations, column permissions, audited reads, replay and merge undo."""

import csv
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from pulse_sdk.ids import entity_id
from pulse_workers.company_seed import load
from pulse_workers.opshub_seed import load as load_ops
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph


def configure(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')",
            (w.org, w.manager),
        )
        for pid, name in [(w.manager, "Pod Manager"), (w.editor, "Editor One")]:
            worker.execute(
                "insert into pulse.people_profile(org_id,person_id,role,accounts,evidence) values(%s,%s,'Editor',%s,'{}') on conflict do nothing",
                (
                    w.org,
                    pid,
                    [w.editor_handle]
                    if pid == w.editor
                    else ["admin@estateautopilots.com"],
                ),
            )
        worker.execute(
            "insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google','admin@estateautopilots.com',%s,'Workspace account')",
            (w.org, w.manager),
        )
        worker.execute(
            "update pulse.account set purpose='Workspace account' where handle=%s",
            (w.editor_handle,),
        )
        worker.execute(
            "update pulse.people_profile set username='editor.one' where person_id=%s",
            (w.editor,),
        )
        worker.execute(
            "update pulse.project set project_key='synthetic development' where id=%s",
            (w.project,),
        )
        for perm in ("money.read", "money.amount.read", "money.plan.write"):
            worker.execute(
                "insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s)",
                (w.org, w.manager, perm),
            )


def test_money_columns_read_audit_and_tenant_boundary(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "insert into pulse_priv.money_observation(org_id,dataset,source_key,payload,evidence) values(%s,'money_sheet_transactions','synthetic',%s,%s)",
            (
                w.org,
                Jsonb(
                    {
                        "amount": "123.45",
                        "note": "Synthetic amount note",
                        "future_cost_column": "456.78",
                        "vendor": "SYNTHETIC_CONFIDENTIAL",
                        "currency": "INR",
                        "direction": "inflow",
                        "project_key": "synthetic development",
                    }
                ),
                Jsonb({"note": "Synthetic private evidence"}),
            ),
        )
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select * from pulse_priv.money_observation")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.money_read('money_sheet_transactions')")
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        before = api.execute("select count(*) n from pulse.audit_event").fetchone()["n"]
        full = api.execute(
            "select pulse.money_read('money_sheet_transactions') data"
        ).fetchone()["data"]
        assert full["rows"][0]["data"]["amount"] == "123.45"
        api.execute(
            "update pulse.money_permission set revoked_at=now() where person_id=%s and permission='money.amount.read'",
            (w.manager,),
        )
        redacted = api.execute(
            "select pulse.money_read('money_sheet_transactions') data"
        ).fetchone()["data"]
        assert "amount" not in redacted["rows"][0]["data"]
        assert "note" not in redacted["rows"][0]["data"]
        assert "future_cost_column" not in redacted["rows"][0]["data"]
        assert "Synthetic private evidence" not in json.dumps(redacted)
        journal = api.execute("select * from pulse.audit_event").fetchall()
        assert len(journal) > before
        assert "123.45" not in json.dumps(
            journal, default=str
        ) and "SYNTHETIC_CONFIDENTIAL" not in json.dumps(journal, default=str)
        api.execute(
            "update pulse.money_permission set revoked_at=null where person_id=%s and permission='money.amount.read'",
            (w.manager,),
        )
        api.execute(
            "select pulse.money_approve('money_sheet_transactions','synthetic',true)"
        )
        assert api.execute("select pulse.money_summary() data").fetchone()["data"][
            "totals"
        ]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "update pulse_priv.money_observation set payload=jsonb_set(payload,'{amount}','\"999\"') where source_key='synthetic'"
        )
        assert not worker.execute(
            "select approved from pulse_priv.money_observation where source_key='synthetic'"
        ).fetchone()["approved"]
    other = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, other.org)
        assert (
            worker.execute(
                "select count(*) n from pulse_priv.money_observation"
            ).fetchone()["n"]
            == 0
        )


def test_task_import_replay_manual_locks_and_source_provenance(
    worker, owner, api, tmp_path
):
    w = build_world(worker, owner, api)
    configure(worker, w)
    fields = [
        "id",
        "task",
        "status",
        "owner",
        "owner_role",
        "due_date",
        "project_key",
        "source_period",
        "confidence",
    ]
    rows = [
        dict(
            zip(
                fields,
                [
                    "task-1",
                    "Synthetic tracker task",
                    "pending",
                    "Editor One",
                    "",
                    "11 Oct",
                    "synthetic development",
                    "October 2026",
                    "0.9",
                ],
            )
        )
    ]
    with (tmp_path / "tasks.csv").open("w") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    (tmp_path / "tasks.evidence.json").write_text(
        json.dumps(
            {
                "generated_at": "synthetic",
                "rows": {"task-1": {"source": "synthetic-sheet", "row": 2}},
            }
        )
    )
    with worker.transaction():
        set_tenant(worker, w.org)
        assert load(worker, w.org, tmp_path)["tasks"] == 1
        row = worker.execute(
            "select * from pulse.task where source_key=%s", ("task-1",)
        ).fetchone()
        assert row["owner_id"] == w.editor and row["evidence"]["row"] == 2
        task = row["id"]
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute(
            "update pulse.task set title='Manual correction',due_label='Manual deadline',locked='{title,due_label}',edited_by=%s where id=%s",
            (w.manager, task),
        )
    with worker.transaction():
        set_tenant(worker, w.org)
        load(worker, w.org, tmp_path)
        assert (
            worker.execute(
                "select title from pulse.task where id=%s", (task,)
            ).fetchone()["title"]
            == "Manual correction"
        )
        assert (
            worker.execute(
                "select due_label from pulse.task where id=%s", (task,)
            ).fetchone()["due_label"]
            == "Manual deadline"
        )
        assert (
            worker.execute(
                "select count(*) n from pulse.import_batch where dataset='tasks'"
            ).fetchone()["n"]
            == 1
        )
    ProjectionRunner(worker, WorkGraph()).rebuild(w.org)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert (
            worker.execute(
                "select title from pulse.task where id=%s", (task,)
            ).fetchone()["title"]
            == "Manual correction"
        )


def test_merge_undo_keeps_identity_and_rejects_overwriting_later_edits(
    worker, owner, api
):
    w = build_world(worker, owner, api)
    configure(worker, w)
    keep, gone = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for key, name in [(keep, "Synthetic keep"), (gone, "Synthetic duplicate")]:
            worker.execute(
                "insert into pulse.client(id,org_id,display_name,entity_kind) values(%s,%s,%s,'company')",
                (key, w.org, name),
            )
        worker.execute(
            "update pulse.project set client_id=%s where id=%s", (gone, w.project)
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        merge = api.execute(
            "select pulse.merge_records('client',%s,%s) id", (keep, gone)
        ).fetchone()["id"]
        assert (
            api.execute(
                "select client_id from pulse.project where id=%s", (w.project,)
            ).fetchone()["client_id"]
            == keep
        )
        api.execute("select pulse.undo_merge(%s)", (merge,))
        assert (
            api.execute(
                "select client_id from pulse.project where id=%s", (w.project,)
            ).fetchone()["client_id"]
            == gone
        )
        merge = api.execute(
            "select pulse.merge_records('client',%s,%s) id", (keep, gone)
        ).fetchone()["id"]
        api.execute(
            "update pulse.project set title='Changed after merge' where id=%s",
            (w.project,),
        )
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.undo_merge(%s)", (merge,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "update pulse.project set client_id=%s where id=%s", (gone, w.project)
        )
        assert (
            worker.execute(
                "select client_id from pulse.project where id=%s", (w.project,)
            ).fetchone()["client_id"]
            == keep
        )


def test_project_merge_undo_moves_activity_and_private_matches(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    gone = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "insert into pulse.project(id,org_id,registry_no,name,title) values(%s,%s,999,'Synthetic duplicate','Synthetic duplicate')",
            (gone, w.org),
        )
        worker.execute(
            "insert into pulse.activity_observation(org_id,source_key,project_id,actor_id,operation) values(%s,'synthetic-merge-upload',%s,%s,'upload')",
            (w.org, gone, w.editor),
        )
        worker.execute(
            "insert into pulse_priv.money_observation(org_id,dataset,source_key,payload) values(%s,'money_sheet_transactions','synthetic-merge-money','{}')",
            (w.org,),
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute(
            "select pulse.money_link('money_sheet_transactions','synthetic-merge-money',%s)",
            (gone,),
        )
        merge = api.execute(
            "select pulse.merge_records('project',%s,%s) id", (w.project, gone)
        ).fetchone()["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert (
            worker.execute(
                "select project_id from pulse_priv.money_match where source_key='synthetic-merge-money'"
            ).fetchone()["project_id"]
            == w.project
        )
        assert (
            worker.execute(
                "select project_id from pulse.activity_observation where source_key='synthetic-merge-upload'"
            ).fetchone()["project_id"]
            == w.project
        )
        # A replay of the original source identity must still resolve to the survivor.
        worker.execute(
            "update pulse.activity_observation set project_id=%s where source_key='synthetic-merge-upload'",
            (gone,),
        )
        assert (
            worker.execute(
                "select project_id from pulse.activity_observation where source_key='synthetic-merge-upload'"
            ).fetchone()["project_id"]
            == w.project
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.undo_merge(%s)", (merge,))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert (
            worker.execute(
                "select project_id from pulse_priv.money_match where source_key='synthetic-merge-money'"
            ).fetchone()["project_id"]
            == gone
        )
        assert (
            worker.execute(
                "select project_id from pulse.activity_observation where source_key='synthetic-merge-upload'"
            ).fetchone()["project_id"]
            == gone
        )


def test_opshub_backup_import_is_idempotent_and_preserves_edits(
    worker, owner, api, tmp_path
):
    w = build_world(worker, owner, api)
    configure(worker, w)
    backup = {
        "clients": [{"id": "c1", "name": "Synthetic Ops client"}],
        "team": [{"id": "p1", "name": "Synthetic Ops person", "role": "Editor"}],
        "projects": [{"id": "j1", "name": "Synthetic Ops project", "clientId": "c1"}],
        "tasks": [
            {
                "id": "t1",
                "title": "Synthetic Ops task",
                "projectId": "j1",
                "ownerId": "p1",
            }
        ],
        "phases": [{"id": "ph1", "projectId": "j1", "key": "production"}],
    }
    path = tmp_path / "backup.json"
    path.write_text(json.dumps(backup))
    with worker.transaction():
        set_tenant(worker, w.org)
        result = load_ops(worker, w.org, path)
        assert result["counts"]["tasks"] == 1
        load_ops(worker, w.org, path)
        assert (
            worker.execute(
                "select count(*) n from pulse.task where source='ops_tool'"
            ).fetchone()["n"]
            == 1
        )
        assert worker.execute("select count(*) n from pulse.phase").fetchone()["n"] == 1


def test_http_company_permissions_auth_audit_and_gates(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    review_id = uuid.uuid4()
    onboard_review_id = uuid.uuid4()
    fill_pod_review_id = uuid.uuid4()
    configured_pod_review_id = uuid.uuid4()
    fill_type_review_id = uuid.uuid4()
    seed_pod_review_id = uuid.uuid4()
    bad_client_review_id = uuid.uuid4()
    drive_root = "Synthetic Client/Accepted Folder"
    drive_client_key = "drive-path-client:synthetic client"
    drive_project_id = entity_id(w.org, "project", "index_path", drive_root)
    drive_client_id = entity_id(w.org, "client", "drive_folder_name", drive_client_key)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "insert into pulse.review_item(id,org_id,source_key,kind,entity_type,entity_id,title,proposed) values(%s,%s,'synthetic-manager','manager','person',%s,'Synthetic manager',%s)",
            (review_id, w.org, w.editor, Jsonb({"managerId": str(w.manager)})),
        )
        worker.execute(
            """insert into pulse.review_item(id,org_id,source_key,kind,title,proposed,evidence)
               values(%s,%s,'synthetic-drive-root','onboard_project_new','New project from Drive · Accepted Folder',%s,%s)""",
            (onboard_review_id, w.org, Jsonb({
                "projectId": str(drive_project_id), "storageRoot": "index-path:" + drive_root,
                "clientKey": drive_client_key, "clientId": str(drive_client_id),
                "projectName": "Accepted Folder", "clientName": "Synthetic Client",
            }), Jsonb({"ruleId": "synthetic@1", "folderPath": drive_root, "sampleFileIds": ["synthetic-drive-file"]})),
        )
        worker.execute(
            """insert into pulse.review_item(id,org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
               values(%s,%s,'onboard_project_fill:pod:synthetic-project','project_pod','project',%s,
                      'Configured fill pod suggestion',%s,.99,%s)""",
            (fill_pod_review_id, w.org, w.project, Jsonb({"pod": "Pod 1"}),
             Jsonb({"ruleId": "synthetic@1:pods:default", "sampleFileIds": ["synthetic-file-1"]})),
        )
        worker.execute(
            """insert into pulse.review_item(id,org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
               values(%s,%s,'configured-pod-rule:synthetic-project','project_pod','project',%s,
                      'Rule-id fill pod suggestion',%s,.95,%s)""",
            (configured_pod_review_id, w.org, w.project, Jsonb({"pod": "Pod 1"}),
             Jsonb({"ruleId": "synthetic@1:pods:configured", "sampleFileIds": ["synthetic-file-rule"]})),
        )
        worker.execute(
            """insert into pulse.review_item(id,org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
               values(%s,%s,'onboard_project_fill:deliverable_type:synthetic-project','onboard_project_fill','project',%s,
                      'Configured fill type suggestion',%s,.95,%s)""",
            (fill_type_review_id, w.org, w.project, Jsonb({"field": "deliverable_type", "deliverableType": "podcast_clip"}),
             Jsonb({"ruleId": "synthetic@1:creative_types:model_video", "sampleFileIds": ["synthetic-file-2"]})),
        )
        worker.execute(
            """insert into pulse.review_item(id,org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
               values(%s,%s,'onboard_project_fill:client:synthetic-project','onboard_project_fill','project',%s,
                      'Malformed fill client suggestion',%s,.95,%s)""",
            (bad_client_review_id, w.org, w.project,
             Jsonb({"field": "client", "clientKey": "not-a-drive-key", "clientId": str(uuid.uuid4()), "clientName": "Synthetic Client"}),
             Jsonb({"ruleId": "synthetic@1:clients", "sampleFileIds": ["synthetic-file-3"]})),
        )
        worker.execute(
            """insert into pulse.review_item(id,org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
               values(%s,%s,'synthetic-seed-pod','project_pod','project',%s,
                      'Seeded pod suggestion',%s,.99,%s)""",
            (seed_pod_review_id, w.org, w.project, Jsonb({"pod": "Pod 1"}), Jsonb({"source": "seed"})),
        )
    root = Path(__file__).resolve().parents[2]
    script = r"""
import assert from 'node:assert/strict';import {Pool} from 'pg';import {createApp} from './dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)),app=createApp(pool,pool);
const call=async(url,email,payload)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:email?{'cf-access-authenticated-user-email':email}:{},...(payload?{payload}:{})});return {status:r.statusCode,data:r.json()};};
const admin='admin@estateautopilots.com',member=process.env.TEST_MEMBER;
assert.equal((await call('/api/v0/money',member)).status,403);assert.equal((await call('/api/v0/audit',member)).status,403);
assert.equal((await call('/api/v0/review-data',member)).status,403);assert.equal((await call('/api/v0/tasks',null)).status,401);
assert.equal((await call('/api/v0/inbox/send',admin,{to:'test@example.com',subject:'Synthetic',body:'Synthetic'})).status,403);
const upload=await call(`/api/v0/projects/${process.env.TEST_PROJECT}/upload`,admin);assert.equal(upload.status,200);assert.equal(upload.data.enabled,false);
assert.equal((await call('/api/v0/review-data/rules',admin,{kind:'onboard_project_fill',threshold:.95,enabled:true})).status,400,'automatic fill acceptance is disabled until confidence is calibrated');
const task=await call('/api/v0/tasks',admin,{title:'Manual task',ownerId:process.env.TEST_PERSON,dueLabel:'Synthetic deadline'});assert.equal(task.status,200);
assert.equal((await call(`/api/v0/tasks/${task.data.id}`,admin,{title:'Corrected task',status:'done'})).status,200);
const own=await call('/api/v0/tasks',member);assert.equal(own.status,200);assert.ok(own.data.rows.some(t=>t.id===task.data.id&&t.due_label==='Synthetic deadline'));
const link=await call('/api/v0/record-links',admin,{entity:'project',entityId:process.env.TEST_PROJECT,kind:'website',label:'Synthetic site',value:'https://example.com'});assert.equal(link.status,200);
const correction=await call(`/api/v0/stewardship/project/${process.env.TEST_PROJECT}`,member);assert.equal(correction.status,200);assert.equal(correction.data.links.length,1);
assert.equal((await call('/api/v0/record-links',admin,{entity:'project',entityId:process.env.TEST_PROJECT,id:correction.data.links[0].id,label:'Edited label'})).status,200);
assert.equal((await call(`/api/v0/projects/${process.env.TEST_PROJECT}`,admin,{pgsId:process.env.TEST_PERSON})).status,200);
assert.equal((await call(`/api/v0/projects/${process.env.TEST_PROJECT}`,admin)).data.pgsId,process.env.TEST_PERSON);
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_REVIEW],action:'accept'})).status,200);
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_ONBOARD_REVIEW],action:'accept',proposed:{projectId:process.env.TEST_PROJECT,storageRoot:'index-path:Injected/Wrong Root',projectName:'Injected',clientName:'Injected Client'}})).status,200);
const beforeBulk=await call('/api/v0/review-data?kind=project_pod',admin);assert.equal(beforeBulk.data.groups.find(group=>group.kind==='project_pod').high,1,'90%+ count excludes fixed-confidence fill pods');
const bulkPods=await call('/api/v0/review-data/decide',admin,{allHighConfidence:true,action:'accept'});assert.equal(bulkPods.status,200);assert.equal(bulkPods.data.count,1,'90%+ bulk accepts only the seeded pod suggestion');
const pendingPods=await call('/api/v0/review-data?kind=project_pod',admin);assert.ok(pendingPods.data.rows.some(row=>row.id===process.env.TEST_FILL_POD_REVIEW),'fill pod remains pending after 90%+ bulk acceptance');assert.ok(pendingPods.data.rows.some(row=>row.id===process.env.TEST_CONFIGURED_POD_REVIEW),'a project_pod row with evidence.ruleId remains pending after 90%+ bulk acceptance');assert.ok(!pendingPods.data.rows.some(row=>row.id===process.env.TEST_SEED_POD_REVIEW),'seed pod was accepted by 90%+ bulk action');
const pendingFill=await call('/api/v0/review-data?kind=onboard_project_fill',admin);assert.ok(pendingFill.data.rows.some(row=>row.id===process.env.TEST_FILL_TYPE_REVIEW),'fixed-0.95 fill type remains pending after the bulk action');
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_FILL_POD_REVIEW],action:'accept'})).status,400,'bulk selection cannot accept a fill pod');
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_CONFIGURED_POD_REVIEW],action:'accept'})).status,400,'bulk selection cannot accept a project_pod row with evidence.ruleId');
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_FILL_TYPE_REVIEW],action:'accept'})).status,400,'bulk selection cannot accept a fill type');
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_FILL_POD_REVIEW],action:'accept',individual:true})).status,200,'individual accept remains available for a fill pod');
assert.equal((await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_FILL_TYPE_REVIEW],action:'accept',individual:true})).status,200,'individual accept takes a deliverable type outside the EA set');
const badClient=await call('/api/v0/review-data/decide',admin,{ids:[process.env.TEST_BAD_CLIENT_REVIEW],action:'accept',individual:true});assert.equal(badClient.status,400,'a validation error is a 400, not a 409');assert.match(JSON.stringify(badClient.data),/valid Drive client identity/);
assert.equal((await call(`/api/v0/people/${process.env.TEST_PERSON}`,admin)).data.editedBy,(await call('/api/v0/me',admin)).data.name);
const audit=await call('/api/v0/audit?action=update&resource=task',admin);assert.ok(audit.data.rows.length);assert.ok(audit.data.rows[0].actor_id);
const ownAudit=await call('/api/v0/audit?view=reads&action=restricted_read&resource=audit',admin);assert.ok(ownAudit.data.rows.some(r=>r.resource==='/api/v0/audit'&&r.actor_id===process.env.TEST_MANAGER));
for(let i=0;i<20;i++)assert.equal((await call('/api/v0/auth/sign-in',null,{username:'unknown',password:'wrong'})).status,401);
assert.equal((await call('/api/v0/auth/sign-in',null,{username:'unknown',password:'wrong'})).status,429);
const auth=async(url,payload,token)=>{const r=await app.inject({url,method:payload?'POST':'GET',headers:{'x-pulse-client-ip':'synthetic-auth',...(token?{'x-pulse-session':token}:{})},...(payload?{payload}:{})});return {status:r.statusCode,data:r.json()};};
let issued=await call(`/api/v0/people/${process.env.TEST_PERSON}/login`,admin,{action:'copy',confirmed:true});assert.equal(issued.status,200);
const activated=await auth('/api/v0/auth/set-password',{token:new URL(issued.data.link).hash.slice(1),password:'Synthetic-link-2026!'});assert.equal(activated.status,200);assert.equal(activated.data.mustChange,false);
for(let i=0;i<5;i++)assert.equal((await auth('/api/v0/auth/sign-in',{username:'editor.one',password:'bad'})).status,401);
assert.equal((await auth('/api/v0/auth/sign-in',{username:'editor.one',password:'Synthetic-link-2026!'})).status,401);
assert.equal((await call(`/api/v0/people/${process.env.TEST_PERSON}/login`,admin,{action:'unlock'})).status,200);
const one=await auth('/api/v0/auth/sign-in',{username:'editor.one',password:'Synthetic-link-2026!'}),two=await auth('/api/v0/auth/sign-in',{username:'editor.one',password:'Synthetic-link-2026!'});assert.equal(one.status,200);assert.equal(two.status,200);
assert.equal((await auth('/api/v0/auth/change-password',{current:'Synthetic-link-2026!',next:'Synthetic-strong-2026!'},two.data.token)).status,200);
assert.equal((await auth('/api/v0/me',null,one.data.token)).status,401);assert.equal((await auth('/api/v0/tasks',null,two.data.token)).status,200);
assert.equal((await auth('/api/v0/auth/sign-out',{},two.data.token)).status,200);assert.equal((await auth('/api/v0/me',null,two.data.token)).status,401);
assert.equal((await auth('/api/v0/auth/forgot',{username:'editor.one'})).status,200);
await app.close();await pool.end();
"""
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {
        **os.environ,
        "TEST_API_CONFIG": json.dumps(config),
        "PULSE_ORG_ID": str(w.org),
        "TEST_MEMBER": w.editor_handle,
        "TEST_PROJECT": str(w.project),
        "TEST_PERSON": str(w.editor),
        "TEST_MANAGER": str(w.manager),
        "TEST_REVIEW": str(review_id),
        "TEST_ONBOARD_REVIEW": str(onboard_review_id),
        "TEST_FILL_POD_REVIEW": str(fill_pod_review_id),
        "TEST_CONFIGURED_POD_REVIEW": str(configured_pod_review_id),
        "TEST_FILL_TYPE_REVIEW": str(fill_type_review_id),
        "TEST_BAD_CLIENT_REVIEW": str(bad_client_review_id),
        "TEST_SEED_POD_REVIEW": str(seed_pod_review_id),
        "PULSE_GMAIL_SEND_ENABLED": "0",
        "PULSE_DRIVE_UPLOAD_ENABLED": "0",
    }
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=root / "services/api",
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    with worker.transaction():
        set_tenant(worker, w.org)
        project = worker.execute("select id,name,storage_root from pulse.project where id=%s", (drive_project_id,)).fetchone()
        assert project == {"id": drive_project_id, "name": "Accepted Folder", "storage_root": "index-path:Synthetic Client/Accepted Folder"}
        assert worker.execute("select count(*) n from pulse.project where storage_root='index-path:Injected/Wrong Root'").fetchone()["n"] == 0
        assert worker.execute("select count(*) n from pulse.client where id=%s and display_name='Synthetic Client'", (drive_client_id,)).fetchone()["n"] == 1
        link = worker.execute("select entity_id from pulse.identity_link where entity_type='client' and source='drive_folder_name' and source_key=%s and valid_to is null", (drive_client_key,)).fetchone()
        assert link["entity_id"] == drive_client_id
        assert worker.execute("select deliverable_type from pulse.project where id=%s", (w.project,)).fetchone()["deliverable_type"] == "podcast_clip"


def test_file_display_name_and_project_move_survive_source_replay(worker, owner, api):
    w = build_world(worker, owner, api)
    configure(worker, w)
    project = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "insert into pulse.project(id,org_id,registry_no,name) values(%s,%s,2,'Synthetic target')",
            (project, w.org),
        )
        worker.execute(
            """insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,account_basis,observed_at,event_seq)
        values(%s,'synthetic-file','Original','video/mp4','/original/path',%s,'synthetic',now(),1)""",
            (w.org, w.project),
        )
        worker.execute(
            """insert into pulse.delivery(org_id,file_id,project_id,kind,delivered_at,rule,rule_detail,event_seq)
        values(%s,'synthetic-file',%s,'final',now(),'synthetic','Synthetic rule',1)""",
            (w.org, w.project),
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute(
            "select pulse.correct_file('synthetic-file','Correct name',%s,'Wrong project')",
            (project,),
        )
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "update pulse.index_file set display_name=null,name='Source refreshed',project_id=%s where file_id='synthetic-file'",
            (w.project,),
        )
        worker.execute(
            "update pulse.delivery set project_id=%s where file_id='synthetic-file'",
            (w.project,),
        )
        r = worker.execute(
            "select * from pulse.index_file where file_id='synthetic-file'"
        ).fetchone()
        assert (
            r["project_id"] == project
            and r["display_name"] == "Correct name"
            and r["path"] == "/original/path"
        )
        assert (
            worker.execute(
                "select project_id from pulse.delivery where file_id='synthetic-file'"
            ).fetchone()["project_id"]
            == project
        )


def test_personal_decision_notifications_require_verified_private_chat(
    worker, owner, api, monkeypatch
):
    from pulse_workers.notifications import drain

    w = build_world(worker, owner, api)
    configure(worker, w)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.telegram_connect(%s,'123456789')", (w.editor,))
        api.execute(
            """insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind)
          values(%s,%s,'2026-10-06','2026-10-06','annual')""",
            (w.org, w.editor),
        )
        api.execute(
            "update pulse.leave_request set status='approved' where person_id=%s",
            (w.editor,),
        )
    calls = []

    def telegram(method, payload):
        calls.append((method, payload))
        return {"type": "private"} if method == "getChat" else {"message_id": 1}

    monkeypatch.setattr("pulse_workers.notifications.telegram", telegram)
    assert drain(worker, w.org) == {"sent": 2, "failed": 0}
    messages = [payload["text"] for method, payload in calls if method == "sendMessage"]
    assert {message.split("\n")[0] for message in messages} == {"HR request submitted", "HR request approved"}
    assert all("reason" not in message and "2026-10-06" not in message for message in messages)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert (
            api.execute("select count(*) n from pulse.notification").fetchone()["n"]
            == 2
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.telegram_connect(%s,null)", (w.editor,))
        api.execute(
            "update pulse.leave_request set status='rejected',decision_note='Synthetic override reason' where person_id=%s",
            (w.editor,),
        )
    assert drain(worker, w.org) == {"sent": 0, "failed": 0}
