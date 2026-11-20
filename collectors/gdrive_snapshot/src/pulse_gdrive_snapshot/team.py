"""EA tenant configuration and directory, from Workspace metadata and the owner roster."""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb
from pulse_rules.folder_rules import load as load_folder_rules
from pulse_rules.folder_rules import project_root as shared_project_root

from pulse_sdk.db import tenant_tx
from pulse_sdk.ids import entity_id
from pulse_sdk.paths import repo_root

from .records import merge_person, seed_records
from .roster import seed_roster

EA_ORG = uuid.uuid5(uuid.NAMESPACE_DNS, "estateautopilots.com")


def project_path(path: str, rules) -> str | None:
    # Root discovery scans indexed rows. A project folder must have a child path; stored roots can still
    # be matched directly by folder_names.project_path_match when seed_records refreshes them.
    matched = shared_project_root(path, rules)
    return matched.root if matched else None


def _account_map() -> list[dict] | None:
    path = os.environ.get("PULSE_EA_ACCOUNT_MAP_FILE")
    if not path:
        return None
    source = Path(path)
    repo = repo_root().resolve()
    if not source.is_absolute() or source.resolve().is_relative_to(repo):
        raise ValueError("PULSE_EA_ACCOUNT_MAP_FILE must point outside the repository")
    body = json.loads(source.read_text())
    if not isinstance(body, dict) or set(body) != {"accounts"} or not isinstance(body["accounts"], list):
        raise ValueError("EA account map must contain only an accounts array")
    rows, seen = [], set()
    for item in body["accounts"]:
        if not isinstance(item, dict) or set(item) != {"provider", "handle", "person_id", "is_shared"}:
            raise ValueError("EA account map entries must have provider, handle, person_id, and is_shared")
        provider = item["provider"]
        handle = item["handle"]
        shared = item["is_shared"]
        if not isinstance(provider, str) or not provider or not isinstance(handle, str) or not handle:
            raise ValueError("EA account map contains an invalid account entry")
        if not isinstance(shared, bool) or (shared and item["person_id"] is not None):
            raise ValueError("Shared accounts cannot have a person mapping")
        person = None
        if not shared:
            try:
                person = uuid.UUID(item["person_id"])
            except (ValueError, TypeError, AttributeError) as exc:
                raise ValueError("Personal account entries require a person UUID") from exc
        key = (provider.lower(), handle.strip().lower())
        if key in seen:
            raise ValueError("EA account map contains duplicate accounts")
        seen.add(key)
        rows.append({"provider": key[0], "handle": key[1], "person_id": person, "is_shared": shared})
    return rows


def _seed_account_map(conn, org: uuid.UUID, accounts: list[dict]) -> int:
    managed_keys = [f"{row['provider']}:{row['handle']}" for row in accounts
                    if not row["is_shared"] and row["person_id"]]
    account_keys = [f"{row['provider']}:{row['handle']}" for row in accounts]
    stale_sql = """select entity_id,source_key,evidence from pulse.identity_link where org_id=%s
                    and entity_type='account' and source='tenant_account_map' and valid_to is null"""
    stale_params: tuple = (org,)
    if account_keys:
        stale_sql += " and source_key <> all(%s)"
        stale_params = (org, account_keys)
    for stale in conn.execute(stale_sql, stale_params).fetchall():
        base = (stale["evidence"] or {}).get("base", {})
        holder = uuid.UUID(base["holder_person_id"]) if base.get("holder_person_id") else None
        conn.execute("""update pulse.account set holder_person_id=%s,is_shared=%s,purpose=%s
                        where org_id=%s and id=%s""",
                     (holder, bool(base.get("is_shared", False)), base.get("purpose"), org, stale["entity_id"]))
        conn.execute("""update pulse.identity_link set valid_to=now() where org_id=%s and entity_type='account'
                        and source='tenant_account_map' and source_key=%s and valid_to is null""",
                     (org, stale["source_key"]))
    if managed_keys:
        conn.execute("""update pulse.identity_link set valid_to=now() where org_id=%s and entity_type='person'
                        and source='account' and valid_to is null and evidence->>'managed_by'='tenant-account-map'
                        and source_key <> all(%s)""", (org, managed_keys))
    else:
        conn.execute("""update pulse.identity_link set valid_to=now() where org_id=%s and entity_type='person'
                        and source='account' and valid_to is null and evidence->>'managed_by'='tenant-account-map'""",
                     (org,))
    for row in accounts:
        person = row["person_id"]
        known = conn.execute("select 1 from pulse.person where org_id=%s and id=%s", (org, person)).fetchone()
        if person and not known:
            raise ValueError("EA account map references an unknown person")
        key = f"{row['provider']}:{row['handle']}"
        marker = conn.execute("""select evidence from pulse.identity_link where org_id=%s and entity_type='account'
                                  and source='tenant_account_map' and source_key=%s and valid_to is null
                                  order by valid_from desc limit 1""", (org, key)).fetchone()
        if marker:
            base = (marker["evidence"] or {}).get("base", {})
        else:
            original = conn.execute("""select holder_person_id,is_shared,purpose from pulse.account
                                        where org_id=%s and provider=%s and handle=%s""",
                                    (org, row["provider"], row["handle"])).fetchone()
            base = {"holder_person_id": str(original["holder_person_id"]) if original and original["holder_person_id"]
                    else None, "is_shared": original["is_shared"] if original else False,
                    "purpose": original["purpose"] if original else None}
        account = conn.execute("""insert into pulse.account(org_id,provider,handle,holder_person_id,is_shared)
                        values (%s,%s,%s,%s,%s)
                        on conflict(org_id,provider,handle) do update set holder_person_id=excluded.holder_person_id,
                          is_shared=excluded.is_shared returning id""",
                     (org, row["provider"], row["handle"], person, row["is_shared"])).fetchone()
        account_id = account["id"]
        conn.execute("""insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,method,
                         confidence,valid_from,evidence)
                        values (%s,'account',%s,'tenant_account_map',%s,'manual',1.0,'-infinity',
                          %s)
                        on conflict(org_id,entity_type,source,source_key,valid_from) do update set
                          entity_id=excluded.entity_id,method='manual',confidence=1.0,valid_to=null,
                          evidence=excluded.evidence""",
                     (org, account_id, key, Jsonb({"managed_by": "tenant-account-map", "base": base})))
        if person:
            conn.execute("""insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,method,
                             confidence,valid_from,evidence)
                            values (%s,'person',%s,'account',%s,'manual',1.0,'-infinity',
                              '{\"managed_by\":\"tenant-account-map\"}'::jsonb)
                            on conflict(org_id,entity_type,source,source_key,valid_from) do update set
                              entity_id=excluded.entity_id,method='manual',confidence=1.0,valid_to=null,
                              evidence=excluded.evidence""",
                         (org, person, key))
    return len(accounts)


def load_config() -> dict:
    config = json.loads((repo_root() / "config/ea-team.json").read_text())
    # A protected runtime list can override the checked-in company rule when
    # deployment-specific account handling is needed.
    external_accounts = os.environ.get("PULSE_EA_SHARED_EXTERNAL_ACCOUNTS")
    if external_accounts and external_accounts.strip():
        config["shared_external_accounts"] = [handle.strip() for handle in external_accounts.split(",")]
    return config


def seed_role(accounts: list[str], primary: str, config: dict) -> str:
    """The role the directory seed gives a person, from the tenant config's ``role_grants``: admin when any of their
    accounts is listed under ``admin``, hr when their primary account is listed under ``hr``, else person. No address
    lives in code (ADR-0031 §3); after the seed, roles are granted in the app or with ``pulse-admin grant``."""
    grants = config.get("role_grants", {})
    admins = {a.lower() for a in grants.get("admin", ())}
    if any(a.lower() in admins for a in accounts):
        return "admin"
    return "hr" if primary.lower() in {a.lower() for a in grants.get("hr", ())} else "person"


def _shared_external_handles(config: dict, account_map: list[dict] | None = None) -> set[str]:
    configured = config.get("shared_external_accounts", [])
    if not isinstance(configured, list) or any(not isinstance(handle, str) for handle in configured):
        raise ValueError("shared_external_accounts must be an array of full handles")
    handles = set()
    for handle in configured:
        normalized = handle.strip().lower()
        if normalized.count("@") != 1 or not all(normalized.split("@")):
            raise ValueError("shared_external_accounts entries must be full handles")
        handles.add(normalized)
    # Shared non-Workspace accounts require an exact full handle from the protected
    # map. A local-part-only map entry cannot establish an uploader's identity.
    for row in account_map or []:
        if row["provider"] != "google" or not row["is_shared"]:
            continue
        normalized = row["handle"].strip().lower()
        if normalized.count("@") != 1 or not all(normalized.split("@")):
            raise ValueError("shared Google account-map entries must use full handles")
        handles.add(normalized)
    return handles


def _is_shared_handle(handle: str, *, workspace: bool, config: dict,
                      external_shared_handles: set[str]) -> bool:
    normalized = handle.strip().lower()
    if workspace:
        return normalized.split("@", 1)[0] in {part.lower() for part in config["shared_local_parts"]}
    return normalized in external_shared_handles


def _upsert_seeded_account(conn, org, handle: str, person_id, shared: bool, purpose: str) -> None:
    conn.execute("""insert into pulse.account(id,org_id,provider,handle,holder_person_id,is_shared,purpose)
                    values (%s,%s,'google',%s,%s,%s,%s) on conflict(org_id,provider,handle)
                    do update set purpose=excluded.purpose,is_shared=excluded.is_shared
                    where pulse.account.holder_person_id is null and not exists (
                      select 1 from pulse.identity_link il where il.org_id=pulse.account.org_id
                        and il.entity_type='account' and il.entity_id=pulse.account.id
                        and il.source='tenant_account_map' and il.valid_to is null
                    )""",
                 (entity_id(org, "account", "google", handle), org, handle, person_id, shared, purpose))


def load_design_type_rules() -> dict:
    body = json.loads((repo_root() / "config/ea-design-type-rules.json").read_text())
    if (not isinstance(body, dict) or set(body) - {"exclude", "folder_path"}
            or "folder_path" not in body or not isinstance(body["folder_path"], list)):
        raise ValueError("EA design rules must contain folder_path and optional exclude arrays")
    exclusions = body.get("exclude", [])
    if not isinstance(exclusions, list):
        raise ValueError("EA design exclusions must be an array")
    for pattern in exclusions:
        if not isinstance(pattern, str) or not pattern:
            raise ValueError("EA design exclusion pattern is invalid")
        re.compile(pattern)
    schema = json.loads((repo_root() / "packages/schemas/config/folder_rules.json").read_text())
    allowed = set(schema["properties"]["design_type_rules"]["properties"]["folder_path"]
                  ["items"]["properties"]["type"]["enum"])
    seen = set()
    for rule in body["folder_path"]:
        if not isinstance(rule, dict) or set(rule) != {"match", "type"}:
            raise ValueError("EA design folder rules must contain only match and type")
        if not isinstance(rule["match"], str) or rule["type"] not in allowed:
            raise ValueError("EA design folder rule is invalid")
        re.compile(rule["match"])
        seen.add(rule["type"])
    if seen != allowed:
        raise ValueError("EA design folder rules must cover all design types")
    return body


def _folder_rules_config(config: dict, current: dict | None = None) -> dict:
    body = dict(current or {})
    body["index_rules"] = config["delivery_rules"]
    body["design_type_rules"] = load_design_type_rules()
    body["project_paths"] = config.get("project_paths", body.get("project_paths", []))
    body["pods"] = config.get("pods", body.get("pods", {}))
    return body


def seed(index, conn, org=EA_ORG) -> dict:
    config = load_config()
    account_map = _account_map()
    external_shared_handles = _shared_external_handles(config, account_map)
    users = index.execute("select email,name,suspended from ws_user").fetchall()
    workspace_handles = {u["email"].strip().lower() for u in users}
    # Only metadata, and never the text index or Gmail bodies.
    from .backfill import FOLDER_MIME, FolderPaths, is_sensitive_path
    folders = FolderPaths(index.execute(
        "select id,name,parents,path from drive_file where mime=%s and not coalesce(trashed,false)",
        (FOLDER_MIME,),
    ).fetchall())
    candidate_paths = set()
    handles = set()
    for row in index.execute("select name,path,parents,owner,modified_by from drive_file "
                             "where not coalesce(trashed,false)").fetchall():
        resolved = folders.record_paths(row)
        if any(is_sensitive_path(p) for p in resolved):
            continue
        candidate_paths.add(resolved[0])
        handles.update(str(row[k]).strip().lower() for k in ("owner", "modified_by") if row[k])
    with tenant_tx(conn, org):
        conn.execute("insert into pulse.org(id,slug,name,code) values (%s,'ea','Estate Autopilots','EA') "
                     "on conflict(id) do nothing", (org,))
        conn.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
                     "values (%s,'tenant','ea-team',1,%s,true) on conflict(org_id,doc_kind,doc_key,version) "
                     "do update set body=excluded.body,is_active=true", (org, Jsonb(config)))
        folder_row = conn.execute("select version,body from pulse.tenant_config "
                                  "where org_id=%s and doc_kind='folder_rules' and doc_key='ea-deliveries-v0' "
                                  "order by version desc limit 1 for update", (org,)).fetchone()
        folder_version = folder_row["version"] if folder_row else 1
        folder_body = _folder_rules_config(config, folder_row["body"] if folder_row else None)
        conn.execute("update pulse.tenant_config set is_active=false where org_id=%s "
                     "and doc_kind='folder_rules' and doc_key='ea-deliveries-v0' and is_active", (org,))
        conn.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
                     "values (%s,'folder_rules','ea-deliveries-v0',%s,%s,true) "
                     "on conflict(org_id,doc_kind,doc_key,version) "
                     "do update set body=excluded.body,is_active=true",
                     (org, folder_version, Jsonb(folder_body)))
        folder_rules = load_folder_rules(conn, org)
        paths = {root for candidate in candidate_paths
                 if (root := project_path(candidate, folder_rules.project_paths))}
        pod_names = dict.fromkeys(folder_rules.pods.values())
        for name in pod_names:
            conn.execute("insert into pulse.unit(id,org_id,kind,name) values (%s,%s,'pod',%s) "
                         "on conflict(id) do nothing", (entity_id(org, "unit", name), org, name))
        personal = {}
        titles = {"admin": "Organisation admin", "hr": "HR", "person": "Team member"}
        # One human, several Workspace accounts: every account resolves to the person of the primary e-mail.
        same = {a.lower(): m for m in config.get("same_person", ()) for a in m["accounts"]}
        by_person: dict = {}
        for u in users:
            email = u["email"].lower()
            shared = _is_shared_handle(email, workspace=True, config=config,
                                       external_shared_handles=external_shared_handles)
            handles.add(email)
            if shared:
                continue
            merged = same.get(email)
            primary = merged["primary"].lower() if merged else email
            pid = entity_id(org, "person", "workspace", primary)
            personal[email] = pid
            entry = by_person.setdefault(pid, {"primary": primary, "accounts": [], "name": None, "suspended": True})
            entry["accounts"].append(email)
            entry["suspended"] = entry["suspended"] and bool(u["suspended"])
            if merged:
                entry["name"] = merged["name"]
            elif email == primary:
                entry["name"] = u["name"] or email
        for pid, entry in by_person.items():
            primary, accounts = entry["primary"], sorted(entry["accounts"], key=lambda a: (a != entry["primary"], a))
            role = seed_role(accounts, primary, config)
            name, status = entry["name"] or primary, "inactive" if entry["suspended"] else "active"
            conn.execute("insert into pulse.person(id,org_id,display_name,side,status) values (%s,%s,%s,'staff',%s) "
                         "on conflict(id) do nothing", (pid, org, name, status))
            conn.execute("insert into pulse.people_profile(org_id,person_id,role,pod,accounts,email,evidence) "
                         "values (%s,%s,%s,%s,%s,%s,'Google Workspace user directory; exact work email match.') "
                         "on conflict(person_id) do update set accounts=excluded.accounts,"
                         "role=case when 'role'=any(people_profile.locked) or people_profile.role not in "
                         "('admin','hr','person') then people_profile.role else excluded.role end,"
                         "email=case when 'email'=any(people_profile.locked) then people_profile.email "
                         "else excluded.email end",
                         (org, pid, titles[role],
                          folder_rules.pods.get("leadership" if role == "admin" else "shared"), accounts, primary))
            # The directory owns name and status until someone edits them in Pulse.
            conn.execute("update pulse.person p set display_name=%s where id=%s and not exists (select 1 from "
                         "pulse.people_profile pp where pp.person_id=p.id and 'name'=any(pp.locked))", (name, pid))
            conn.execute("update pulse.person p set status=%s where id=%s and not exists (select 1 from "
                         "pulse.people_profile pp where pp.person_id=p.id and 'status'=any(pp.locked))", (status, pid))
            conn.execute("insert into pulse.role_assignment(id,org_id,person_id,role_key,valid_from) "
                         "values (%s,%s,%s,%s,'2026-01-01') on conflict(id) do nothing",
                         (entity_id(org, "role", pid, role), org, pid, role))
            for alias in accounts:
                gone = entity_id(org, "person", "workspace", alias)
                if gone != pid and merge_person(conn, pid, gone):
                    conn.execute("update pulse.account set holder_person_id=%s where provider='google' and handle=%s "
                                 "and not is_shared", (pid, alias))
        for handle in sorted(handles):
            pid = personal.get(handle)
            workspace = handle in workspace_handles
            shared = _is_shared_handle(handle, workspace=workspace, config=config,
                                       external_shared_handles=external_shared_handles)
            purpose = ("Workspace shared login" if shared else "Workspace account") if workspace else (
                "Indexed shared login" if shared else "Uploader identity unverified")
            _upsert_seeded_account(conn, org, handle, pid, shared, purpose)
            if pid:
                conn.execute("insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,method) "
                             "values (%s,'person',%s,'account',%s,'exact') on conflict do nothing",
                             (org, pid, "google:" + handle))
        # A person's accounts are the links in pulse.account (Workspace matches and links made in the app).
        conn.execute("update pulse.people_profile pp set accounts=coalesce((select array_agg(a.handle order by "
                     "(a.handle=pp.email) desc,a.handle) from pulse.account a where a.holder_person_id=pp.person_id "
                     "and a.provider='google'),'{}')")
        existing = {r["name"]: r["registry_no"] for r in conn.execute("select name,registry_no from pulse.project")}
        next_no = max(existing.values(), default=0) + 1
        for path in sorted(paths):
            pid = entity_id(org, "project", "index_path", path)
            old = conn.execute("select id from pulse.project where id=%s", (pid,)).fetchone()
            if old:
                continue
            conn.execute("insert into pulse.project(id,org_id,registry_no,name,storage_root) "
                         "values (%s,%s,%s,%s,%s)", (pid, org, next_no, path.split("/")[-1], "index-path:" + path))
            next_no += 1
        records = seed_records(conn, org)
        mapped_accounts = _seed_account_map(conn, org, account_map) if account_map is not None else 0
        workspace = {
            pid: {
                "name": entry["name"] or entry["primary"],
                "accounts": sorted(entry["accounts"], key=lambda account: (account != entry["primary"], account)),
            }
            for pid, entry in by_person.items()
            if not entry["suspended"]
        }
        roster = seed_roster(index, conn, org, config, workspace, folder_rules)
    return {"people": len(by_person), "accounts": len(handles), "projects": len(paths),
            "mapped_accounts": mapped_accounts, **records, **roster}
