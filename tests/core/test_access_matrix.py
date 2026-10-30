"""Every registered HTTP route is exercised with real password sessions for six roles, plus page routes in browser."""

import json
import os
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from pulse_workers.workspace_directory import apply


def _design_fixture_time(now: datetime) -> datetime:
    """Keep synthetic designer deliveries inside the current IST week."""
    ist = ZoneInfo("Asia/Kolkata")
    local_now = now.astimezone(ist)
    week_start = local_now.replace(
        hour=0, minute=0, second=0, microsecond=0
    ) - timedelta(days=local_now.weekday())
    return max(
        now - timedelta(minutes=1),
        (week_start + timedelta(minutes=1)).astimezone(timezone.utc),
    )


def test_design_fixture_time_stays_in_current_ist_week_at_sunday_boundary():
    sunday_boundary = datetime(2026, 10, 11, 18, 45, tzinfo=timezone.utc)

    fixture_time = _design_fixture_time(sunday_boundary)

    assert fixture_time == datetime(2026, 10, 11, 18, 44, tzinfo=timezone.utc)
    assert fixture_time.astimezone(ZoneInfo("Asia/Kolkata")).isoweekday() == 1


def test_role_matrix_every_api_and_pages(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    design_fixture_time = _design_fixture_time(datetime.now(timezone.utc))
    roles = {
        role: uuid.uuid4()
        for role in ["person", "manager", "pgs", "hr", "leadership", "admin"]
    }
    other = uuid.uuid4()
    design_project = uuid.uuid4()
    outside_project = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute(
                "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')",
                (pid, w.org, "Synthetic " + role),
            )
            worker.execute(
                "insert into pulse.people_profile(org_id,person_id,role,pod,username,department,evidence,user_no) values(%s,%s,%s,'Pod 1',%s,'Creative','{}',%s)",
                (w.org, pid, "Graphic Designer" if role in {"person", "manager"} else role,
                 "synthetic." + role, list(roles).index(role) + 100),
            )
            if role != "person":
                worker.execute(
                    "insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,valid_from) values(%s,%s,%s,%s,'2020-01-01')",
                    (w.org, pid, role, w.pod if role in ["manager", "pgs"] else None),
                )
        for pid, name, pod in [
            (w.editor, "Editor One", "Pod 1"),
            (w.editor2, "Editor Two", "Pod 2"),
            (other, "Other Pod", "Pod 2"),
        ]:
            worker.execute(
                "insert into pulse.people_profile(org_id,person_id,role,pod,username,evidence) values(%s,%s,'Editor',%s,%s,'{}') on conflict do nothing",
                (w.org, pid, pod, name.lower().replace(" ", ".")),
            ) if pid != other else None
        worker.execute(
            "update pulse.project set unit_id=%s where id=%s", (w.pod, w.project)
        )
        worker.execute("update pulse.people_profile set manager_id=%s where person_id=%s",
                       (roles["manager"], roles["person"]))
        worker.execute(
            "insert into pulse.project(id,org_id,registry_no,name,lead_person_id,storage_root) values(%s,%s,%s,'Synthetic outside project',%s,'synthetic:outside')",
            (outside_project, w.org, w.registry_no + 1, roles["person"]),
        )
        worker.execute(
            "insert into pulse.project(id,org_id,registry_no,name,unit_id,lead_person_id,storage_root) values(%s,%s,%s,'Synthetic design project',%s,%s,'synthetic:design')",
            (design_project, w.org, w.registry_no + 2, w.pod, roles["person"]),
        )
        for pid in (roles["manager"], roles["person"], w.editor2):
            handle = f"designer-{str(pid)[:8]}@{w.domain}"
            worker.execute(
                "insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account') on conflict do nothing",
                (w.org, handle, pid),
            )
            project_ids = [design_project, outside_project] if pid in {roles["manager"], roles["person"]} else [design_project]
            for project_id in project_ids:
                file_id = "matrix-design-" + str(pid) + "-" + str(project_id)
                worker.execute(
                    "insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,uploader_account,account_basis,created_at,modified_at,observed_at,event_seq) values(%s,%s,%s,'image/png','Design/Logos/Synthetic.png',%s,%s,'last modifying account',%s,%s,now(),1)",
                    (
                        w.org,
                        file_id,
                        f"Synthetic logo {str(pid)[:8]}.png",
                        project_id,
                        handle,
                        design_fixture_time,
                        design_fixture_time,
                    ),
                )
                worker.execute(
                    "insert into pulse.delivery(org_id,file_id,project_id,uploader_account,kind,delivered_at,rule,rule_detail,event_seq) values(%s,%s,%s,%s,'final',%s,'synthetic','Synthetic design delivery',1)",
                    (w.org, file_id, project_id, handle, design_fixture_time),
                )
        worker.execute(
            "insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'targets','designers',1,%s,true)",
            (w.org, Jsonb({"designers": {"roles": ["Graphic Designer"], "single_image": {"per_day": 2, "placeholder": True}}})),
        )
        worker.execute(
            "insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) values(%s,'folder_rules','design-test',1,%s,true)",
            (w.org, Jsonb({"design_type_rules": {"folder_path": [{"match": "logos", "type": "logo"}]}})),
        )
        client = uuid.uuid4()
        worker.execute(
            "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic client')",
            (client, w.org),
        )
        worker.execute(
            "update pulse.project set client_id=%s where id=%s", (client, w.project)
        )
        for pid, file in [(roles["person"], "matrix-own"), (w.editor2, "matrix-other")]:
            worker.execute(
                "insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,account_basis,observed_at,event_seq) values(%s,%s,%s,'text/plain','/Synthetic',%s,'synthetic',now(),1)",
                (w.org, file, file, w.project),
            )
            worker.execute(
                "insert into pulse.delivery(org_id,file_id,project_id,kind,delivered_at,rule,rule_detail,event_seq) values(%s,%s,%s,'final',now(),'synthetic','synthetic',1)",
                (w.org, file, w.project),
            )
            worker.execute(
                "insert into pulse.activity_observation(org_id,source_key,file_id,actor_id,actor_account,operation,human_attribution,at) values(%s,%s,%s,%s,'synthetic@example.test','upload','synthetic',now())",
                (w.org, file, file, pid),
            )
    apply(
        worker,
        w.org,
        {
            "groups": [
                {
                    "address": "team@estateautopilots.com",
                    "name": "Team",
                    "aliases": [],
                    "members": [],
                }
            ],
            "aliases": [],
        },
    )
    with api.transaction():
        set_tenant(api, w.org, roles["admin"])
        for pid in list(roles.values()) + [w.editor, w.editor2]:
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {
        **os.environ,
        "TEST_API_CONFIG": json.dumps(config),
        "PULSE_ORG_ID": str(w.org),
        "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}),
        "TEST_PERSON": str(w.editor),
        "TEST_OTHER": str(w.editor2),
        "TEST_PROJECT": str(w.project),
        "TEST_DESIGN_PROJECT": str(design_project),
        "TEST_DESIGN_OUTSIDE_PROJECT": str(outside_project),
        "TEST_CLIENT": str(client),
        "TEST_REPORT": str(tmp_path / "matrix.json"),
        "PULSE_GMAIL_SEND_ENABLED": "0",
        "PULSE_DRIVE_UPLOAD_ENABLED": "0",
    }
    root = Path(__file__).resolve().parents[2]
    proc = subprocess.run(
        ["node", "test/access-matrix-runner.mjs"],
        cwd=root / "services/api",
        env=env,
        capture_output=True,
        text=True,
        # pages took 391-794 s; 900 s ran out under load (18 Oct). PULSE_MATRIX_TIMEOUT: the shared dev server runs the
        # API-only matrix in ~7 min (land-gate.sh, 28 Oct), the hosted runners in under one.
        timeout=int(os.environ.get("PULSE_MATRIX_TIMEOUT") or (1500 if os.environ.get("PULSE_PAGE_MATRIX") == "1" else 360)),
        check=False,
    )
    assert proc.returncode == 0, proc.stderr[-14000:] + "\n" + proc.stdout[-14000:]
    result = json.loads((tmp_path / "matrix.json").read_text())
    assert result["apiRoutes"] >= 90
    # Persistent receipt contains counts only; identities and cookies stay in the disposable fixture.
    if os.environ.get("PULSE_MATRIX_RECEIPT"):
        Path(os.environ["PULSE_MATRIX_RECEIPT"]).write_text(
            json.dumps({k: v for k, v in result.items() if k != "tokens"}, indent=2)
        )
