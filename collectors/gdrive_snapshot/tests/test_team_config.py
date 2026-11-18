from __future__ import annotations

import json
import re
import uuid
from contextlib import nullcontext
from pathlib import Path

import pytest

from pulse_gdrive_snapshot import folder_names, team
from pulse_gdrive_snapshot.team import (
    _account_map,
    _folder_rules_config,
    _is_shared_handle,
    _shared_external_handles,
    _upsert_seeded_account,
    load_config,
    load_design_type_rules,
    seed,
    seed_role,
)


def _previous_project_path(path: str) -> str | None:
    """Frozen project-root implementation from before tenant folder rules."""
    parts = [part.strip() for part in path.split("/") if part.strip()]
    for index, part in enumerate(parts[:-1]):
        if part.casefold() not in ("client video shoot", "#0 - client work video package"):
            continue
        month = index + 1
        if month < len(parts) and re.fullmatch(r"20\d{2}", parts[month]):
            month += 1
        if month >= len(parts) or "past data" in parts[month].casefold():
            return None
        root_end = month + 1
        return "/".join(parts[:root_end + 1]) if root_end < len(parts) - 1 else None
    return None


def test_project_root_rules_match_frozen_logic_for_folder_and_file_rows():
    rules = load_config()["project_paths"]
    month_folder = "Drive/Client Video Shoot/2024/7) July 2024"
    empty_project = month_folder + "/#1 - Empty Engagement"
    direct_file = month_folder + "/direct-file.mp4"
    rows = [
        ("folder", "Drive/Client Video Shoot/2024"),
        ("folder", month_folder),
        ("folder", empty_project),
        ("file", direct_file),
        ("folder", "Drive/Client Video Shoot/2024/7) July 2024/#2 - Synthetic Project"),
        ("folder", "Drive/Client Video Shoot/2024/7) July 2024/#2 - Synthetic Project/Deliverables"),
        ("file", "Drive/Client Video Shoot/2024/7) July 2024/#2 - Synthetic Project/Deliverables/final.mp4"),
        ("folder", "Drive/Client Video Shoot/2024/Past Data"),
        ("file", "Drive/Client Video Shoot/2024/Past Data/#3 - Archived Project/final.mp4"),
        ("file", "Drive/Client Video Shoot/2024/7) July 2024/"
                 "#4 - Synthetic Project | Mr Demo Kalah | Baner | Residential /final.mp4"),
    ]

    old_roots = {root for _, path in rows if (root := _previous_project_path(path))}
    new_roots = {root for _, path in rows if (root := team.project_path(path, rules))}

    assert any(kind == "folder" for kind, _ in rows)
    assert folder_names.project_path_match(month_folder, rules) is None
    assert team.project_path(empty_project, rules) is None
    assert team.project_path(direct_file, rules) is None
    assert new_roots == old_roots
    expected = "Drive/Client Video Shoot/2024/7) July 2024/"
    expected += "#4 - Synthetic Project | Mr Demo Kalah | Baner | Residential"
    assert expected in new_roots


def test_project_path_month_capture_strips_serial_and_contact_name_is_not_month():
    rules = load_config()["project_paths"]
    legacy = folder_names.project_path_match(
        "Drive/#0 - Client Work Video Package/3) June 2023/#2 - Synthetic Legacy/file.mp4", rules
    )
    yearless = folder_names.project_path_match(
        "Drive/Client Video Shoot/3) June 2023/#3 - Synthetic Yearless/file.mp4", rules
    )
    parsed = folder_names.parse("#2 - Demo Project | Mr Demo Kalah | Baner | Residential", 2024, 7)

    assert legacy is not None and legacy.year_month == (2023, 6)
    assert yearless is not None and yearless.year_month == (2023, 6)
    assert folder_names.engagement(legacy.root, rules) is not None
    assert folder_names.parse_month("Kalah", 2024) is None
    assert parsed["project"] == "Demo Project"
    assert parsed["contact"] == "Mr Demo Kalah"
    assert parsed["location"] == "Baner"
    assert parsed["ym"] == (2024, 7)


def test_ea_design_seed_matches_generic_drive_folder_labels():
    design_rules = load_design_type_rules()
    assert design_rules["exclude"] == ["client", "references?", "refs?", "from builder", "input", "raw"]
    rules = design_rules["folder_path"]
    expected = {
        "Single Image Ads": "single_image_ad",
        "S. Img Ads": "single_image_ad",
        "Image Creatives": "single_image_ad",
        "Carousel Image Ads": "carousel",
        "C. Img creative": "carousel",
        "Brochures": "brochure",
        "Logo": "logo",
        "Sales Pitch deck": "pitch_deck",
    }
    for folder, design_type in expected.items():
        assert any(rule["type"] == design_type and re.fullmatch(rule["match"], folder, re.I) for rule in rules)


def test_tenant_folder_rules_seed_preserves_delivery_rules_and_adds_design_rules():
    delivery_rules = [{"match": "synthetic final folder", "kind": "final"}]
    project_paths = [{"match": r"(?P<project>[^/]+)"}]
    pods = {"studio": "Studio"}

    body = _folder_rules_config({"delivery_rules": delivery_rules, "project_paths": project_paths, "pods": pods})

    assert body["index_rules"] == delivery_rules
    assert body["design_type_rules"] == load_design_type_rules()
    assert body["project_paths"] == project_paths
    assert body["pods"] == pods


def test_design_type_rules_use_the_shared_schema_enum():
    schema = json.loads((team.repo_root() / "packages/schemas/config/folder_rules.json").read_text())
    allowed = set(schema["properties"]["design_type_rules"]["properties"]["folder_path"]
                  ["items"]["properties"]["type"]["enum"])
    configured = {rule["type"] for rule in load_design_type_rules()["folder_path"]}
    assert configured <= allowed


def test_tenant_folder_rules_merge_into_the_latest_version_without_dropping_editor_rules():
    config = {"delivery_rules": [{"match": "synthetic final folder", "kind": "final"}]}
    current = {
        "creative_type_rules": {"folder_path": [{"match": "synthetic videos", "type": "vov"}]},
        "file_name": {"legacy_type_hints": {"synthetic": "VV"}},
        "index_rules": [{"match": "old final folder", "kind": "final"}],
    }

    body = _folder_rules_config(config, current)

    assert body["creative_type_rules"] == current["creative_type_rules"]
    assert body["file_name"] == current["file_name"]
    assert body["index_rules"] == config["delivery_rules"]
    assert body["design_type_rules"] == load_design_type_rules()


def test_workspace_and_external_shared_login_detection_uses_separate_evidence():
    config = {
        "shared_local_parts": ["marketing", "sales"],
        "shared_external_accounts": ["ea-shared@gmail.example", "sales@estateautopilots.example"],
    }
    external_shared = _shared_external_handles(config)

    assert _is_shared_handle("marketing@client.example", workspace=False, config=config,
                             external_shared_handles=external_shared) is False
    assert _is_shared_handle("marketing@ea.example", workspace=True, config=config,
                             external_shared_handles=external_shared)
    assert _is_shared_handle("sales@estateautopilots.com", workspace=True, config=config,
                             external_shared_handles=external_shared)
    assert _is_shared_handle("marketing@workspace.example", workspace=True, config=config,
                             external_shared_handles=external_shared)
    assert _is_shared_handle("ea-shared@gmail.example", workspace=False, config=config,
                             external_shared_handles=external_shared)
    assert _is_shared_handle("sales@estateautopilots.example", workspace=False, config=config,
                             external_shared_handles=external_shared)


def test_external_account_map_shared_rows_are_exact_allowlist_entries():
    config = {"shared_local_parts": ["marketing"], "shared_external_accounts": []}
    account_map = [{"provider": "google", "handle": "shared-login@gmail.example",
                    "person_id": None, "is_shared": True}]
    external_shared = _shared_external_handles(config, account_map)

    assert _is_shared_handle("shared-login@gmail.example", workspace=False, config=config,
                             external_shared_handles=external_shared)
    assert not _is_shared_handle("marketing@client.example", workspace=False, config=config,
                                 external_shared_handles=external_shared)


def test_shared_account_map_rejects_localpart_only_entries():
    config = {"shared_external_accounts": []}
    account_map = [{"provider": "google", "handle": "synthetic-shared", "is_shared": True}]

    with pytest.raises(ValueError, match="full handles"):
        _shared_external_handles(config, account_map)


def test_seed_roles_come_from_tenant_config_role_grants():
    config = {"role_grants": {"admin": ["Boss@Synthetic.test", "ops@synthetic.test"], "hr": ["people@synthetic.test"]}}
    assert seed_role(["boss@synthetic.test"], "boss@synthetic.test", config) == "admin"
    assert seed_role(["asha@synthetic.test", "ops@synthetic.test"], "asha@synthetic.test", config) == "admin"
    assert seed_role(["people@synthetic.test"], "people@synthetic.test", config) == "hr"
    assert seed_role(["asha@synthetic.test", "people@synthetic.test"], "asha@synthetic.test", config) == "person"
    assert seed_role(["boss@synthetic.test"], "boss@synthetic.test", {}) == "person"   # no grants: nobody is special


def test_real_config_role_grants_are_full_handles_and_no_address_is_in_code():
    grants = load_config()["role_grants"]
    assert set(grants) == {"admin", "hr"} and len(grants["admin"]) == 2 and len(grants["hr"]) == 1
    assert all(h == h.strip().lower() and h.count("@") == 1 and all(h.split("@")) for v in grants.values() for h in v)
    source = (Path(team.__file__)).read_text()
    assert not any(h in source for v in grants.values() for h in v)


def test_real_config_uses_only_explicit_full_handle_allowlist(monkeypatch):
    monkeypatch.delenv("PULSE_EA_SHARED_EXTERNAL_ACCOUNTS", raising=False)
    config = load_config()
    external_shared = _shared_external_handles(config)

    configured = {handle.strip().lower() for handle in config["shared_external_accounts"]}
    assert external_shared == configured
    assert all(handle.count("@") == 1 and all(handle.split("@")) for handle in external_shared)
    assert not _is_shared_handle("marketing@unlisted.example", workspace=False, config=config,
                                 external_shared_handles=external_shared)
    assert _is_shared_handle("marketing@estateautopilots.com", workspace=True, config=config,
                             external_shared_handles=external_shared)


def test_protected_runtime_allowlist_overrides_checked_in_allowlist(monkeypatch):
    monkeypatch.setenv("PULSE_EA_SHARED_EXTERNAL_ACCOUNTS", "runtime-fixture@example.test")
    external_shared = _shared_external_handles(load_config())

    assert len(external_shared) == 1
    assert next(iter(external_shared)) == "runtime-fixture@example.test"


class SeedAccountStore:
    def __init__(self, accounts, identity_links=()):
        self.accounts = accounts
        self.identity_links = list(identity_links)
        self.sql = None

    def execute(self, sql, params):
        self.sql = sql
        assert "not exists" in sql
        assert "il.source='tenant_account_map'" in sql
        assert "il.valid_to is null" in sql
        assert "il.entity_id=pulse.account.id" in sql
        account_id, org_id, handle, holder_person_id, is_shared, purpose = params
        key = (org_id, "google", handle)
        account = self.accounts.get(key)
        if account is None:
            self.accounts[key] = {
                "id": account_id,
                "holder_person_id": holder_person_id,
                "is_shared": is_shared,
                "purpose": purpose,
            }
            return

        has_active_map_marker = any(
            link["org_id"] == org_id
            and link["entity_type"] == "account"
            and link["entity_id"] == account["id"]
            and link["source"] == "tenant_account_map"
            and link["valid_to"] is None
            for link in self.identity_links
        )
        if account["holder_person_id"] is None and not has_active_map_marker:
            account.update(is_shared=is_shared, purpose=purpose)


def test_reseed_preserves_active_shared_account_marker_and_reclassifies_unmarked_client_account():
    org_id = uuid.uuid4()
    shared_handle = "synthetic-shared@gmail.test"
    client_handle = "marketing@client.example"
    shared_id = "synthetic-shared-account"
    accounts = {
        (org_id, "google", shared_handle): {
            "id": shared_id,
            "holder_person_id": None,
            "is_shared": True,
            "purpose": "Indexed shared login",
        },
        (org_id, "google", client_handle): {
            "id": "synthetic-client-account",
            "holder_person_id": None,
            "is_shared": True,
            "purpose": "Indexed shared login",
        },
    }
    store = SeedAccountStore(accounts, [{
        "org_id": org_id,
        "entity_type": "account",
        "entity_id": shared_id,
        "source": "tenant_account_map",
        "valid_to": None,
    }])

    _upsert_seeded_account(store, org_id, shared_handle, None, False,
                           "Uploader identity unverified")
    _upsert_seeded_account(store, org_id, client_handle, None, False,
                           "Uploader identity unverified")

    assert accounts[(org_id, "google", shared_handle)]["is_shared"] is True
    assert accounts[(org_id, "google", shared_handle)]["purpose"] == "Indexed shared login"
    assert accounts[(org_id, "google", client_handle)]["is_shared"] is False
    assert accounts[(org_id, "google", client_handle)]["purpose"] == "Uploader identity unverified"


class SeedResult:
    def __init__(self, rows=None, row=None):
        self.rows = rows or []
        self.row = row

    def __iter__(self):
        return iter(self.rows)

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.row


class SeedIndex:
    def __init__(self):
        self.statements = []

    def execute(self, sql, _params=None):
        self.statements.append(sql)
        if "from ws_user" in sql:
            return type("Rows", (), {"fetchall": lambda self: [
                {"email": "marketing@example.test", "name": "Synthetic User", "suspended": False}
            ]})()
        return SeedResult()


class SeedConnection:
    def __init__(self, handle):
        self.people = []
        self.folder_rules = []
        self.accounts = {handle: {
            "holder_person_id": None,
            "is_shared": True,
            "purpose": "Workspace shared login",
        }}

    def execute(self, sql, params=()):
        if sql.startswith("select version,body from pulse.tenant_config"):
            return SeedResult()
        if "insert into pulse.tenant_config" in sql and "'folder_rules'" in sql:
            body = params[-1].obj if hasattr(params[-1], "obj") else params[-1]
            self.folder_rules = [{"doc_key": "ea-deliveries-v0", "version": params[-2], "body": body}]
        elif "from pulse.tenant_config" in sql and "doc_kind = 'folder_rules'" in sql:
            return SeedResult(rows=self.folder_rules)
        elif "insert into pulse.person(" in sql:
            self.people.append(params[2])
        elif "insert into pulse.account(" in sql:
            _account_id, _org, handle, _holder, is_shared, purpose = params
            self.accounts[handle].update(is_shared=is_shared, purpose=purpose)
        return SeedResult()


def test_reseed_keeps_workspace_shared_localpart_unassigned(monkeypatch):
    config = {
        "shared_local_parts": ["marketing"],
        "shared_external_accounts": [],
        "delivery_rules": [],
        "team": [],
        "name_aliases": {},
        "confirm_same_person": [],
    }
    monkeypatch.setattr(team, "load_config", lambda: config)
    monkeypatch.setattr(team, "_account_map", lambda: None)
    monkeypatch.setattr(team, "tenant_tx", lambda _conn, _org: nullcontext())
    monkeypatch.setattr(team, "seed_records", lambda _conn, _org: {})
    monkeypatch.setattr(team, "seed_roster", lambda *_args: {})
    conn = SeedConnection("marketing@example.test")

    index = SeedIndex()
    result = seed(index, conn)

    assert result["people"] == 0
    assert conn.people == []
    assert all("drive_text" not in sql for sql in index.statements)
    account = conn.accounts["marketing@example.test"]
    assert account["is_shared"] is True
    assert account["holder_person_id"] is None


def test_checked_in_external_accounts_seed_shared_and_unlisted_consumer_stays_unverified(monkeypatch):
    monkeypatch.delenv("PULSE_EA_SHARED_EXTERNAL_ACCOUNTS", raising=False)
    config = load_config()
    shared_handles = set(config["shared_external_accounts"])
    assert len(shared_handles) == 2
    monkeypatch.setattr(team, "load_config", lambda: config)
    monkeypatch.setattr(team, "_account_map", lambda: None)
    monkeypatch.setattr(team, "tenant_tx", lambda _conn, _org: nullcontext())
    monkeypatch.setattr(team, "seed_records", lambda _conn, _org: {})
    monkeypatch.setattr(team, "seed_roster", lambda *_args: {})
    unlisted = "unlisted.consumer@gmail.test"
    conn = SeedConnection(next(iter(shared_handles)))
    for handle in [*shared_handles, unlisted]:
        conn.accounts[handle] = {"holder_person_id": None, "is_shared": False, "purpose": "unverified"}

    class Index:
        def execute(self, sql, _params=None):
            if "from ws_user" in sql or "where mime=%s" in sql:
                rows = []
            else:
                rows = [{"name": "synthetic.png", "path": None, "parents": [], "owner": handle,
                         "modified_by": handle} for handle in [*shared_handles, unlisted]]
            return type("Rows", (), {"fetchall": lambda _self: rows})()

    seed(Index(), conn)

    assert all(conn.accounts[handle]["is_shared"] for handle in shared_handles)
    assert conn.accounts[unlisted]["is_shared"] is False
    assert conn.accounts[unlisted]["purpose"] == "Uploader identity unverified"


def test_external_account_map_accepts_synthetic_personal_and_shared_accounts(tmp_path, monkeypatch):
    config = tmp_path / "ea-account-map.json"
    config.write_text(json.dumps({"accounts": [
        {"provider": "Google", "handle": "synthetic-editor@example.test",
         "person_id": "00000000-0000-0000-0000-000000000001", "is_shared": False},
        {"provider": "google", "handle": "synthetic-shared@example.test", "person_id": None, "is_shared": True},
    ]}))
    monkeypatch.setenv("PULSE_EA_ACCOUNT_MAP_FILE", str(config))

    mapping = _account_map()

    assert mapping == [
        {"provider": "google", "handle": "synthetic-editor@example.test",
         "person_id": uuid.UUID("00000000-0000-0000-0000-000000000001"), "is_shared": False},
        {"provider": "google", "handle": "synthetic-shared@example.test", "person_id": None, "is_shared": True},
    ]


def test_external_account_map_rejects_duplicate_accounts(tmp_path, monkeypatch):
    config = tmp_path / "ea-account-map.json"
    account = {"provider": "google", "handle": "synthetic@example.test", "person_id": None, "is_shared": True}
    config.write_text(json.dumps({"accounts": [account, account]}))
    monkeypatch.setenv("PULSE_EA_ACCOUNT_MAP_FILE", str(config))

    try:
        _account_map()
    except ValueError as exc:
        assert str(exc) == "EA account map contains duplicate accounts"
    else:
        raise AssertionError("duplicate account entries should fail closed")
