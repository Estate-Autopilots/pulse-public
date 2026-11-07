"""Idempotent Ops Hub JSON backup importer. Never emits source data, only counts and format errors.

python -m pulse_workers.opshub_seed --file ~/ea-research/data/opshub/backup.json --org UUID [--dry-run]
Accepts root arrays or a {data:{...}} wrapper: clients, projects, team/people, tasks, phases.
"""

# ruff: noqa: E501
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from pulse_sdk.db import connect, tenant_tx
from pulse_sdk.ids import entity_id


def load(c, org, path):
    raw = path.read_bytes()
    if len(raw) > 20_000_000:
        raise ValueError("backup too large")
    doc = json.loads(raw)
    data = doc.get("data", doc) if isinstance(doc, dict) else None
    if not isinstance(data, dict) or not any(
        k in data for k in ("clients", "projects", "team", "people", "tasks", "phases")
    ):
        raise ValueError("expected clients, projects, team, tasks or phases arrays")
    batch = c.execute(
        "insert into pulse.import_batch(org_id,dataset,sha256,row_count) values(%s,'opshub',%s,%s) on conflict(org_id,dataset,sha256) do update set row_count=excluded.row_count returning id",
        (org, hashlib.sha256(raw).hexdigest(), sum(len(v) for v in data.values() if isinstance(v, list))),
    ).fetchone()["id"]
    counts = {}
    keys = {}
    for kind, array in [
        ("client", "clients"),
        ("person", "team" if "team" in data else "people"),
        ("project", "projects"),
        ("task", "tasks"),
        ("phase", "phases"),
    ]:
        rows = data.get(array, [])
        if not isinstance(rows, list):
            raise ValueError("all entity collections must be arrays")
        count = 0
        for r in rows:
            if not isinstance(r, dict) or not r.get("id", r.get("_id")):
                raise ValueError("every row requires a stable id")
            key = str(r.get("id", r.get("_id")))
            name = str(r.get("name", r.get("title", r.get("displayName", "")))).strip()[:300]
            if not name and kind != "phase":
                raise ValueError("records require name or title")
            link = (
                c.execute(
                    "select entity_id from pulse.identity_link where source='opshub' and entity_type=%s and source_key=%s",
                    (kind, key),
                ).fetchone()
                if kind in ("client", "person", "project")
                else None
            )
            pid = link["entity_id"] if link else entity_id(org, kind, "opshub", key)
            keys[(kind, key)] = pid

            def ref(typ, val):
                if isinstance(val, dict):
                    val = val.get("id", val.get("_id"))
                if val is None:
                    return None
                matched = keys.get((typ, str(val)))
                if matched:
                    return matched
                row = c.execute(
                    "select entity_id from pulse.identity_link where source='opshub' and entity_type=%s and source_key=%s",
                    (typ, str(val)),
                ).fetchone()
                return row["entity_id"] if row else None

            if kind == "client":
                # A same-name existing client is reused only on a unique exact match.
                matches = (
                    c.execute("select id from pulse.client where lower(display_name)=lower(%s)", (name,)).fetchall()
                    if not link
                    else []
                )
                if len(matches) == 1:
                    pid = matches[0]["id"]
                typ = str(r.get("type", "other"))
                if typ not in ("developer", "channel_partner", "other"):
                    typ = "other"
                c.execute(
                    "insert into pulse.client(id,org_id,display_name,client_type,source,type_basis) values(%s,%s,%s,%s,'opshub','source') on conflict(id) do update set display_name=case when 'display_name'=any(client.locked) then client.display_name else excluded.display_name end",
                    (pid, org, name, typ),
                )
            elif kind == "person":
                matches = (
                    c.execute(
                        "select id from pulse.person where lower(display_name)=lower(%s) and side='staff'", (name,)
                    ).fetchall()
                    if not link
                    else []
                )
                if len(matches) == 1:
                    pid = matches[0]["id"]
                c.execute(
                    "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff') on conflict(id) do nothing",
                    (pid, org, name),
                )
                c.execute(
                    "insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,%s,'Ops Hub backup') on conflict(person_id) do update set role=case when 'role'=any(people_profile.locked) then people_profile.role else excluded.role end",
                    (org, pid, str(r.get("role", "Unconfirmed"))[:80]),
                )
            elif kind == "project":
                c.execute("select pg_advisory_xact_lock(hashtext(%s))", ("project-register:" + str(org),))
                registry = c.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
                client = ref("client", r.get("clientId", r.get("client_id")))
                c.execute(
                    "insert into pulse.project(id,org_id,registry_no,name,title,client_id) values(%s,%s,%s,%s,%s,%s) on conflict(id) do update set title=case when 'title'=any(project.locked) then project.title else excluded.title end,client_id=case when 'client_id'=any(project.locked) then project.client_id else excluded.client_id end",
                    (pid, org, registry, name, name, client),
                )
            elif kind == "task":
                project = ref("project", r.get("projectId", r.get("project_id")))
                owner = ref("person", r.get("assigneeId", r.get("ownerId", r.get("person_id"))))
                status = str(r.get("status", "unknown")).lower()
                if status not in ("unknown", "open", "in_progress", "blocked", "in_review", "done", "cancelled"):
                    status = "unknown"
                c.execute(
                    "insert into pulse.task(id,org_id,title,project_id,owner_id,assignee_person_id,status,source,source_key) values(%s,%s,%s,%s,%s,%s,%s,'ops_tool',%s) on conflict(id) do update set title=case when 'title'=any(task.locked) then task.title else excluded.title end,status=case when 'status'=any(task.locked) then task.status else excluded.status end,project_id=case when 'project_id'=any(task.locked) then task.project_id else excluded.project_id end,owner_id=case when 'owner_id'=any(task.locked) then task.owner_id else excluded.owner_id end,assignee_person_id=case when 'owner_id'=any(task.locked) then task.assignee_person_id else excluded.assignee_person_id end",
                    (pid, org, name, project, owner, owner, status, "opshub:" + key),
                )
            else:
                project = ref("project", r.get("projectId", r.get("project_id")))
                if not project:
                    raise ValueError("phase project reference not found")
                status = str(r.get("status", "not_started"))
                if status not in ("not_started", "in_progress", "blocked", "done", "skipped"):
                    status = "not_started"
                c.execute(
                    "insert into pulse.phase(id,org_id,project_id,phase_key,status) values(%s,%s,%s,%s,%s) on conflict(project_id,phase_key) do update set status=excluded.status",
                    (pid, org, project, str(r.get("key", key)), status),
                )
            keys[(kind, key)] = pid
            if kind in ("client", "person", "project"):
                c.execute(
                    "insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,method) values(%s,%s,%s,'opshub',%s,%s,'exact') on conflict do nothing",
                    (org, kind, pid, key, name),
                )
            # Whitelist provenance fields; HR salaries/IDs and finance from an arbitrary backup are never public.
            provenance = {"source_id": key, "name": name, "collection": array}
            c.execute(
                "insert into pulse.source_observation(org_id,dataset,source_key,payload,import_id) values(%s,%s,%s,%s,%s) on conflict(org_id,dataset,source_key) do update set payload=excluded.payload,import_id=excluded.import_id",
                (org, "opshub_" + array, key, Jsonb(provenance), batch),
            )
            count += 1
        counts[array] = count
    from pulse_gdrive_snapshot.records import assign_staff_ids

    assign_staff_ids(c, org)
    return {"counts": counts, "ok": True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--file", type=Path, required=True)
    p.add_argument("--org", type=uuid.UUID, required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    try:
        with connect("worker") as c, tenant_tx(c, a.org):
            result = load(c, a.org, a.file)
            if a.dry_run:
                c.rollback()
            print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"error": "Backup not imported: " + type(exc).__name__}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
