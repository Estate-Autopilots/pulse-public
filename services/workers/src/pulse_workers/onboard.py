"""Drive onboarding proposals. Sorting only creates review items; projects wait for an explicit decision."""

from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from psycopg.types.json import Jsonb
from pulse_rules import classify_creative_type, classify_design_type
from pulse_rules.folder_rules import FolderRulesError, FolderRuleSet, load, project_root, source_norm
from pulse_rules.protected_paths import is_protected

from pulse_sdk.db import active_orgs, connect, tenant_tx
from pulse_sdk.ids import entity_id


@dataclass
class ProjectGroup:
    folder_path: str
    project_name: str
    client_name: str | None
    rule_id: str
    sample_file_ids: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return self.folder_path


def group_indexed_files(
    files: list[Mapping[str, Any]], project_paths: tuple[Mapping[str, Any], ...], rule_set_id: str = "folder_rules",
    protected: tuple[str, ...] = (), excluded: set[str] | None = None,
) -> list[ProjectGroup]:
    """Group files by the seed's real project roots, keeping bounded file identifiers as evidence.

    Roots that hit the protected list (built-ins plus the company's ``protected`` patterns) go into ``excluded``
    instead; a file in a protected subfolder of a kept root is never evidence.
    """
    groups: dict[str, ProjectGroup] = {}
    for row in sorted(files, key=lambda item: str(item.get("file_id", ""))):
        path = str(row.get("path") or "")
        if not path:
            continue
        matched = project_root(path, project_paths)
        if matched is None:
            continue
        if is_protected(matched.root, protected):
            if excluded is not None:
                excluded.add(matched.root)
            continue
        project_name = matched.root.rsplit("/", 1)[-1]
        client_name = matched.captures.get("client")
        if (not project_name or len(project_name) > 160
                or (client_name and (len(client_name) > 120 or "/" in client_name))):
            continue
        group = ProjectGroup(
            folder_path=matched.root,
            project_name=project_name,
            client_name=client_name or None,
            rule_id=f"{rule_set_id}:project_paths:{matched.rule_index}",
        )
        current = groups.setdefault(group.key, group)
        file_id = str(row.get("file_id") or "")
        if (file_id and file_id not in current.sample_file_ids and len(current.sample_file_ids) < 5
                and not is_protected(path.rsplit("/", 1)[0], protected)):
            current.sample_file_ids.append(file_id)

    return sorted(groups.values(), key=lambda group: group.folder_path)


def has_matching_project(group: ProjectGroup, projects: list[Mapping[str, Any]]) -> bool:
    root = "index-path:" + group.folder_path
    if any(project.get("storage_root") == root for project in projects):
        return True
    for project in (item for item in projects if item.get("storage_root") is None):
        project_key = source_norm(group.project_name)
        client_key = source_norm(group.client_name)
        labels = {source_norm(project.get(name)) for name in ("name", "title", "project_key") if project.get(name)}
        if project_key in labels and (not client_key or client_key == source_norm(project.get("client_name"))):
            return True
    return False


def matching_project(
    group: ProjectGroup, projects: list[Mapping[str, Any]], files: list[Mapping[str, Any]] | None = None
) -> Mapping[str, Any] | None:
    """Return one unambiguous project for a configured root; do not guess between same-name work."""
    root = "index-path:" + group.folder_path
    exact = [project for project in projects if project.get("storage_root") == root]
    if len(exact) == 1:
        return exact[0]
    if exact:
        return None
    explicit_ids = {str(row.get("project_id")) for row in (files or []) if row.get("project_id")}
    if len(explicit_ids) == 1:
        return next((project for project in projects if str(project.get("id")) in explicit_ids), None)
    if explicit_ids:
        return None

    project_key = source_norm(group.project_name)
    client_key = source_norm(group.client_name)
    candidates = []
    for project in (item for item in projects if item.get("storage_root") is None):
        labels = {source_norm(project.get(name)) for name in ("name", "title", "project_key") if project.get(name)}
        if project_key not in labels:
            continue
        recorded_client = source_norm(project.get("client_name"))
        if client_key and recorded_client and client_key != recorded_client:
            continue
        candidates.append(project)
    return candidates[0] if len(candidates) == 1 else None


def _pod_candidate(group: ProjectGroup, pods: Mapping[str, Any], rule_set_id: str) -> dict[str, Any] | None:
    segments = {source_norm(part) for part in group.folder_path.split("/")}
    matches = [(str(key), str(value)) for key, value in pods.items()
               if source_norm(str(key)) in segments or source_norm(str(value)) in segments]
    names = {name for _, name in matches}
    if len(names) != 1:
        return None
    key, name = sorted((item for item in matches if item[1] in names), key=lambda item: item[0])[0]
    return {"field": "pod", "value": name, "ruleId": f"{rule_set_id}:pods:{key}"}


def fill_candidates(
    group: ProjectGroup,
    files: list[Mapping[str, Any]],
    project: Mapping[str, Any],
    rules: Mapping[str, Any],
    rule_set_id: str,
) -> list[dict[str, Any]]:
    """Propose only unambiguous missing project fields from configured folder and type rules."""
    locked = set(project.get("locked") or [])
    candidates: list[dict[str, Any]] = []
    if not project.get("client_id") and "client_id" not in locked and group.client_name:
        candidates.append({
            "field": "client", "value": group.client_name,
            "clientKey": "drive-path-client:" + source_norm(group.client_name),
            "ruleId": group.rule_id,
        })

    if not project.get("unit_id") and "unit_id" not in locked:
        pod = _pod_candidate(group, rules.get("pods", {}), rule_set_id)
        if pod:
            candidates.append(pod)

    if not project.get("deliverable_type") and "deliverable_type" not in locked:
        typed: dict[str, list[tuple[str, str]]] = {}
        for row in sorted(files, key=lambda item: str(item.get("file_id", ""))):
            event = {"name": row.get("name"), "mime": row.get("mime"), "path": row.get("path")}
            design = classify_design_type(event, rules)
            classification = design if design["classified"] else classify_creative_type(event, rules)
            if not classification["classified"]:
                continue
            family = "design_type_rules" if design["classified"] else "creative_types"
            source = classification.get("source") or "rule"
            rule_id = f"{rule_set_id}:{family}.{source}:{classification.get('rule')}"
            typed.setdefault(str(classification["type"]), []).append((rule_id, str(row.get("file_id") or "")))
        if len(typed) == 1:
            deliverable_type, evidence_rows = next(iter(typed.items()))
            candidates.append({
                "field": "deliverable_type", "value": deliverable_type,
                "ruleId": sorted({rule_id for rule_id, _ in evidence_rows})[0],
                "sampleFileIds": [file_id for _, file_id in evidence_rows if file_id][:5],
            })
    return candidates


def _rule_set_id(rules: FolderRuleSet) -> str:
    versions = ",".join(f"{document.doc_key}@{document.version}" for document in rules.documents)
    return f"folder_rules[{versions}]"


def _finish_sort(conn, org: uuid.UUID | str, dry_run: bool, result: dict[str, Any]) -> dict[str, Any]:
    """Persist a counts-only receipt for real runs; dry runs return their counts without changing state."""
    if not dry_run:
        conn.execute(
            """insert into pulse.onboarding_sort_receipt
                 (org_id, last_run_at, folders, matched_existing, proposals, skipped_reason)
               values (%s, clock_timestamp(), %s, %s, %s, %s)
               on conflict (org_id) do update set last_run_at=excluded.last_run_at, folders=excluded.folders,
                 matched_existing=excluded.matched_existing, proposals=excluded.proposals,
                 skipped_reason=excluded.skipped_reason""",
            (org, result.get("folders", 0), result.get("matched_existing", 0),
             result.get("proposals", 0), result.get("skipped")),
        )
    return result


def sort_org(conn, org: uuid.UUID | str, dry_run: bool = False) -> dict[str, Any]:
    """Create one pending review item per unmatched project folder; never mutate project or client tables."""
    locked = conn.execute(
        "select pg_try_advisory_xact_lock(hashtext(%s)) locked", (f"onboard_project_new:{org}",)
    ).fetchone()["locked"]
    if not locked:
        result = {"org": str(org), "step": "sort", "dryRun": dry_run, "skipped": "already_running"}
        return _finish_sort(conn, org, dry_run, result)

    try:
        rules = load(conn, org)
    except FolderRulesError as exc:
        errors = exc.summary.get("errors", [])
        missing = any("no active folder_rules" in error for error in errors)
        reason = "no_folder_rules" if missing else "invalid_folder_rules"
        result = {"org": str(org), "step": "sort", "dryRun": dry_run, "skipped": reason}
        return _finish_sort(conn, org, dry_run, result)

    files = conn.execute("select file_id,path from pulse.index_file order by path,file_id").fetchall()
    if not files:
        result = {"org": str(org), "step": "sort", "dryRun": dry_run, "skipped": "no_index_files"}
        return _finish_sort(conn, org, dry_run, result)

    excluded: set[str] = set()
    groups = group_indexed_files(files, rules.project_paths, _rule_set_id(rules), rules.protected_paths, excluded)
    projects = conn.execute(
        """select p.name,p.title,p.project_key,p.storage_root,c.display_name client_name
           from pulse.project p left join pulse.client c on c.id=p.client_id where p.org_id=%s""", (org,)
    ).fetchall()
    unmatched = [group for group in groups if not has_matching_project(group, projects)]
    result: dict[str, Any] = {
        "org": str(org), "step": "sort", "dryRun": dry_run,
        "folders": len(groups), "proposals": 0, "excluded": len(excluded),
        "matched_existing": len(groups) - len(unmatched),
        "created": 0, "pending": 0, "dismissed": 0, "accepted": 0, "auto_accepted": 0,
    }
    source_keys: list[str] = []
    for group in unmatched:
        source_path = group.folder_path
        source_key = "onboard_project_new:" + hashlib.sha256(source_path.encode("utf-8")).hexdigest()
        source_keys.append(source_key)
        if dry_run:
            prior = conn.execute(
                "select status from pulse.review_item where org_id=%s and source_key=%s", (org, source_key)
            ).fetchone()
            if prior is None or prior["status"] == "pending":
                result["proposals"] += 1
                result["pending"] += 1
            elif prior["status"] == "dismissed":
                result["dismissed"] += 1
            else:
                result["accepted"] += 1
            continue
        evidence = {
            "ruleId": group.rule_id,
            "folderPath": group.folder_path,
            "sampleFileIds": group.sample_file_ids[:5],
        }
        client_key = "drive-path-client:" + source_norm(group.client_name) if group.client_name else None
        proposal = {
            "projectId": str(entity_id(org, "project", "index_path", group.folder_path)),
            "storageRoot": "index-path:" + group.folder_path,
            "clientKey": client_key,
            "clientId": str(entity_id(org, "client", "drive_folder_name", client_key)) if client_key else None,
            "projectName": group.project_name,
            "clientName": group.client_name,
        }
        row = conn.execute(
            """insert into pulse.review_item(org_id,source_key,kind,entity_type,title,proposed,confidence,evidence)
               values(%s,%s,'onboard_project_new',null,%s,%s,0.95,%s)
               on conflict(org_id,source_key) do update set title=excluded.title,proposed=excluded.proposed,
                 confidence=excluded.confidence,evidence=excluded.evidence where review_item.status='pending'
               returning (xmax=0) inserted""",
            (
                org, source_key, f"New project from Drive · {group.project_name}",
                Jsonb(proposal), Jsonb(evidence),
            ),
        ).fetchone()
        if row:
            result["proposals"] += 1
            result["pending"] += 1
            result["created"] += int(row["inserted"])
        else:
            prior = conn.execute(
                "select status from pulse.review_item where org_id=%s and source_key=%s", (org, source_key)
            ).fetchone()
            result["dismissed" if prior["status"] == "dismissed" else "accepted"] += 1
    if dry_run:
        return result

    if source_keys:
        has_rule = conn.execute(
            "select exists(select 1 from pulse.review_rule "
            "where org_id=%s and kind='onboard_project_new' and enabled) enabled",
            (org,),
        ).fetchone()["enabled"]
        if has_rule and result["pending"]:
            conn.execute("select pulse.review_apply_rules()")
        statuses = conn.execute(
            "select status,count(*) n,count(*) filter(where status='accepted' and decided_by is null) auto_accepted "
            "from pulse.review_item where org_id=%s and kind='onboard_project_new' "
            "and source_key=any(%s) group by status",
            (org, source_keys),
        ).fetchall()
        result["pending"] = sum(row["n"] for row in statuses if row["status"] == "pending")
        result["dismissed"] = sum(row["n"] for row in statuses if row["status"] == "dismissed")
        result["accepted"] = sum(row["n"] for row in statuses if row["status"] == "accepted")
        result["auto_accepted"] = sum(row["auto_accepted"] for row in statuses)
    return _finish_sort(conn, org, dry_run, result)


def fill_org(conn, org: uuid.UUID | str, dry_run: bool = False) -> dict[str, Any]:
    """Create idempotent Review proposals for missing project client, pod and primary deliverable type."""
    locked = conn.execute(
        "select pg_try_advisory_xact_lock(hashtext(%s)) locked", (f"onboard_project_fill:{org}",)
    ).fetchone()["locked"]
    if not locked:
        return {"org": str(org), "step": "fill", "dryRun": dry_run, "skipped": "already_running"}
    try:
        rules = load(conn, org)
    except FolderRulesError as exc:
        missing = any("no active folder_rules" in error for error in exc.summary.get("errors", []))
        return {"org": str(org), "step": "fill", "dryRun": dry_run,
                "skipped": "no_folder_rules" if missing else "invalid_folder_rules"}

    files = conn.execute(
        "select file_id,name,mime,path,project_id from pulse.index_file order by path,file_id"
    ).fetchall()
    excluded: set[str] = set()
    groups = group_indexed_files(
        files, rules.project_paths, _rule_set_id(rules), rules.protected_paths, excluded
    )
    projects = conn.execute(
        """select p.id::text id,p.name,p.title,p.project_key,p.storage_root,p.client_id::text client_id,
                  p.unit_id::text unit_id,p.deliverable_type,p.locked,c.display_name client_name
           from pulse.project p left join pulse.client c on c.id=p.client_id where p.org_id=%s order by p.id""",
        (org,),
    ).fetchall()
    result: dict[str, Any] = {
        "org": str(org), "step": "fill", "dryRun": dry_run, "projects": 0,
        "proposals": 0, "client": 0, "pod": 0, "deliverableType": 0,
        "created": 0, "pending": 0, "dismissed": 0, "accepted": 0, "autoAccepted": 0,
    }
    source_keys: list[str] = []
    # Match each file to its project root once, not once per group.
    files_by_root: dict[str, list[dict[str, Any]]] = {}
    for row in files:
        path = str(row.get("path") or "")
        if is_protected(path.rsplit("/", 1)[0], rules.protected_paths):
            continue
        if matched := project_root(path, rules.project_paths):
            files_by_root.setdefault(matched.root, []).append(row)
    for group in groups:
        project_files = files_by_root.get(group.folder_path, [])
        project = matching_project(group, projects, project_files)
        if project is None:
            continue
        result["projects"] += 1
        for candidate in fill_candidates(group, project_files, project, rules.body, _rule_set_id(rules)):
            field_name = candidate["field"]
            if field_name == "pod":
                kind = "project_pod"
                proposed = {"pod": candidate["value"]}
            else:
                kind = "onboard_project_fill"
                if field_name == "client":
                    client_id = entity_id(org, "client", "drive_folder_name", candidate["clientKey"])
                    proposed = {"field": field_name, "clientKey": candidate["clientKey"],
                                "clientId": str(client_id), "clientName": candidate["value"]}
                else:
                    proposed = {"field": field_name, "deliverableType": candidate["value"]}
            source_key = f"onboard_project_fill:{field_name}:{project['id']}"
            source_keys.append(source_key)
            evidence = {"ruleId": candidate["ruleId"],
                        "sampleFileIds": candidate.get("sampleFileIds", group.sample_file_ids)[:5]}
            prior = conn.execute(
                "select status from pulse.review_item where org_id=%s and source_key=%s", (org, source_key)
            ).fetchone()
            if dry_run:
                if prior is None or prior["status"] == "pending":
                    result["proposals"] += 1
                    result["pending"] += 1
                    result[field_name if field_name != "deliverable_type" else "deliverableType"] += 1
                else:
                    result["dismissed" if prior["status"] == "dismissed" else "accepted"] += 1
                continue
            row = conn.execute(
                """insert into pulse.review_item(
                     org_id,source_key,kind,entity_type,entity_id,title,proposed,confidence,evidence)
                   values(%s,%s,%s,'project',%s,%s,%s,0.95,%s)
                   on conflict(org_id,source_key) do update set title=excluded.title,proposed=excluded.proposed,
                     confidence=excluded.confidence,evidence=excluded.evidence where review_item.status='pending'
                   returning (xmax=0) inserted""",
                (org, source_key, kind, project["id"],
                 f"Fill project {field_name.replace('_', ' ')} · {project.get('title') or project.get('name')}",
                 Jsonb(proposed), Jsonb(evidence)),
            ).fetchone()
            if row:
                result["proposals"] += 1
                result["pending"] += 1
                result[field_name if field_name != "deliverable_type" else "deliverableType"] += 1
                result["created"] += int(row["inserted"])
            elif prior and prior["status"] == "dismissed":
                result["dismissed"] += 1
            else:
                result["accepted"] += 1

    if dry_run:
        return result
    if source_keys:
        has_rule = conn.execute(
            """select exists(select 1 from pulse.review_rule where org_id=%s
               and kind in ('project_pod','onboard_project_fill') and enabled) enabled""",
            (org,),
        ).fetchone()["enabled"]
        if has_rule and result["pending"]:
            conn.execute("select pulse.review_apply_rules()")
        statuses = conn.execute(
            """select status,count(*) n,count(*) filter(where status='accepted' and decided_by is null) auto_accepted
               from pulse.review_item where org_id=%s and source_key=any(%s) group by status""",
            (org, source_keys),
        ).fetchall()
        result["pending"] = sum(row["n"] for row in statuses if row["status"] == "pending")
        result["dismissed"] = sum(row["n"] for row in statuses if row["status"] == "dismissed")
        result["accepted"] = sum(row["n"] for row in statuses if row["status"] == "accepted")
        result["autoAccepted"] = sum(row["auto_accepted"] for row in statuses)
    return result


def _cli(args: argparse.Namespace) -> int:
    with connect("worker") as conn:
        conn.autocommit = True
        active_org_list = active_orgs(conn)
        selected = active_org_list if args.all else [uuid.UUID(args.org)]
        active = {str(org) for org in active_org_list}
        results = []
        for org in selected:
            if str(org) not in active:
                results.append({"org": str(org), "step": args.step, "dryRun": args.dry_run, "skipped": "inactive_org"})
                continue
            with tenant_tx(conn, org):
                runner = sort_org if args.step == "sort" else fill_org
                results.append(runner(conn, org, args.dry_run))
    for result in results:
        print(json.dumps(result, sort_keys=True))
    return 0


def add_parser(subparsers) -> None:
    onboard = subparsers.add_parser("onboard", help="propose projects from indexed Drive folders")
    target = onboard.add_mutually_exclusive_group(required=True)
    target.add_argument("--org", help="one active organisation UUID")
    target.add_argument("--all", action="store_true", help="every active organisation")
    onboard.add_argument("--step", choices=("sort", "fill"), default="sort")
    onboard.add_argument("--dry-run", action="store_true")
    onboard.set_defaults(handler=_cli)
