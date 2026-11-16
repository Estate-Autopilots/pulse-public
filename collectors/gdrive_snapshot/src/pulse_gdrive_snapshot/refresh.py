"""Production stopgap: accepted metadata/project import and projections, without roster bootstrap or deletes."""
from __future__ import annotations

import os
from dataclasses import asdict
from datetime import UTC, datetime

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pulse_rules.folder_rules import load as load_folder_rules
from pulse_workers.deliveries import Deliveries
from pulse_workers.projector import ProjectionRunner
from pulse_workers.workgraph import WorkGraph

from pulse_sdk.db import tenant_tx, url_for
from pulse_sdk.ids import entity_id

from .backfill import FOLDER_MIME, SYNC_SOURCE, FolderPaths, is_sensitive_path, run_backfill
from .onboard_proposals import propose as propose_onboarding
from .people_work import refresh_people_work
from .records import seed_records
from .sop_sources import capture_sop_sources
from .team import project_path


def refresh_projects(index, pulse, org):
    """Use the accepted folder rules and ids. Existing records, manual locks and account mappings win."""
    folders = FolderPaths(index.execute(
        "select id,name,parents,path from drive_file where mime=%s and not coalesce(trashed,false)",
        (FOLDER_MIME,),
    ).fetchall())
    with tenant_tx(pulse, org):
        pulse.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))", (f"drive-projects:{org}",))
        rules = load_folder_rules(pulse, org)
        if not rules.project_paths:
            raise RuntimeError("Accepted project-path rules are missing; refusing to reclassify projects")
        paths = set()
        for row in index.execute("select name,path,parents from drive_file where not coalesce(trashed,false)"):
            resolved = folders.record_paths(row)
            if any(is_sensitive_path(path) for path in resolved):
                continue
            root = project_path(resolved[0], rules.project_paths)
            if root:
                paths.add(root)
        next_no = pulse.execute("select coalesce(max(registry_no),0)+1 n from pulse.project").fetchone()["n"]
        made = 0
        for path in sorted(paths):
            pid = entity_id(org, "project", "index_path", path)
            if pulse.execute("select id from pulse.project where id=%s", (pid,)).fetchone():
                continue
            pulse.execute("insert into pulse.project(id,org_id,registry_no,name,storage_root) "
                          "values (%s,%s,%s,%s,%s)", (pid, org, next_no, path.split("/")[-1], "index-path:" + path))
            next_no += 1
            made += 1
        return {"new_projects": made, **seed_records(pulse, org)}


def refresh():
    # This process has no Google credential and cannot write to the upstream index.
    with psycopg.connect(os.environ["EA_INDEX_DATABASE_URL"], autocommit=True, row_factory=dict_row,
                         options="-c default_transaction_read_only=on") as index, \
            psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row) as pulse:
        org = pulse.execute("select pulse.install_org() org").fetchone()["org"]
        if not org:
            raise RuntimeError("Production tenant is not installed")
        pulse.execute("select pg_advisory_lock(hashtextextended(%s,0))", (f"drive-refresh:{org}",))
        with tenant_tx(pulse, org):
            run = pulse.execute("insert into pulse.sync_run(org_id,source,started_at) values(%s,%s,%s) returning id",
                                (org, SYNC_SOURCE, datetime.now(UTC))).fetchone()["id"]
        try:
            pulse.execute("select pulse.maintain_partitions()")
            stats = refresh_projects(index, pulse, org)
            stats.update(asdict(run_backfill(index, pulse, org)))
            stats["workgraph_events"] = ProjectionRunner(pulse, WorkGraph()).catch_up(org)
            stats["delivery_events"] = ProjectionRunner(pulse, Deliveries()).catch_up(org)
            # Who worked on what (PEOPLE-LIVE): its own transaction. A failure leaves the delivery refresh standing and
            # is named in the receipt; the next run tries again.
            try:
                stats["people_work"] = refresh_people_work(index, pulse, org)
            except Exception as exc:
                stats["people_work"] = {"ok": False, "error": type(exc).__name__}
            # PRESENCE-ONBOARD: proposals for missing onboarding details (with their source; people confirm). Same rule.
            try:
                stats["onboard_proposals"] = propose_onboarding(index, pulse, org)
            except Exception as exc:
                stats["onboard_proposals"] = {"ok": False, "error": type(exc).__name__}
            # SOP-WORKFLOW: documents that read like an SOP, for leadership to confirm in Pulse. Same rule.
            try:
                stats["sop_sources"] = capture_sop_sources(index, pulse, org)
            except Exception as exc:
                stats["sop_sources"] = {"ok": False, "error": type(exc).__name__}
            with tenant_tx(pulse, org):
                errors = pulse.execute("select count(*) n from pulse.projection_error where org_id=%s",
                                       (org,)).fetchone()["n"]
                if errors:
                    raise RuntimeError("Projection errors require review")
            upstream = index.execute("select max(finished) at from sync_run "
                                     "where ok and summary::jsonb ? 'drive_files'").fetchone()["at"]
            if not upstream or (datetime.now(UTC) - upstream).total_seconds() > 86400:
                raise RuntimeError("Upstream Drive index is older than 24 hours")
            with tenant_tx(pulse, org):
                pulse.execute("update pulse.sync_run set finished_at=now(),ok=true,upstream_at=%s,stats=%s where id=%s",
                              (upstream, Jsonb(stats), run))
            return {"run_id": str(run), "upstream_at": upstream.isoformat(), "stats": stats}
        except Exception as exc:
            with tenant_tx(pulse, org):
                pulse.execute("update pulse.sync_run set finished_at=now(),ok=false,error=%s where id=%s",
                              (type(exc).__name__, run))
            raise


def main():
    import json
    try:
        print(json.dumps(refresh()), flush=True)
        return 0
    except Exception as exc:
        # Provider and database error messages can contain private source data or credentials.
        print(json.dumps({"ok": False, "error": type(exc).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
